'use client';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  candidateSavedReferenceKey,
  type IngestionCandidateSavedReferences,
  type IngestionCandidateSavedViewSpec,
  type IngestionCandidateReference,
  type IngestionCandidateAssetPage,
  type IngestionCandidateRecordPage,
  type IngestionCandidateGeometryPage,
} from '@wiser/data-contracts';
import { getDictionary, type Locale } from '@/lib/i18n';
import {
  CandidateReaderError,
  candidateMapFeatures,
  candidateOriginalUrl,
  readCandidatePage,
  readCandidateConversionProvenance,
  readCandidateSavedView,
  readCandidateTopic,
  type CandidateTopicPages,
  type CandidatePages,
  type CandidateReadAction,
  type CandidateSavedPages,
} from '@/lib/ingestion-candidate-reader';
import { CANDIDATE_MONTHLY_RULE_VERSION_V3 } from '@wiser/data-core/candidate-monthly-projection';
import {
  readCandidateMonthlySemantics,
  type CandidateMonthlySemanticRead,
} from '@/lib/candidate-monthly-semantic-reader';
import { CandidateMonthlyPanel } from './candidate-monthly-panel';
import { CandidateRelationPanel } from './candidate-relation-panel';
import {
  readCandidateRelation,
  type CandidateRelationPages,
} from '@/lib/candidate-relation-reader';
import {
  CandidateFollowupPanel,
  type CandidateSupplementLookup,
} from './candidate-followup-panel';
import { ContextHelp } from './context-help';
import {
  DataFoundationMap,
  type DataFoundationMapReadingHandle,
} from './data-foundation-map';
import type { PublicReferenceInput } from '@/lib/spatial-public-reference.server';
import { supportedReadingCamera, type MapCamera } from '@/lib/amap-camera';
import { IngestionCandidateRasterPanel } from './ingestion-candidate-raster-panel';
import {
  CandidateMapComparison,
  type CandidateMapComparisonHandle,
  type CandidateComparisonSelection,
} from './candidate-map-comparison';
import type { CandidateComparisonPosition } from '@/lib/candidate-map-comparison';
import styles from './ingestion-candidate-reader.module.css';

type OpenedReading =
  | CandidateSavedPages['open']
  | Exclude<CandidateTopicPages['open'], { status: 'UNAVAILABLE' }>;
type CandidateRelationSnapshot = CandidateRelationPages['get']['relation'];
type CandidateRelationEvidence =
  CandidateRelationSnapshot['revision']['content']['evidence'][number];
async function openReading(
  viewId: string,
  signal: AbortSignal,
  kind: 'view' | 'topic',
): Promise<OpenedReading> {
  if (kind === 'view')
    return readCandidateSavedView('open', { viewId }, signal);
  const value = await readCandidateTopic('open', { viewId }, signal);
  if (value.status === 'UNAVAILABLE') throw new CandidateReaderError('stale');
  return value;
}

type Tab = 'originals' | 'records' | 'map';
type Position = {
  after?: string;
  anchor?: string;
  savedStart?: boolean;
  first?: number;
};
interface Navigation extends Position {
  readonly previous: readonly Position[];
}
const firstPosition = (): Navigation => ({ previous: [] });
const first = 50;
const noStacExtents = [] as const;

function geometryDrawingKey(page: IngestionCandidateGeometryPage | null) {
  return page === null
    ? null
    : JSON.stringify({
        reference: candidateSavedReferenceKey(page.reference),
        assetId: page.assetId.toLowerCase(),
        crs: page.crs,
        features: page.features,
      });
}

export function IngestionCandidateReader({
  reference,
  locale,
  savedViewId,
  savedTopicId,
  ingestionId,
  readOnly = false,
  supplementLookup,
  publicReferences,
  publicReferenceState,
}: {
  readonly reference: IngestionCandidateReference | null;
  readonly locale: Locale;
  readonly savedViewId?: string;
  readonly savedTopicId?: string;
  readonly ingestionId?: string;
  readonly readOnly?: boolean;
  readonly supplementLookup?: CandidateSupplementLookup;
} & PublicReferenceInput) {
  const copy = getDictionary(locale).dataFoundation.candidateReader;
  const routeIntake = ingestionId ?? reference?.ingestionId;
  if ((savedViewId || savedTopicId) && routeIntake && !readOnly)
    return (
      <SavedCandidateBootstrap
        publicReferences={publicReferences}
        publicReferenceState={publicReferenceState}
        key={`${routeIntake}:${savedTopicId ? 'topic' : 'view'}:${savedTopicId ?? savedViewId}`}
        ingestionId={routeIntake}
        savedViewId={savedViewId}
        savedTopicId={savedTopicId}
        locale={locale}
      />
    );
  if (reference === null)
    return (
      <section className={styles.reader} aria-label={copy.title}>
        <h2>{copy.title}</h2>
        <p>{copy.noCandidate}</p>
      </section>
    );
  return (
    <CandidateSession
      publicReferences={publicReferences}
      publicReferenceState={publicReferenceState}
      key={`${candidateSavedReferenceKey(reference)}:${readOnly ? 'read' : (savedViewId ?? 'managed')}`}
      reference={reference}
      locale={locale}
      savedViewId={readOnly ? undefined : savedViewId}
      readOnly={readOnly}
      supplementLookup={supplementLookup}
    />
  );
}

function SavedCandidateBootstrap({
  ingestionId,
  savedViewId,
  savedTopicId,
  locale,
  publicReferences,
  publicReferenceState,
}: {
  ingestionId: string;
  savedViewId?: string;
  savedTopicId?: string;
  locale: Locale;
} & PublicReferenceInput) {
  const copy = getDictionary(locale).dataFoundation.candidateReader;
  const [reference, setReference] =
    useState<IngestionCandidateReference | null>(null);
  const [error, setError] = useState<CandidateReaderError['kind'] | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setReference(null);
    setError(null);
    void openReading(
      (savedTopicId ?? savedViewId)!,
      abort.signal,
      savedTopicId ? 'topic' : 'view',
    )
      .then((view) => {
        if (abort.signal.aborted) return;
        const input = view.request.input;
        if (input.ingestionId.toLowerCase() !== ingestionId.toLowerCase()) {
          setError('invalid');
          return;
        }
        // A persisted server-authorized candidate reference is used even if no current candidate is advertised.
        setReference({
          kind: input.kind,
          ingestionId: input.ingestionId,
          processingBatchId: input.processingBatchId,
          reviewHash: input.reviewHash,
        });
      })
      .catch((failure: unknown) => {
        if (!abort.signal.aborted)
          setError(
            failure instanceof CandidateReaderError
              ? failure.kind
              : 'unavailable',
          );
      });
    return () => abort.abort();
  }, [ingestionId, savedViewId, savedTopicId, retry]);
  if (reference)
    return (
      <CandidateSession
        publicReferences={publicReferences}
        publicReferenceState={publicReferenceState}
        reference={reference}
        locale={locale}
        savedViewId={savedViewId}
        savedTopicId={savedTopicId}
      />
    );
  return (
    <section className={styles.reader} aria-label={copy.title}>
      <h2>{copy.title}</h2>
      {error && error !== 'cancelled' ? (
        <div role="alert">
          <p>{copy[error]}</p>
          <button type="button" onClick={() => setRetry(retry + 1)}>
            {copy.retry}
          </button>
        </div>
      ) : (
        <p role="status">{copy.loading}</p>
      )}
    </section>
  );
}

