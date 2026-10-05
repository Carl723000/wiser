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
  readCandidateSavedView,
  type CandidatePages,
  type CandidateReadAction,
  type CandidateSavedPages,
} from '@/lib/ingestion-candidate-reader';
import { ContextHelp } from './context-help';
import { DataFoundationMap } from './data-foundation-map';
import { supportedReadingCamera, type MapCamera } from '@/lib/amap-camera';
import { IngestionCandidateRasterPanel } from './ingestion-candidate-raster-panel';
import styles from './ingestion-candidate-reader.module.css';

type Tab = 'originals' | 'records' | 'map';
type Position = { after?: string; anchor?: string; savedStart?: boolean };
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
  ingestionId,
  readOnly = false,
}: {
  readonly reference: IngestionCandidateReference | null;
  readonly locale: Locale;
  readonly savedViewId?: string;
  readonly ingestionId?: string;
  readonly readOnly?: boolean;
}) {
  const copy = getDictionary(locale).dataFoundation.candidateReader;
  const routeIntake = ingestionId ?? reference?.ingestionId;
  if (savedViewId && routeIntake && !readOnly)
    return (
      <SavedCandidateBootstrap
        key={`${routeIntake}:${savedViewId}`}
        ingestionId={routeIntake}
        savedViewId={savedViewId}
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
      key={`${candidateSavedReferenceKey(reference)}:${readOnly ? 'read' : (savedViewId ?? 'managed')}`}
      reference={reference}
      locale={locale}
      savedViewId={readOnly ? undefined : savedViewId}
      readOnly={readOnly}
    />
  );
}