function CandidateSession({
  reference,
  locale,
  savedViewId,
  savedTopicId,
  readOnly = false,
  supplementLookup,
  publicReferences,
  publicReferenceState,
}: {
  reference: IngestionCandidateReference;
  locale: Locale;
  savedViewId?: string;
  savedTopicId?: string;
  readOnly?: boolean;
  supplementLookup?: CandidateSupplementLookup;
} & PublicReferenceInput) {
  // The keyed owner fixes a complete candidate identity; replacements unmount and cancel it.
  const [fixed, setFixed] = useState(reference);
  const [manifest, setManifest] = useState<IngestionCandidateSavedReferences>([
    reference,
  ]);
  const [openedView, setOpenedView] = useState<OpenedReading | null>(null);
  const [pageSize, setPageSize] = useState(first);
  const [saved, setSaved] = useState<CandidateSavedPages['list'] | null>(null);
  const [topics, setTopics] = useState<CandidateTopicPages['list'] | null>(
    null,
  );
  const [topicNav, setTopicNav] = useState(firstPosition);
  const [topicMode, setTopicMode] = useState(savedTopicId !== undefined);
  const recoveryKind = useRef<'view' | 'topic'>(
    savedTopicId ? 'topic' : 'view',
  );
  const [savedNav, setSavedNav] = useState(firstPosition);
  const [viewName, setViewName] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'project'>(
    'private',
  );
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [otherLink, setOtherLink] = useState<string | null>(null);
  const mutationKeys = useRef(new Map<string, string>());
  // Keep only the server view identifier for recovery after sensitive content is cleared.
  const recoveryViewId = useRef(savedTopicId ?? savedViewId);
  const dictionary = getDictionary(locale).dataFoundation;
  const copy = dictionary.candidateReader;
  const [assets, setAssets] = useState<IngestionCandidateAssetPage | null>(
    null,
  );
  const [records, setRecords] = useState<IngestionCandidateRecordPage | null>(
    null,
  );
  const [geometry, setGeometryPage] =
    useState<IngestionCandidateGeometryPage | null>(null);
  const [mapGeometry, setMapGeometry] =
    useState<IngestionCandidateGeometryPage | null>(null);
  const liveCamera = useRef<{ drawingKey: string; camera: MapCamera } | null>(
    null,
  );
  const [cameraRestore, setCameraRestore] = useState<{
    referenceKey: string;
    assetId: string;
    drawingKey: string | null;
    camera: MapCamera;
    epoch: number;
  } | null>(null);
  const [comparisonActive, setComparisonActive] = useState(false);
  const comparisonActiveRef = useRef(false);
  const comparison = useRef<CandidateMapComparisonHandle | null>(null);
  const comparisonSnapshot = useRef<{
    page: IngestionCandidateGeometryPage;
    position: Navigation;
    selected: string | null;
    camera?: MapCamera;
  } | null>(null);
  const cameraEpoch = useRef(0);
  const singleMapReading = useRef<DataFoundationMapReadingHandle | null>(null);
  const [monthly, setMonthly] = useState<CandidateMonthlySemanticRead | null>(
    null,
  );
  const [relationPage, setRelationPage] = useState<
    CandidateRelationPages['list'] | null
  >(null);
  const [relationDetail, setRelationDetail] =
    useState<CandidateRelationSnapshot | null>(null);
  const [relationNav, setRelationNav] = useState(firstPosition);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('originals');
  const [assetNav, setAssetNav] = useState(firstPosition);
  const [recordNav, setRecordNav] = useState(firstPosition);
  const [geometryNav, setGeometryNav] = useState(firstPosition);
  const [busy, setBusy] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [failure, setFailure] = useState<CandidateReaderError['kind'] | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const rasterCancel = useRef<(() => void) | null>(null);
  const [rasterEpoch, setRasterEpoch] = useState(0);
  const owner = useRef(true);
  const [recovering, setRecovering] = useState(false);
  const recoveryGate = useRef(false);
  const mutationPending = useRef(false);
  const recoveryQueued = useRef(false);
  const recoverCurrent = useRef<() => void>(() => {});
  const contentAvailable = useRef(false);
  contentAvailable.current = assets !== null;
  const restricted = useRef<HTMLDivElement>(null);
  function releaseRecovery() {
    recoveryGate.current = false;
    recoveryQueued.current = false;
    if (contentAvailable.current) {
      comparison.current?.resume();
      restricted.current?.removeAttribute('inert');
    }
    if (owner.current) setRecovering(false);
  }
  function requestRecovery() {
    if (!owner.current || !contentAvailable.current || recoveryGate.current)
      return;
    // Browser events must block new navigation before React commits a render.
    recoveryGate.current = true;
    comparison.current?.suspend();
    setMonthly(null);
    setRelationPage(null);
    setRelationDetail(null);
    restricted.current?.setAttribute('inert', '');
    setRecovering(true);
    rasterCancel.current?.();
    if (mutationPending.current) recoveryQueued.current = true;
    else recoverCurrent.current();
  }
  const [expanded, setExpanded] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const id = useId();
  const mapFeatures = useMemo(
    () =>
      mapGeometry
        ? candidateMapFeatures(mapGeometry)
        : { type: 'FeatureCollection' as const, features: [] },
    [mapGeometry],
  );
  const labels = useMemo(
    () => ({
      ...dictionary.mapPage,
      authorityLayer: copy.map,
      selectedVersion: copy.processingBatch,
      noSelectedVersion: copy.pending,
    }),
    [dictionary.mapPage, copy.map, copy.processingBatch, copy.pending],
  );

  function setGeometry(value: IngestionCandidateGeometryPage | null) {
    // Every read still obtains current authorization and a new cursor. Only an
    // identical fixed drawing retains its map instance and reading camera.
    setGeometryPage(value);
    const drawingKey = geometryDrawingKey(value);
    if (liveCamera.current?.drawingKey !== drawingKey)
      liveCamera.current = null;
    if (value)
      setCameraRestore((previous) =>
        previous &&
        previous.drawingKey === null &&
        previous.referenceKey === candidateSavedReferenceKey(value.reference) &&
        previous.assetId === value.assetId.toLowerCase()
          ? { ...previous, drawingKey }
          : previous,
      );
    setMapGeometry((previous) =>
      geometryDrawingKey(previous) === geometryDrawingKey(value)
        ? previous
        : value,
    );
  }

  function clearContent() {
    comparison.current?.cancel();
    comparisonActiveRef.current = false;
    comparisonSnapshot.current = null;
    setComparisonActive(false);
    setMonthly(null);
    setRelationPage(null);
    setRelationDetail(null);
    setRelationNav(firstPosition());
    contentAvailable.current = false;
    rasterCancel.current?.();
    setAssets(null);
    setRecords(null);
    setGeometry(null);
    setSelected(null);
    setAssetId(null);
    setAssetNav(firstPosition());
    setRecordNav(firstPosition());
    setGeometryNav(firstPosition());
    setSaved(null);
    setTopics(null);
    setTopicNav(firstPosition());
    setSavedNav(firstPosition());
    setOpenedView(null);
    setCameraRestore(null);
    liveCamera.current = null;
    setManifest([reference]);
    setFixed(reference);
    setPageSize(first);
    setViewName('');
    setSavedMessage(null);
    setOtherLink(null);
  }
  async function execute(
    work: (signal: AbortSignal) => Promise<void>,
    kind: 'read' | 'mutation' | 'recovery' | 'comparison-exit' = 'read',
  ) {
    if (recoveryGate.current && kind !== 'recovery') return;
    if (
      comparisonActiveRef.current &&
      kind !== 'recovery' &&
      kind !== 'comparison-exit'
    )
      return;
    setMonthly(null);
    setRelationPage(null);
    setRelationDetail(null);
    mutationPending.current = kind === 'mutation';
    setMutating(mutationPending.current);
    rasterCancel.current?.();
    setRasterEpoch((value) => value + 1);
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      await work(controller.signal);
    } catch (error) {
      if (
        !controller.signal.aborted &&
        owner.current &&
        pending.current === controller
      ) {
        clearContent();
        setFailure(
          error instanceof CandidateReaderError ? error.kind : 'unavailable',
        );
      }
    } finally {
      if (
        !controller.signal.aborted &&
        owner.current &&
        pending.current === controller
      ) {
        pending.current = null;
        mutationPending.current = false;
        setMutating(false);
        setBusy(false);
        if (kind === 'recovery') releaseRecovery();
        else if (recoveryQueued.current) {
          recoveryQueued.current = false;
          // Retain the mutation result; recovery uses the latest mounted reader.
          queueMicrotask(() => {
            if (owner.current && contentAvailable.current)
              recoverCurrent.current();
            else releaseRecovery();
          });
        }
      }
    }
  }
  const input = (position: Position, chosenAsset?: string) => ({
    ...fixed,
    first: position.first ?? pageSize,
    ...(chosenAsset ? { assetId: chosenAsset } : {}),
    ...(position.after ? { after: position.after } : {}),
  });
  const manifestKey = (value: OpenedReading) =>
    JSON.stringify({
      references: value.references.map(candidateSavedReferenceKey).sort(),
      viewSpec: value.viewSpec,
      specVersion: 'specVersion' in value ? value.specVersion : 1,
    });
  async function savedAuthority(signal: AbortSignal) {
    if (!openedView) return;
    const current = await openReading(
      openedView.savedView.viewId,
      signal,
      recoveryKind.current,
    );
    if (
      manifestKey(current) !== manifestKey(openedView) ||
      !current.references.some(
        (ref) =>
          candidateSavedReferenceKey(ref) === candidateSavedReferenceKey(fixed),
      )
    )
      throw new CandidateReaderError('invalid');
  }
  function originalUrl(chosenAsset: string) {
    if (!topicMode)
      return candidateOriginalUrl(
        fixed,
        chosenAsset,
        locale,
        openedView?.savedView.viewId,
      );
    if (
      !openedView ||
      !('specVersion' in openedView) ||
      openedView.specVersion !== 2 ||
      !openedView.viewSpec.dependencyPins.some(
        (pin) =>
          pin.kind === 'asset' &&
          pin.assetId.toLowerCase() === chosenAsset.toLowerCase() &&
          candidateSavedReferenceKey(pin.reference) ===
            candidateSavedReferenceKey(fixed),
      )
    )
      return undefined;
    return candidateOriginalUrl(
      fixed,
      chosenAsset,
      locale,
      undefined,
      openedView.savedView.viewId,
    );
  }
  async function readPage<A extends CandidateReadAction>(
    action: A,
    value: unknown,
    signal: AbortSignal,
  ): Promise<CandidatePages[A]> {
    await savedAuthority(signal);
    const result = await readCandidatePage(action, value, signal);
    await savedAuthority(signal);
    return result;
  }
  async function comparisonPosition(
    chosenAsset: string,
    position: CandidateComparisonPosition,
    signal: AbortSignal,
  ): Promise<Navigation> {
    if (!position.savedStart || !openedView)
      return { ...position, previous: [...position.previous] };
    const current = await openReading(
      openedView.savedView.viewId,
      signal,
      recoveryKind.current,
    );
    const page = current.viewSpec.page;
    if (
      manifestKey(current) !== manifestKey(openedView) ||
      page.kind !== 'geometry' ||
      candidateSavedReferenceKey(page.reference) !==
        candidateSavedReferenceKey(fixed) ||
      page.assetId.toLowerCase() !== chosenAsset.toLowerCase() ||
      page.first !== (position.first ?? pageSize) ||
      page.afterRecordId !== position.anchor
    )
      throw new CandidateReaderError('invalid');
    return {
      ...position,
      after: current.request.input.after,
      previous: [...position.previous],
    };
  }
  async function readComparisonGeometry(
    chosenAsset: string,
    position: CandidateComparisonPosition,
    signal: AbortSignal,
  ) {
    const next = await comparisonPosition(chosenAsset, position, signal);
    const page = await readPage('geometry', input(next, chosenAsset), signal);
    return { page, position: next };
  }
  function startComparison() {
    if (
      busy ||
      recovering ||
      recoveryGate.current ||
      mutationPending.current ||
      comparisonActiveRef.current ||
      !geometry ||
      tab !== 'map'
    )
      return;
    const drawing = geometryDrawingKey(mapGeometry);
    const camera =
      supportedReadingCamera(singleMapReading.current?.camera()) ??
      (liveCamera.current?.drawingKey === drawing
        ? liveCamera.current.camera
        : cameraRestore?.drawingKey === drawing
          ? cameraRestore.camera
          : undefined);
    comparisonSnapshot.current = {
      page: geometry,
      position: {
        ...geometryNav,
        first: geometryNav.first ?? pageSize,
        previous: [...geometryNav.previous],
      },
      selected,
      ...(camera ? { camera } : {}),
    };
    comparisonActiveRef.current = true;
    rasterCancel.current?.();
    setComparisonActive(true);
  }
  async function returnFromComparison(target?: CandidateComparisonSelection) {
    const snapshot = comparisonSnapshot.current;
    if (
      !comparisonActiveRef.current ||
      !snapshot ||
      recoveryGate.current ||
      busy
    )
      return;
    if (
      target &&
      candidateSavedReferenceKey(target.reference) !==
        candidateSavedReferenceKey(fixed)
    )
      return;
    comparison.current?.suspend();
    await execute(async (signal) => {
      if (target) {
        if (
          openedView &&
          (target.assetId.toLowerCase() !==
            snapshot.page.assetId.toLowerCase() ||
            !snapshot.page.features.some(
              (row) =>
                row.recordId.toLowerCase() === target.recordId.toLowerCase(),
            ))
        )
          throw new CandidateReaderError('invalid');
        let position = firstPosition();
        for (let page = 0; page < 10; page++) {
          const value = await readPage(
            'records',
            input(position, target.assetId),
            signal,
          );
          if (signal.aborted || !owner.current) return;
          if (
            value.records.some(
              (row) =>
                row.recordId.toLowerCase() === target.recordId.toLowerCase(),
            )
          ) {
            setAssetId(target.assetId);
            setRecords(value);
            setRecordNav(position);
            setGeometry(null);
            setGeometryNav(firstPosition());
            setSelected(target.recordId);
            setTab('records');
            comparisonActiveRef.current = false;
            setComparisonActive(false);
            comparisonSnapshot.current = null;
            return;
          }
          if (!value.nextCursor || !value.records.length) break;
          position = nextPosition(
            position,
            value.nextCursor,
            value.records.at(-1)?.recordId,
          );
        }
        setNotice(copy.limitedSearch);
        return;
      }
      const result = await readComparisonGeometry(
        snapshot.page.assetId,
        snapshot.position,
        signal,
      );
      if (signal.aborted || !owner.current) return;
      setAssetId(snapshot.page.assetId);
      setGeometry(result.page);
      setGeometryNav(result.position);
      setSelected(
        result.page.features.some(
          (row) =>
            row.recordId.toLowerCase() === snapshot.selected?.toLowerCase(),
        )
          ? snapshot.selected
          : null,
      );
      setTab('map');
      if (snapshot.camera)
        setCameraRestore({
          referenceKey: candidateSavedReferenceKey(fixed),
          assetId: snapshot.page.assetId.toLowerCase(),
          drawingKey: geometryDrawingKey(result.page),
          camera: snapshot.camera,
          epoch: ++cameraEpoch.current,
        });
      comparisonActiveRef.current = false;
      setComparisonActive(false);
      comparisonSnapshot.current = null;
    }, 'comparison-exit');
    if (comparisonActiveRef.current && contentAvailable.current)
      comparison.current?.resume();
  }
  async function relationAuthority(
    references: IngestionCandidateSavedReferences,
    signal: AbortSignal,
  ) {
    await savedAuthority(signal);
    // The complete source selection is checked, including a source with no
    // returned relations. Neither an empty page nor a topic grants source access.
    for (const reference of references)
      await readCandidatePage('get', { ...reference, first: 1 }, signal);
  }
  function loadRelations(position = firstPosition()) {
    if (recoveryGate.current || mutationPending.current) return;
    const references = openedView?.references ?? manifest;
    return execute(async (signal) => {
      await relationAuthority(references, signal);
      const page = await readCandidateRelation(
        'list',
        {
          references,
          first: 25,
          ...(position.after ? { after: position.after } : {}),
        },
        signal,
      );
      await relationAuthority(references, signal);
      if (signal.aborted || !owner.current) return;
      setRelationPage(page);
      setRelationNav(position);
    });
  }
  function inspectRelation(snapshot: CandidateRelationSnapshot) {
    if (recoveryGate.current || mutationPending.current) return;
    const references = openedView?.references ?? manifest;
    const page = relationPage;
    return execute(async (signal) => {
      await relationAuthority(references, signal);
      const value = await readCandidateRelation(
        'get',
        {
          references,
          relationId: snapshot.revision.relationId,
          revision: snapshot.revision.revision,
          decisionVersion: snapshot.decisionVersion,
        },
        signal,
      );
      await relationAuthority(references, signal);
      if (signal.aborted || !owner.current) return;
      setRelationPage(page);
      setRelationDetail(value.relation);
    });
  }
  function loadAssets(position = firstPosition()) {
    if (recoveryGate.current) return Promise.resolve();
    setTab('originals');
    return execute(async (signal) => {
      const value = await readPage('get', input(position), signal);
      if (signal.aborted) return;
      setAssets(value);
      setAssetNav(position);
    });
  }
  function loadRecords(chosenAsset: string, position = firstPosition()) {
    if (recoveryGate.current) return Promise.resolve();
    setTab('records');
    if (chosenAsset !== assetId) {
      setRecords(null);
      setGeometry(null);
      setSelected(null);
      setGeometryNav(firstPosition());
    }
    setAssetId(chosenAsset);
    return execute(async (signal) => {
      const value = await readPage(
        'records',
        input(position, chosenAsset),
        signal,
      );
      if (signal.aborted) return;
      setRecords(value);
      setRecordNav(position);
    });
  }
  function loadMonthly(chosenAsset: string, preparedSha256: string) {
    if (recoveryGate.current || mutationPending.current) return;
    setTab('originals');
    setAssetId(chosenAsset);
    setRecords(null);
    setGeometry(null);
    setSelected(null);
    setRecordNav(firstPosition());
    setGeometryNav(firstPosition());
    return execute(async (signal) => {
      // The owner chooses view vs complete topic and checks every saved member.
      // Do not pass a topic identifier through the semantic reader's v1 view path.
      await savedAuthority(signal);
      const pins =
        openedView && 'rulePins' in openedView.viewSpec
          ? openedView.viewSpec.rulePins
          : null;
      const pin = pins?.find(
        (item) =>
          item.kind === 'projection' &&
          item.ruleId === 'beijing-monthly-docx-c3',
      );
      if (topicMode && !pin) {
        await savedAuthority(signal);
        if (!signal.aborted) setNotice(copy.monthly.ruleUnavailable);
        return;
      }
      const processingRuleVersion = pin
        ? pin.version
        : CANDIDATE_MONTHLY_RULE_VERSION_V3;
      const value = await readCandidateMonthlySemantics(
        {
          reference: fixed,
          assetId: chosenAsset,
          fixed: {
            sourceLocalWorkId: null,
            originalSha256: null,
            preparedSha256,
            processingRuleVersion,
          },
        },
        signal,
      );
      await savedAuthority(signal);
      if (signal.aborted || !owner.current) return;
      setMonthly(value);
    });
  }
  function loadGeometry(chosenAsset: string, position = firstPosition()) {
    if (recoveryGate.current) return Promise.resolve();
    setTab('map');
    if (chosenAsset !== assetId) {
      setRecords(null);
      setGeometry(null);
      setSelected(null);
      setRecordNav(firstPosition());
    }
    setAssetId(chosenAsset);
    return execute(async (signal) => {
      const value = await readPage(
        'geometry',
        input(position, chosenAsset),
        signal,
      );
      if (signal.aborted) return;
      setGeometry(value);
      setGeometryNav(position);
    });
  }
  function switchTab(next: Tab) {
    if (
      recoveryGate.current ||
      mutationPending.current ||
      comparisonActiveRef.current
    )
      return;
    if (next !== 'originals') rasterCancel.current?.();
    setTab(next);
    if (next === 'map' && assetId) void loadGeometry(assetId, geometryNav);
    else if (next === 'records' && assetId)
      void loadRecords(assetId, recordNav);
  }
  function nextPosition(
    nav: Navigation,
    cursor: string,
    anchor: string | undefined,
  ): Navigation {
    return {
      after: cursor,
      ...(nav.first ? { first: nav.first } : {}),
      ...(anchor ? { anchor } : {}),
      previous: [
        ...nav.previous,
        {
          after: nav.after,
          anchor: nav.anchor,
          savedStart: nav.savedStart,
          ...(nav.first ? { first: nav.first } : {}),
        },
      ].slice(-32),
    };
  }
  function previousPosition(nav: Navigation): Navigation {
    return { ...nav.previous.at(-1), previous: nav.previous.slice(0, -1) };
  }
  function selectRecord(recordId: string) {
    if (recoveryGate.current) return;
    if (
      geometry?.features.some(
        (record) => record.recordId.toLowerCase() === recordId.toLowerCase(),
      ) ||
      records?.records.some(
        (record) => record.recordId.toLowerCase() === recordId.toLowerCase(),
      )
    )
      setSelected(recordId);
  }
  function seek(
    kind: 'records' | 'geometry',
    target?: {
      assetId: string;
      recordId: string;
      evidence?: CandidateRelationEvidence;
      monthly?: Extract<CandidateMonthlySemanticRead, { kind: 'READY' }>;
    },
  ) {
    if (recoveryGate.current || mutationPending.current) return;
    const monthlyRead = target?.monthly;
    const monthlyRecord = monthlyRead?.records.find(
      (record) =>
        record.sourceLocalIdentity.recordId.toLowerCase() ===
        target?.recordId.toLowerCase(),
    );
    if (
      monthlyRead &&
      (!monthlyRecord ||
        candidateSavedReferenceKey(monthlyRead.candidateReference) !==
          candidateSavedReferenceKey(fixed) ||
        monthlyRead.assetId.toLowerCase() !== target.assetId.toLowerCase() ||
        monthlyRecord.processingRuleVersion !==
          monthlyRead.processingRuleVersion)
    )
      return;
    // Page delivery can be shortened by byte budgets, so row ordinals cannot
    // determine page distance. Every indexed monthly selection reuses its exact
    // acquired page; ordinary non-monthly seeking remains bounded below.
    const indexed = monthlyRead?.recordPageIndex?.find(
      (entry) =>
        entry.recordId.toLowerCase() ===
        monthlyRecord?.sourceLocalIdentity.recordId.toLowerCase(),
    );
    const evidence = target?.evidence;
    if (
      evidence &&
      (!evidence.recordId ||
        candidateSavedReferenceKey(evidence.reference) !==
          candidateSavedReferenceKey(fixed) ||
        evidence.assetId !== target.assetId ||
        evidence.recordId !== target.recordId)
    )
      return;
    const chosenAsset = target?.assetId ?? assetId,
      chosenRecord = target?.recordId ?? selected;
    if (!chosenAsset || !chosenRecord) return;
    if (target) {
      setSelected(null);
      setRecords(null);
      setAssetId(chosenAsset);
      if (chosenAsset !== assetId) {
        setGeometry(null);
        setGeometryNav(firstPosition());
      }
    }
    setTab(kind === 'geometry' ? 'map' : 'records');
    return execute(async (signal) => {
      if (evidence) {
        let assetPosition = firstPosition();
        let verified = false;
        // Evidence must match fresh metadata, never the cached current asset page.
        // The public get contract has no asset filter: bound this lookup to ten pages.
        for (let page = 0; page < 10; page++) {
          const value = await readPage(
            'get',
            {
              ...fixed,
              first: 200,
              ...(assetPosition.after ? { after: assetPosition.after } : {}),
            },
            signal,
          );
          if (signal.aborted || !owner.current) return;
          const asset = value.assets.find(
            (item) => item.assetId.toLowerCase() === chosenAsset.toLowerCase(),
          );
          if (asset) {
            if (asset.sourceHash !== evidence.sourceHash)
              throw new CandidateReaderError('stale');
            // Background verification must not replace the user's visible asset
            // page or its saveable cursor/anchor and page-size position.
            verified = true;
            break;
          }
          if (!value.nextCursor || value.assets.length === 0)
            throw new CandidateReaderError('stale');
          assetPosition = nextPosition(
            assetPosition,
            value.nextCursor,
            undefined,
          );
        }
        if (!verified) {
          setNotice(copy.relations.assetSearchLimit);
          return;
        }
      }
      if (indexed && monthlyRead && monthlyRecord && kind === 'records') {
        const checkProvenance = async () => {
          if (
            monthlyRead.processingRuleVersion ===
            CANDIDATE_MONTHLY_RULE_VERSION_V3
          ) {
            const provenance = await readCandidateConversionProvenance(
              { ...fixed, preparedAssetId: chosenAsset },
              signal,
            );
            const expected = monthlyRead.conversionEvidence;
            const check = provenance.check;
            if (
              (expected === null) !== (check === null) ||
              (expected &&
                check &&
                Object.entries(expected).some(
                  ([key, value]) =>
                    JSON.stringify(check[key as keyof typeof check]) !==
                    JSON.stringify(value),
                ))
            )
              throw new CandidateReaderError('stale');
          }
        };
        await checkProvenance();
        const value = await readPage(
          'records',
          {
            ...fixed,
            assetId: chosenAsset,
            first: indexed.first,
            ...(indexed.after ? { after: indexed.after } : {}),
          },
          signal,
        );
        if (signal.aborted || !owner.current) return;
        await checkProvenance();
        if (signal.aborted || !owner.current) return;
        const row = value.records.find(
          (record) =>
            record.recordId.toLowerCase() === chosenRecord.toLowerCase(),
        );
        if (
          !row ||
          row.index !== monthlyRecord.sourceLocalIdentity.index ||
          row.sourceId !== monthlyRecord.sourceLocalIdentity.sourceId
        )
          throw new CandidateReaderError('stale');
        setRecords(value);
        setRecordNav({ ...indexed, previous: [...indexed.previous] });
        setSelected(chosenRecord);
        return;
      }
      let position = firstPosition();
      // Each explicit selection reads at most ten server pages; there is no full-batch prefetch.
      for (let page = 0; page < 10; page++) {
        const value = await readPage(
          kind,
          input(position, chosenAsset),
          signal,
        );
        if (signal.aborted || !owner.current) return;
        const rows = 'records' in value ? value.records : value.features;
        if (kind === 'records') {
          setRecords(value as IngestionCandidateRecordPage);
          setRecordNav(position);
        } else {
          setGeometry(value as IngestionCandidateGeometryPage);
          setGeometryNav(position);
        }
        if (
          rows.some(
            (row) => row.recordId.toLowerCase() === chosenRecord.toLowerCase(),
          )
        ) {
          setSelected(chosenRecord);
          return;
        }
        if (!value.nextCursor || rows.length === 0) break;
        position = nextPosition(
          position,
          value.nextCursor,
          rows.at(-1)?.recordId,
        );
      }
      setNotice(copy.limitedSearch);
    });
  }
  function mutationKey(action: 'create' | 'revoke', value: unknown) {
    const key = `${action}:${JSON.stringify(value)}`;
    const existing = mutationKeys.current.get(key);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    mutationKeys.current.set(key, fresh);
    if (mutationKeys.current.size > 16)
      mutationKeys.current.delete(mutationKeys.current.keys().next().value!);
    return fresh;
  }
  function saveCurrent() {
    if (recoveryGate.current) return;
    if (comparisonActiveRef.current) {
      setNotice(copy.comparison.save);
      return;
    }
    if (topicMode || !assets || !viewName.trim()) return;
    const nav =
      tab === 'originals'
        ? assetNav
        : tab === 'records'
          ? recordNav
          : geometryNav;
    if (nav.after && !nav.anchor) {
      setNotice(copy.savedFailed);
      return;
    }
    let page: IngestionCandidateSavedViewSpec['page'];
    if (tab === 'originals')
      page = {
        kind: 'assets',
        reference: fixed,
        first: nav.first ?? pageSize,
        ...(nav.anchor ? { afterAssetId: nav.anchor } : {}),
      };
    else {
      if (!assetId || (tab === 'records' ? !records : !geometry)) return;
      page = {
        kind: tab === 'map' ? 'geometry' : 'records',
        reference: fixed,
        assetId,
        first: nav.first ?? pageSize,
        ...(nav.anchor ? { afterRecordId: nav.anchor } : {}),
      };
    }
    const storedMap = openedView?.viewSpec.map;
    const storedPage = openedView?.viewSpec.page;
    const sameCameraOwner =
      page.kind !== 'assets' &&
      storedPage &&
      storedPage.kind !== 'assets' &&
      candidateSavedReferenceKey(page.reference) ===
        candidateSavedReferenceKey(storedPage.reference) &&
      page.assetId.toLowerCase() === storedPage.assetId.toLowerCase();
    const sameDrawing =
      !mapGeometry ||
      !cameraRestore?.drawingKey ||
      cameraRestore.drawingKey === geometryDrawingKey(mapGeometry);
    // An immutable old view is preserved, but its camera must not acquire the
    // identity of another asset merely because the new page has no camera yet.
    const retainedMap =
      storedMap?.camera && (!sameCameraOwner || !sameDrawing)
        ? storedMap.layers
          ? { layers: storedMap.layers }
          : undefined
        : storedMap;
    const captured =
      liveCamera.current?.drawingKey === geometryDrawingKey(mapGeometry) &&
      (!retainedMap?.camera || supportedReadingCamera(retainedMap.camera))
        ? supportedReadingCamera(liveCamera.current?.camera)
        : undefined;
    const map = captured ? { ...retainedMap, camera: captured } : retainedMap;
    const value = {
      title: viewName.trim(),
      visibility,
      references: manifest,
      viewSpec: {
        page,
        ...(assetId && selected
          ? { focus: { reference: fixed, assetId, recordId: selected } }
          : {}),
        ...(map ? { map } : {}),
        ...(openedView?.viewSpec.period
          ? { period: openedView.viewSpec.period }
          : {}),
      },
    };
    return execute(async (signal) => {
      await savedAuthority(signal);
      await readCandidateSavedView(
        'create',
        value,
        signal,
        mutationKey('create', value),
      );
      await savedAuthority(signal);
      if (!signal.aborted) setSavedMessage(copy.saveSuccess);
    }, 'mutation');
  }
  function loadSaved(position = firstPosition()) {
    if (recoveryGate.current) return Promise.resolve();
    return execute(async (signal) => {
      const result = await readCandidateSavedView(
        'list',
        { first: 20, ...(position.after ? { after: position.after } : {}) },
        signal,
      );
      if (!signal.aborted) {
        setSaved(result);
        setSavedNav(position);
      }
    });
  }
  function loadTopics(position = firstPosition()) {
    if (recoveryGate.current) return Promise.resolve();
    setTopics(null);
    return execute(async (signal) => {
      const result = await readCandidateTopic(
        'list',
        { first: 20, ...(position.after ? { after: position.after } : {}) },
        signal,
      );
      if (!signal.aborted) {
        setTopics(result);
        setTopicNav(position);
      }
    });
  }
  function openSaved(viewId: string, kind = recoveryKind.current) {
    if (recoveryGate.current) return Promise.resolve();
    return execute(async (signal) => {
      try {
        const value = await openReading(viewId, signal, kind);
        const request = value.request;
        const ref: IngestionCandidateReference = {
          kind: request.input.kind,
          ingestionId: request.input.ingestionId,
          processingBatchId: request.input.processingBatchId,
          reviewHash: request.input.reviewHash,
        };
        if (
          ref.ingestionId.toLowerCase() !== reference.ingestionId.toLowerCase()
        ) {
          setOtherLink(
            `/${locale}/data-foundation/ingestions/${ref.ingestionId.toLowerCase()}?${kind === 'topic' ? 'candidateTopic' : 'candidateView'}=${viewId.toLowerCase()}`,
          );
          setNotice(copy.otherIntake);
          return;
        }
        const action =
          request.capabilityId === 'data.ingestion.candidate.get'
            ? 'get'
            : request.capabilityId === 'data.ingestion.candidate.records'
              ? 'records'
              : 'geometry';
        const material = await readCandidatePage(action, request.input, signal);
        const originalPage =
          'assets' in material
            ? material
            : await readCandidatePage('get', { ...ref, first }, signal);
        const confirmation = await openReading(viewId, signal, kind);
        if (manifestKey(value) !== manifestKey(confirmation))
          throw new CandidateReaderError('invalid');
        if (signal.aborted) return;
        setFixed(ref);
        setManifest(value.references);
        setOpenedView(confirmation);
        setTopicMode(kind === 'topic');
        setPageSize(request.input.first);
        setAssets(originalPage);
        setRecords('records' in material ? material : null);
        setGeometry('features' in material ? material : null);
        liveCamera.current = null;
        const camera = supportedReadingCamera(value.viewSpec.map?.camera);
        setCameraRestore(
          camera && value.viewSpec.page.kind !== 'assets'
            ? {
                referenceKey: candidateSavedReferenceKey(ref),
                assetId: value.viewSpec.page.assetId.toLowerCase(),
                drawingKey:
                  'features' in material ? geometryDrawingKey(material) : null,
                camera,
                epoch: ++cameraEpoch.current,
              }
            : null,
        );
        setAssetId('assetId' in material ? material.assetId : null);
        setSelected(
          value.viewSpec.focus &&
            candidateSavedReferenceKey(value.viewSpec.focus.reference) ===
              candidateSavedReferenceKey(ref)
            ? (value.viewSpec.focus.recordId ?? null)
            : null,
        );
        const savedPage = value.viewSpec.page;
        const anchor =
          savedPage.kind === 'assets'
            ? savedPage.afterAssetId
            : savedPage.afterRecordId;
        const nav: Navigation = {
          savedStart: true,
          ...(request.input.after ? { after: request.input.after } : {}),
          ...(anchor ? { anchor } : {}),
          previous: [],
        };
        setAssetNav('assets' in material ? nav : firstPosition());
        setRecordNav('records' in material ? nav : firstPosition());
        setGeometryNav('features' in material ? nav : firstPosition());
        setTab(
          'assets' in material
            ? 'originals'
            : 'records' in material
              ? 'records'
              : 'map',
        );
        setViewName(value.savedView.title);
        setVisibility(value.savedView.visibility);
        recoveryKind.current = kind;
        recoveryViewId.current = viewId;
      } catch (error) {
        // Retain the attempted fixed identifier only for a real failure retry.
        // A cross-intake result or cancelled proposal never replaces the adopted reading owner.
        if (!signal.aborted) {
          recoveryKind.current = kind;
          recoveryViewId.current = viewId;
        }
        throw error;
      }
    });
  }
  function revokeSaved(viewId: string) {
    if (recoveryGate.current) return Promise.resolve();
    const value = { viewId };
    return execute(async (signal) => {
      await readCandidateSavedView(
        'revoke',
        value,
        signal,
        mutationKey('revoke', value),
      );
      if (signal.aborted) return;
      if (openedView?.savedView.viewId.toLowerCase() === viewId.toLowerCase()) {
        recoveryViewId.current = undefined;
        clearContent();
      } else
        setSaved((list) =>
          list
            ? {
                ...list,
                items: list.items.filter(
                  (view) => view.viewId.toLowerCase() !== viewId.toLowerCase(),
                ),
              }
            : null,
        );
      setNotice(copy.revokeSuccess);
    }, 'mutation');
  }
  recoverCurrent.current = () => {
    if (!assets) {
      releaseRecovery();
      return;
    }
    const action =
      tab === 'originals' ? 'get' : tab === 'records' ? 'records' : 'geometry';
    const position =
      tab === 'originals'
        ? assetNav
        : tab === 'records'
          ? recordNav
          : geometryNav;
    void execute(async (signal) => {
      let current: OpenedReading | null = null;
      if (openedView) {
        current = await openReading(
          openedView.savedView.viewId,
          signal,
          recoveryKind.current,
        );
        if (
          manifestKey(current) !== manifestKey(openedView) ||
          !current.references.some(
            (ref) =>
              candidateSavedReferenceKey(ref) ===
              candidateSavedReferenceKey(fixed),
          )
        )
          throw new CandidateReaderError('invalid');
      }
      const savedPage = current?.viewSpec.page;
      // Only the saved start can use open's new resume request. A user-advanced
      // page keeps its own cursor; invalid/expired cursors fail visibly.
      const savedStart =
        position.savedStart &&
        savedPage &&
        savedPage.kind ===
          (tab === 'originals'
            ? 'assets'
            : tab === 'records'
              ? 'records'
              : 'geometry') &&
        candidateSavedReferenceKey(savedPage.reference) ===
          candidateSavedReferenceKey(fixed) &&
        (savedPage.kind === 'assets' ||
          savedPage.assetId.toLowerCase() === assetId?.toLowerCase());
      const nextPosition = savedStart
        ? { ...position, after: current!.request.input.after }
        : position;
      const value = await readCandidatePage(
        action,
        input(
          nextPosition,
          action === 'get' ? undefined : (assetId ?? undefined),
        ),
        signal,
      );
      if (current) {
        const confirmation = await openReading(
          current.savedView.viewId,
          signal,
          recoveryKind.current,
        );
        if (manifestKey(confirmation) !== manifestKey(current))
          throw new CandidateReaderError('invalid');
      }
      if (comparisonActiveRef.current && comparison.current) {
        await comparison.current.recover(signal);
        await savedAuthority(signal);
      }
      if (signal.aborted) return;
      if ('assets' in value) {
        setAssets(value);
        setAssetNav(nextPosition);
      } else if ('records' in value) {
        setRecords(value);
        setRecordNav(nextPosition);
      } else {
        setGeometry(value);
        setGeometryNav(nextPosition);
      }
    }, 'recovery');
  };
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === 'visible') requestRecovery();
    };
    const shown = (event: PageTransitionEvent) => {
      if (event.persisted) requestRecovery();
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('pageshow', shown);
    return () => {
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('pageshow', shown);
    };
  }, []);
  useEffect(() => {
    owner.current = true;
    if (savedTopicId || savedViewId)
      void openSaved((savedTopicId ?? savedViewId)!);
    else void loadAssets();
    return () => {
      owner.current = false;
      comparison.current?.cancel();
      pending.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!expanded || !panel.current) return;
    const element = panel.current,
      previousOverflow = document.body.style.overflow;
    const scroll = { top: element.scrollTop, left: element.scrollLeft };
    const inert: HTMLElement[] = [];
    let current: HTMLElement | null = element;
    while (current && current !== document.body) {
      for (const sibling of current.parentElement?.children ?? [])
        if (
          sibling !== current &&
          sibling instanceof HTMLElement &&
          !sibling.hasAttribute('inert')
        ) {
          sibling.setAttribute('inert', '');
          inert.push(sibling);
        }
      current = current.parentElement;
    }
    document.body.style.overflow = 'hidden';
    expandButton.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      for (const sibling of inert) sibling.removeAttribute('inert');
      element.scrollTop = scroll.top;
      element.scrollLeft = scroll.left;
      expandButton.current?.focus({ preventScroll: true });
    };
  }, [expanded]);

  const currentRecord = records?.records.find(
    (record) => record.recordId.toLowerCase() === selected?.toLowerCase(),
  );
  const currentGeometry = geometry?.features.find(
    (record) => record.recordId.toLowerCase() === selected?.toLowerCase(),
  );
  const selectedRow = tab === 'map' ? currentGeometry : currentRecord;
  const displayValue = (value: unknown): ReactNode =>
    value === undefined ? (
      <span className={styles.missing}>{copy.valueAbsent}</span>
    ) : value === null ? (
      <span className={styles.missing}>{copy.valueNull}</span>
    ) : value === '' ? (
      <span className={styles.missing}>{copy.valueEmpty}</span>
    ) : typeof value === 'object' ? (
      <code>{JSON.stringify(value)}</code>
    ) : typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ? (
      String(value)
    ) : (
      JSON.stringify(value)
    );
  const pager = (
    nav: Navigation,
    cursor: string | null,
    anchor: string | undefined,
    previousLabel: string,
    nextLabel: string,
    read: (position: Navigation) => Promise<void>,
  ) => (
    <nav
      className={styles.pager}
      aria-label={`${previousLabel} / ${nextLabel}`}
    >
      <button
        type="button"
        disabled={busy || !nav.after}
        onClick={() => void read(firstPosition())}
      >
        {copy.firstPage}
      </button>
      <button
        type="button"
        disabled={busy || nav.previous.length === 0}
        onClick={() => void read(previousPosition(nav))}
      >
        {previousLabel}
      </button>
      <button
        type="button"
        disabled={busy || cursor === null}
        onClick={() => cursor && void read(nextPosition(nav, cursor, anchor))}
      >
        {nextLabel}
      </button>
    </nav>
  );

  return (
    <section
      ref={panel}
      className={`${styles.reader} ${expanded ? styles.expanded : ''}`}
      role={expanded ? 'dialog' : undefined}
      aria-modal={expanded || undefined}
      aria-label={copy.title}
      onKeyDown={(event) => {
        if (!expanded) return;
        if (event.key === 'Escape') {
          if (
            event.target instanceof Element &&
            event.target.closest(
              '[data-context-help="true"][aria-expanded="true"]',
            )
          )
            return;
          event.preventDefault();
          setExpanded(false);
        } else if (event.key === 'Tab') {
          const focusable = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]',
            ),
          ].filter(
            (element) =>
              !element.closest('[hidden],[inert]') &&
              (!element.closest('details:not([open])') ||
                element.tagName === 'SUMMARY'),
          );
          const firstElement = focusable[0],
            last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === firstElement) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            firstElement?.focus();
          }
        }
      }}
    >
      <header className={styles.header}>
        <div>
          <h2>{copy.title}</h2>
          <span className={styles.pending}>{copy.pending}</span>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            disabled={busy || comparisonActive}
            onClick={() =>
              recoveryViewId.current
                ? void openSaved(recoveryViewId.current)
                : void loadAssets()
            }
          >
            {copy.refresh}
          </button>
          <button
            type="button"
            ref={expandButton}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? copy.collapse : copy.expand}
          </button>
        </div>
      </header>
      {expanded ? (
        <p className={styles.supporting}>{copy.fullScreenHelp}</p>
      ) : null}
      {busy ? <p role="status">{copy.loading}</p> : null}
      {failure && failure !== 'cancelled' ? (
        <div role="alert" className={styles.failure}>
          <p>{copy[failure]}</p>
          <button
            type="button"
            onClick={() =>
              recoveryViewId.current
                ? void openSaved(recoveryViewId.current)
                : void loadAssets()
            }
          >
            {copy.retry}
          </button>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      ) : null}
      {otherLink ? <a href={otherLink}>{copy.openSaved}</a> : null}
      {assets ? (
        <div
          ref={restricted}
          className={styles.content}
          inert={recovering}
          aria-busy={recovering}
          onClickCapture={(event) => {
            if (recoveryGate.current) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onKeyDownCapture={(event) => {
            if (recoveryGate.current) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
        >
          <section
            className={styles.savedSection}
            aria-label={copy.facts.title}
          >
            <h3>{copy.facts.title}</h3>
            <div className={styles.summaryHeader}>
              <span>{copy.parseStatus}</span>
              <strong className={styles.status} data-state={assets.status}>
                {copy.statuses[assets.status]}
              </strong>
              <ContextHelp label={copy.countHelp}>
                {copy.countExplanation}
              </ContextHelp>
            </div>
            <dl className={styles.metrics}>
              {[
                [copy.totalAssets, assets.totalAssetCount],
                [copy.knownRecords, assets.knownRecordCount],
                [copy.knownFeatures, assets.knownFeatureCount],
                [copy.unknownAssets, assets.unknownAssetCount],
                [copy.independentObservations, copy.notEstablished],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <dl className={styles.metrics}>
              {[
                [copy.facts.loadedAssets, assets.assets.length],
                [
                  copy.facts.loadedRecords,
                  records === null
                    ? copy.facts.notLoaded
                    : records.records.length,
                ],
                [
                  copy.facts.loadedGeometry,
                  geometry === null
                    ? copy.facts.notLoaded
                    : geometry.features.length,
                ],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <p className={styles.supporting}>{copy.facts.scope}</p>
            <p>{copy.facts.cleaningUnknown}</p>
            <p>{copy.facts.qualityUnknown}</p>
            <p>{copy.facts.densityUnknown}</p>
            <p>{copy.facts.useUnknown}</p>
            <details>
              <summary>{copy.facts.parserDetails}</summary>
              <dl className={styles.technical}>
                <dt>{copy.parserVersion}</dt>
                <dd>{assets.parserVersion}</dd>
              </dl>
              <h3>{copy.facts.columns}</h3>
              {records === null ? (
                <p>{copy.facts.notLoaded}</p>
              ) : records.columns.length === 0 ? (
                <p>{copy.facts.noColumns}</p>
              ) : (
                <ul className={styles.assetList}>
                  {records.columns.map((column) => (
                    <li key={column.key}>
                      <span>{column.label}</span>
                      <code>{column.key}</code>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          </section>
          <details className={styles.savedSection}>
            <summary>{getDictionary(locale).candidateFollowups.title}</summary>
            <CandidateFollowupPanel
              locale={locale}
              ruleId="candidate-reader-evidence"
              ruleVersion={assets.parserVersion}
              references={manifest.map((item) => ({
                reference: item,
                label: item.ingestionId,
              }))}
              readOnly={readOnly || topicMode}
              parentBusy={busy || comparisonActive}
              supplementLookup={openedView ? undefined : supplementLookup}
            />
          </details>
          <CandidateRelationPanel
            locale={locale}
            busy={busy || recovering || comparisonActive}
            page={relationPage}
            detail={relationDetail}
            canPrevious={relationNav.previous.length > 0}
            reference={fixed}
            onSourceRow={(evidence) => {
              if (evidence.recordId)
                void seek('records', {
                  assetId: evidence.assetId,
                  recordId: evidence.recordId,
                  evidence,
                });
            }}
            onRead={() => void loadRelations()}
            onInspect={(relation) => void inspectRelation(relation)}
            onNext={() => {
              if (relationPage?.nextCursor)
                void loadRelations(
                  nextPosition(relationNav, relationPage.nextCursor, undefined),
                );
            }}
            onPrevious={() => {
              const previous = relationNav.previous.at(-1);
              if (previous)
                void loadRelations({
                  ...previous,
                  previous: relationNav.previous.slice(0, -1),
                });
            }}
          />
          {monthly && (
            <CandidateMonthlyPanel
              key={`${candidateSavedReferenceKey(fixed)}:${monthly.assetId}`}
              result={monthly}
              locale={locale}
              busy={busy || recovering}
              onSelect={(record) =>
                void seek('records', {
                  assetId: record.source.assetId,
                  recordId: record.sourceLocalIdentity.recordId,
                  monthly: monthly.kind === 'READY' ? monthly : undefined,
                })
              }
            />
          )}
          <div
            className={styles.tabs}
            role="tablist"
            aria-label={copy.tabs}
            onKeyDown={(event) => {
              const tabs = ['originals', 'records', 'map'] as const;
              const index = tabs.indexOf(tab);
              const next =
                event.key === 'ArrowRight'
                  ? tabs[(index + 1) % 3]
                  : event.key === 'ArrowLeft'
                    ? tabs[(index + 2) % 3]
                    : event.key === 'Home'
                      ? tabs[0]
                      : event.key === 'End'
                        ? tabs[2]
                        : undefined;
              if (next) {
                event.preventDefault();
                if (
                  recoveryGate.current ||
                  mutationPending.current ||
                  comparisonActiveRef.current
                )
                  return;
                switchTab(next);
                event.currentTarget
                  .querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)
                  ?.focus();
              }
            }}
          >
            {(['originals', 'records', 'map'] as const).map((value) => (
              <button
                type="button"
                role="tab"
                id={`${id}-${value}`}
                aria-controls={`${id}-panel-${value}`}
                aria-selected={tab === value}
                tabIndex={tab === value ? 0 : -1}
                data-tab={value}
                key={value}
                disabled={mutating || comparisonActive}
                onClick={() => switchTab(value)}
              >
                {copy[value]}
              </button>
            ))}
          </div>
          <div className={styles.content}>
            <section
              role="tabpanel"
              id={`${id}-panel-originals`}
              aria-labelledby={`${id}-originals`}
              className={styles.tabPanel}
              hidden={tab !== 'originals'}
            >
              {tab === 'originals' ? (
                <>
                  <h3>{copy.assetsCaption}</h3>
                  <ul className={styles.assetList}>
                    {assets.assets.map((asset, index) => (
                      <li key={asset.assetId}>
                        <div>
                          <strong>
                            {copy.originals} {index + 1}
                          </strong>
                          <span
                            className={styles.status}
                            data-state={asset.status}
                          >
                            {copy.statuses[asset.status]}
                          </span>
                        </div>
                        <dl className={styles.assetCounts}>
                          <div>
                            <dt>{copy.recordCount}</dt>
                            <dd>{asset.recordCount ?? copy.unknown}</dd>
                          </div>
                          <div>
                            <dt>{copy.featureCount}</dt>
                            <dd>{asset.featureCount ?? copy.unknown}</dd>
                          </div>
                        </dl>
                        <div className={styles.actions}>
                          {originalUrl(asset.assetId) ? (
                            <a href={originalUrl(asset.assetId)}>
                              {copy.downloadOriginal}
                            </a>
                          ) : null}
                          <button
                            type="button"
                            disabled={
                              busy ||
                              asset.recordCount === null ||
                              asset.recordCount === 0
                            }
                            onClick={() => void loadRecords(asset.assetId)}
                          >
                            {copy.readRecords}
                          </button>
                          {asset.status === 'READY' &&
                            asset.recordCount !== null &&
                            asset.recordCount > 0 && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                  void loadMonthly(
                                    asset.assetId,
                                    asset.sourceHash,
                                  )
                                }
                              >
                                {copy.monthly.read}
                              </button>
                            )}
                          <button
                            type="button"
                            disabled={
                              busy ||
                              asset.featureCount === null ||
                              asset.featureCount === 0
                            }
                            onClick={() => void loadGeometry(asset.assetId)}
                          >
                            {copy.readGeometry}
                          </button>
                        </div>
                        <details>
                          <summary>{copy.technical}</summary>
                          <dl className={styles.technical}>
                            <dt>{copy.asset}</dt>
                            <dd>{asset.assetId}</dd>
                            <dt>{copy.sourceHash}</dt>
                            <dd>{asset.sourceHash}</dd>
                          </dl>
                        </details>
                      </li>
                    ))}
                  </ul>
                  {topicMode ? null : (
                    <IngestionCandidateRasterPanel
                      publicReferences={publicReferences}
                      publicReferenceState={publicReferenceState}
                      key={`${candidateSavedReferenceKey(fixed)}:${openedView?.savedView.viewId ?? ''}:${rasterEpoch}`}
                      reference={fixed}
                      locale={locale}
                      savedViewId={openedView?.savedView.viewId}
                      parentBusy={busy}
                      cancelSlot={rasterCancel}
                      onAuthorityFailure={(kind) => {
                        pending.current?.abort();
                        pending.current = null;
                        setBusy(false);
                        clearContent();
                        setFailure(kind);
                      }}
                    />
                  )}
                  {pager(
                    assetNav,
                    assets.nextCursor,
                    assets.assets.at(-1)?.assetId,
                    copy.previousAssets,
                    copy.nextAssets,
                    loadAssets,
                  )}
                </>
              ) : null}
            </section>
            <section
              role="tabpanel"
              id={`${id}-panel-records`}
              aria-labelledby={`${id}-records`}
              className={styles.tabPanel}
              hidden={tab !== 'records'}
            >
              {tab === 'records' ? (
                <>
                  {records ? (
                    <>
                      <div className={styles.tableWrap} tabIndex={0}>
                        <table>
                          <thead>
                            <tr>
                              <th>{copy.row}</th>
                              {records.columns.map((column) => (
                                <th key={column.key}>{column.label}</th>
                              ))}
                              <th>{copy.locator}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {records.records.map((record) => (
                              <tr
                                key={record.recordId}
                                data-selected={
                                  record.recordId.toLowerCase() ===
                                  selected?.toLowerCase()
                                }
                              >
                                <th>
                                  <button
                                    type="button"
                                    aria-pressed={
                                      record.recordId.toLowerCase() ===
                                      selected?.toLowerCase()
                                    }
                                    aria-label={`${copy.selectRecord} ${record.index}`}
                                    onClick={() => setSelected(record.recordId)}
                                  >
                                    {record.index}
                                  </button>
                                </th>
                                {records.columns.map((column) => (
                                  <td key={column.key}>
                                    {displayValue(
                                      Object.hasOwn(record.values, column.key)
                                        ? record.values[column.key]
                                        : undefined,
                                    )}
                                  </td>
                                ))}
                                <td>
                                  {record.sourceId ?? copy.locationUnknown}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {records.records.length === 0 ? (
                        <p>{copy.noRecords}</p>
                      ) : null}
                      {pager(
                        recordNav,
                        records.nextCursor,
                        records.records.at(-1)?.recordId,
                        copy.previousRecords,
                        copy.nextRecords,
                        (position) => loadRecords(records.assetId, position),
                      )}
                    </>
                  ) : (
                    <p>{copy.noRecords}</p>
                  )}
                </>
              ) : null}
            </section>
            <section
              role="tabpanel"
              id={`${id}-panel-map`}
              aria-labelledby={`${id}-map`}
              className={styles.tabPanel}
              hidden={tab !== 'map'}
            >
              {geometry ? (
                <>
                  <div className={styles.summaryHeader}>
                    <span>
                      {copy.geometryRecords}: {geometry.features.length} ·{' '}
                      {copy.drawingParts}: {mapFeatures.features.length}
                    </span>
                    <ContextHelp label={copy.mapHelp}>
                      {copy.mapExplanation}
                    </ContextHelp>
                  </div>
                  <p className={styles.notice}>{copy.geometryPending}</p>
                  {comparisonActive && comparisonSnapshot.current ? (
                    <CandidateMapComparison
                      {...{ publicReferences, publicReferenceState }}
                      ref={comparison}
                      locale={locale}
                      seed={comparisonSnapshot.current}
                      assetIds={
                        openedView
                          ? [comparisonSnapshot.current.page.assetId]
                          : assets.assets
                              .filter(
                                (asset) =>
                                  asset.featureCount !== null &&
                                  asset.featureCount > 0,
                              )
                              .map((asset) => asset.assetId)
                      }
                      fixedPage={openedView !== null}
                      blocked={recovering || busy}
                      readGeometry={readComparisonGeometry}
                      originalUrl={originalUrl}
                      onFailure={(kind) => {
                        pending.current?.abort();
                        clearContent();
                        setFailure(kind);
                      }}
                      onReturn={(target) => void returnFromComparison(target)}
                    />
                  ) : (
                    <button
                      type="button"
                      disabled={busy || recovering}
                      onClick={startComparison}
                    >
                      {copy.comparison.open}
                    </button>
                  )}
                  {comparisonActive ? null : (
                    <div className={styles.singleMap}>
                      {geometry.features.length ? (
                        <DataFoundationMap
                          readingHandle={singleMapReading}
                          publicReferences={publicReferences}
                          publicReferenceState={publicReferenceState}
                          key={
                            cameraRestore?.drawingKey ===
                            geometryDrawingKey(mapGeometry)
                              ? cameraRestore?.epoch
                              : 0
                          }
                          locale={locale}
                          ariaLabel={copy.map}
                          displayCrs="EPSG:4326"
                          features={mapFeatures}
                          stacExtents={noStacExtents}
                          labels={labels}
                          onSelectRecord={selectRecord}
                          selectedRecordId={selected}
                          initialReadingCamera={
                            cameraRestore?.drawingKey ===
                            geometryDrawingKey(mapGeometry)
                              ? cameraRestore?.camera
                              : undefined
                          }
                          onReadingCamera={(camera) => {
                            if (
                              comparisonActiveRef.current ||
                              recoveryGate.current
                            )
                              return;
                            const drawingKey = geometryDrawingKey(mapGeometry);
                            if (drawingKey)
                              liveCamera.current = { drawingKey, camera };
                          }}
                        />
                      ) : (
                        <p>{copy.noGeometry}</p>
                      )}
                      <ul className={styles.geometryList}>
                        {geometry.features.map((feature) => (
                          <li key={feature.recordId}>
                            <button
                              type="button"
                              aria-pressed={
                                feature.recordId.toLowerCase() ===
                                selected?.toLowerCase()
                              }
                              onClick={() => selectRecord(feature.recordId)}
                            >
                              {copy.selectRecord} {feature.index} ·{' '}
                              {copy.geometryKinds[feature.geometry.type]}
                            </button>
                            <span>
                              {feature.sourceId ?? copy.locationUnknown}
                            </span>
                          </li>
                        ))}
                      </ul>
                      {pager(
                        geometryNav,
                        geometry.nextCursor,
                        geometry.features.at(-1)?.recordId,
                        copy.previousGeometry,
                        copy.nextGeometry,
                        (position) => loadGeometry(geometry.assetId, position),
                      )}
                    </div>
                  )}
                </>
              ) : (
                <p>{copy.noGeometry}</p>
              )}
            </section>
            {selectedRow && !comparisonActive ? (
              <aside className={styles.selection}>
                <h3>
                  {copy.selectedRecord} {selectedRow.index}
                </h3>
                <div className={styles.actions}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void seek(tab === 'map' ? 'records' : 'geometry')
                    }
                  >
                    {tab === 'map'
                      ? copy.viewSelectedRecord
                      : copy.viewSelectedGeometry}
                  </button>
                  <button type="button" onClick={() => setSelected(null)}>
                    {copy.clearSelection}
                  </button>
                  {originalUrl(selectedRow.assetId) ? (
                    <a href={originalUrl(selectedRow.assetId)}>
                      {copy.downloadOriginal}
                    </a>
                  ) : null}
                </div>
                {currentGeometry && tab === 'map' ? (
                  <details>
                    <summary>{copy.geometryTechnical}</summary>
                    <p>
                      {copy.nativeCrs}:{' '}
                      {currentGeometry.sourceCrs ?? copy.sourceCrsUnknown}
                    </p>
                    <pre>
                      {JSON.stringify(currentGeometry.geometry, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </aside>
            ) : null}
          </div>
          {readOnly ? null : (
            <section
              className={styles.savedSection}
              aria-label={copy.saveTitle}
            >
              <div className={styles.summaryHeader}>
                <h3>{copy.saveTitle}</h3>
                <ContextHelp label={copy.saveHelp}>
                  {copy.saveExplanation}
                </ContextHelp>
              </div>
              {openedView ? (
                <div className={styles.actions}>
                  <span>
                    {copy.fixedReferences}: {manifest.length}
                  </span>
                  <a
                    href={`/${locale}/data-foundation/ingestions/${fixed.ingestionId.toLowerCase()}?${topicMode ? 'candidateTopic' : 'candidateView'}=${openedView.savedView.viewId.toLowerCase()}`}
                  >
                    {copy.savedLink}
                  </a>
                </div>
              ) : null}
              {openedView?.viewSpec.map || openedView?.viewSpec.period ? (
                <>
                  {openedView.viewSpec.map?.camera ? (
                    <p className={styles.notice}>
                      {mapGeometry?.features.length &&
                      cameraRestore?.drawingKey &&
                      cameraRestore.drawingKey ===
                        geometryDrawingKey(mapGeometry)
                        ? copy.cameraRestored
                        : copy.cameraNotApplied}
                    </p>
                  ) : null}
                  {openedView.viewSpec.map?.layers ||
                  openedView.viewSpec.period ? (
                    <p className={styles.notice}>{copy.displayNotApplied}</p>
                  ) : null}
                  <details>
                    <summary>{copy.retainedDisplay}</summary>
                    <pre>
                      {JSON.stringify(
                        {
                          map: openedView.viewSpec.map,
                          period: openedView.viewSpec.period,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </>
              ) : null}
              {topicMode ? (
                <p className={styles.notice}>{copy.topicReadOnly}</p>
              ) : (
                <>
                  {comparisonActive ? (
                    <p className={styles.notice}>{copy.comparison.save}</p>
                  ) : null}{' '}
                  <form
                    className={styles.saveForm}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveCurrent();
                    }}
                  >
                    <label>
                      {copy.viewName}
                      <input
                        type="text"
                        value={viewName}
                        maxLength={160}
                        onChange={(event) => setViewName(event.target.value)}
                      />
                    </label>
                    <label>
                      {copy.visibility}
                      <select
                        value={visibility}
                        onChange={(event) =>
                          setVisibility(
                            event.target.value as 'private' | 'project',
                          )
                        }
                      >
                        <option value="private">{copy.private}</option>
                        <option value="project">{copy.project}</option>
                      </select>
                    </label>
                    <button
                      type="submit"
                      disabled={
                        busy ||
                        comparisonActive ||
                        !viewName.trim() ||
                        (tab !== 'originals' &&
                          (!assetId ||
                            (tab === 'records' ? !records : !geometry)))
                      }
                    >
                      {copy.save}
                    </button>
                  </form>
                  {savedMessage ? <p role="status">{savedMessage}</p> : null}
                  <div className={styles.summaryHeader}>
                    <h3>{copy.savedList}</h3>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void loadSaved()}
                    >
                      {copy.loadSaved}
                    </button>
                  </div>
                  {saved ? (
                    <>
                      <ul className={styles.assetList}>
                        {saved.items.map((view) => (
                          <li key={view.viewId}>
                            <strong>{view.title}</strong>
                            <span>{copy[view.visibility]}</span>
                            <div className={styles.actions}>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                  void openSaved(view.viewId, 'view')
                                }
                              >
                                {copy.openSaved}
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void revokeSaved(view.viewId)}
                              >
                                {copy.revokeSaved}
                              </button>
                              <ContextHelp label={copy.revokeHelp}>
                                {copy.revokeExplanation}
                              </ContextHelp>
                            </div>
                          </li>
                        ))}
                      </ul>
                      {saved.items.length === 0 ? (
                        <p>{copy.savedEmpty}</p>
                      ) : null}
                      {pager(
                        savedNav,
                        saved.nextCursor,
                        undefined,
                        copy.previousSaved,
                        copy.nextSaved,
                        loadSaved,
                      )}
                    </>
                  ) : null}
                </>
              )}
              {openedView &&
              'specVersion' in openedView &&
              openedView.specVersion === 2 ? (
                <>
                  <h4>{openedView.savedView.title}</h4>
                  <p>{openedView.viewSpec.topic.question}</p>
                  <details>
                    <summary>{copy.topicDetails}</summary>
                    <pre>{JSON.stringify(openedView.viewSpec, null, 2)}</pre>
                  </details>
                </>
              ) : null}
              <section aria-label={copy.topicList}>
                <div className={styles.summaryHeader}>
                  <h3>{copy.topicList}</h3>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void loadTopics()}
                  >
                    {copy.loadTopics}
                  </button>
                </div>
                {topics ? (
                  <>
                    <ul className={styles.assetList}>
                      {topics.items.map((topic) => (
                        <li key={topic.viewId}>
                          <strong>{topic.title}</strong>
                          <span>{copy[topic.visibility]}</span>
                          <span>
                            {topic.specVersion === 2
                              ? copy.completeTopic
                              : copy.legacyView}
                          </span>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void openSaved(topic.viewId, 'topic')
                            }
                          >
                            {copy.openTopic}
                          </button>
                        </li>
                      ))}
                    </ul>
                    {topics.items.length === 0 ? (
                      <p>{copy.topicsEmpty}</p>
                    ) : null}
                    {pager(
                      topicNav,
                      topics.nextCursor,
                      undefined,
                      copy.previousTopics,
                      copy.nextTopics,
                      loadTopics,
                    )}
                  </>
                ) : null}
              </section>
            </section>
          )}
          <details>
            <summary>{copy.technical}</summary>
            <dl className={styles.technical}>
              <dt>{copy.processingBatch}</dt>
              <dd>{fixed.processingBatchId}</dd>
              <dt>{copy.reviewHash}</dt>
              <dd>{fixed.reviewHash}</dd>
              <dt>{copy.parserVersion}</dt>
              <dd>{assets.parserVersion}</dd>
              <dt>{copy.createdAt}</dt>
              <dd>{assets.createdAt}</dd>
            </dl>
          </details>
        </div>
      ) : null}
    </section>
  );
}