function SavedCandidateBootstrap({
  ingestionId,
  savedViewId,
  locale,
}: {
  ingestionId: string;
  savedViewId: string;
  locale: Locale;
}) {
  const copy = getDictionary(locale).dataFoundation.candidateReader;
  const [reference, setReference] =
    useState<IngestionCandidateReference | null>(null);
  const [error, setError] = useState<CandidateReaderError['kind'] | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setReference(null);
    setError(null);
    void readCandidateSavedView('open', { viewId: savedViewId }, abort.signal)
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
  }, [ingestionId, savedViewId, retry]);
  if (reference)
    return (
      <CandidateSession
        reference={reference}
        locale={locale}
        savedViewId={savedViewId}
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
  readOnly = false,
}: {
  reference: IngestionCandidateReference;
  locale: Locale;
  savedViewId?: string;
  readOnly?: boolean;
}) {
  // The keyed owner fixes a complete candidate identity; replacements unmount and cancel it.
  const [fixed, setFixed] = useState(reference);
  const [manifest, setManifest] = useState<IngestionCandidateSavedReferences>([
    reference,
  ]);
  const [openedView, setOpenedView] = useState<
    CandidateSavedPages['open'] | null
  >(null);
  const [pageSize, setPageSize] = useState(first);
  const [saved, setSaved] = useState<CandidateSavedPages['list'] | null>(null);
  const [savedNav, setSavedNav] = useState(firstPosition);
  const [viewName, setViewName] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'project'>(
    'private',
  );
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [otherLink, setOtherLink] = useState<string | null>(null);
  const mutationKeys = useRef(new Map<string, string>());
  // Keep only the server view identifier for recovery after sensitive content is cleared.
  const recoveryViewId = useRef(savedViewId);
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
  const cameraEpoch = useRef(0);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('originals');
  const [assetNav, setAssetNav] = useState(firstPosition);
  const [recordNav, setRecordNav] = useState(firstPosition);
  const [geometryNav, setGeometryNav] = useState(firstPosition);
  const [busy, setBusy] = useState(false);
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
    if (contentAvailable.current) restricted.current?.removeAttribute('inert');
    if (owner.current) setRecovering(false);
  }
  function requestRecovery() {
    if (!owner.current || !contentAvailable.current || recoveryGate.current)
      return;
    // Browser events must block new navigation before React commits a render.
    recoveryGate.current = true;
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
    kind: 'read' | 'mutation' | 'recovery' = 'read',
  ) {
    if (recoveryGate.current && kind !== 'recovery') return;
    mutationPending.current = kind === 'mutation';
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
    first: pageSize,
    ...(chosenAsset ? { assetId: chosenAsset } : {}),
    ...(position.after ? { after: position.after } : {}),
  });
  const manifestKey = (value: CandidateSavedPages['open']) =>
    JSON.stringify({
      references: value.references.map(candidateSavedReferenceKey).sort(),
      viewSpec: value.viewSpec,
    });
  async function savedAuthority(signal: AbortSignal) {
    if (!openedView) return;
    const current = await readCandidateSavedView(
      'open',
      { viewId: openedView.savedView.viewId },
      signal,
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
    if (recoveryGate.current) return;
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
      ...(anchor ? { anchor } : {}),
      previous: [
        ...nav.previous,
        { after: nav.after, anchor: nav.anchor, savedStart: nav.savedStart },
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
  function seek(kind: 'records' | 'geometry') {
    if (recoveryGate.current) return;
    if (!assetId || !selected) return;
    const chosenAsset = assetId,
      chosenRecord = selected;
    setTab(kind === 'geometry' ? 'map' : 'records');
    return execute(async (signal) => {
      let position = firstPosition();
      // Each explicit selection reads at most ten server pages; there is no full-batch prefetch.
      for (let page = 0; page < 10; page++) {
        const value = await readPage(
          kind,
          input(position, chosenAsset),
          signal,
        );
        if (signal.aborted) return;
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
        )
          return;
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
    if (!assets || !viewName.trim()) return;
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
        first: pageSize,
        ...(nav.anchor ? { afterAssetId: nav.anchor } : {}),
      };
    else {
      if (!assetId || (tab === 'records' ? !records : !geometry)) return;
      page = {
        kind: tab === 'map' ? 'geometry' : 'records',
        reference: fixed,
        assetId,
        first: pageSize,
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
  function openSaved(viewId: string) {
    if (recoveryGate.current) return Promise.resolve();
    return execute(async (signal) => {
      const value = await readCandidateSavedView('open', { viewId }, signal);
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
          `/${locale}/data-foundation/ingestions/${ref.ingestionId.toLowerCase()}?candidateView=${viewId.toLowerCase()}`,
        );
        setNotice(copy.otherIntake);
        return;
      }
      recoveryViewId.current = viewId;
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
      const confirmation = await readCandidateSavedView(
        'open',
        { viewId },
        signal,
      );
      if (manifestKey(value) !== manifestKey(confirmation))
        throw new CandidateReaderError('invalid');
      if (signal.aborted) return;
      setFixed(ref);
      setManifest(value.references);
      setOpenedView(confirmation);
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
      let current: CandidateSavedPages['open'] | null = null;
      if (openedView) {
        current = await readCandidateSavedView(
          'open',
          { viewId: openedView.savedView.viewId },
          signal,
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
        const confirmation = await readCandidateSavedView(
          'open',
          { viewId: current.savedView.viewId },
          signal,
        );
        if (manifestKey(confirmation) !== manifestKey(current))
          throw new CandidateReaderError('invalid');
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
    if (savedViewId) void openSaved(savedViewId);
    else void loadAssets();
    return () => {
      owner.current = false;
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
            disabled={busy}
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
                          <a
                            href={candidateOriginalUrl(
                              fixed,
                              asset.assetId,
                              locale,
                              openedView?.savedView.viewId,
                            )}
                          >
                            {copy.downloadOriginal}
                          </a>
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
                  <IngestionCandidateRasterPanel
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
                  {geometry.features.length ? (
                    <DataFoundationMap
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
                        <span>{feature.sourceId ?? copy.locationUnknown}</span>
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
                </>
              ) : (
                <p>{copy.noGeometry}</p>
              )}
            </section>
            {selectedRow ? (
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
                  <a
                    href={candidateOriginalUrl(
                      fixed,
                      selectedRow.assetId,
                      locale,
                      openedView?.savedView.viewId,
                    )}
                  >
                    {copy.downloadOriginal}
                  </a>
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
                    href={`/${locale}/data-foundation/ingestions/${fixed.ingestionId.toLowerCase()}?candidateView=${openedView.savedView.viewId.toLowerCase()}`}
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
                      setVisibility(event.target.value as 'private' | 'project')
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
                    !viewName.trim() ||
                    (tab !== 'originals' &&
                      (!assetId || (tab === 'records' ? !records : !geometry)))
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
                            onClick={() => void openSaved(view.viewId)}
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
                  {saved.items.length === 0 ? <p>{copy.savedEmpty}</p> : null}
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
