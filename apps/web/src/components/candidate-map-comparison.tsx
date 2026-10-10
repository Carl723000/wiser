'use client';
import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react';
import {
  candidateSavedReferenceKey,
  type IngestionCandidateGeometryPage,
  type IngestionCandidateReference,
} from '@wiser/data-contracts';
import { getDictionary, type Locale } from '@/lib/i18n';
import { supportedReadingCamera, type MapCamera } from '@/lib/amap-camera';
import {
  CandidateReaderError,
  candidateMapFeatures,
} from '@/lib/ingestion-candidate-reader';
import {
  candidateComparisonInitialCamera,
  candidateComparisonNext,
  candidateComparisonOwner,
  candidateComparisonPrevious,
  createCandidateComparisonReadController,
  type CandidateComparisonPosition,
  type CandidateComparisonSide,
} from '@/lib/candidate-map-comparison';
import type { PublicReferenceInput } from '@/lib/spatial-public-reference.server';
import { DataFoundationMap } from './data-foundation-map';
import styles from './ingestion-candidate-reader.module.css';

interface Pane {
  page: IngestionCandidateGeometryPage;
  position: CandidateComparisonPosition;
  selected: string | null;
  camera: MapCamera;
  epoch: number;
  busy: boolean;
}
export interface CandidateComparisonSelection {
  reference: IngestionCandidateReference;
  assetId: string;
  recordId: string;
}
export interface CandidateMapComparisonHandle {
  suspend: () => void;
  resume: () => void;
  cancel: () => void;
  recover: (signal: AbortSignal) => Promise<void>;
}
interface Props extends PublicReferenceInput {
  ref?: Ref<CandidateMapComparisonHandle>;
  locale: Locale;
  seed: {
    page: IngestionCandidateGeometryPage;
    position: CandidateComparisonPosition;
    selected: string | null;
    camera?: MapCamera;
  };
  assetIds: readonly string[];
  fixedPage: boolean;
  blocked: boolean;
  readGeometry: (
    assetId: string,
    position: CandidateComparisonPosition,
    signal: AbortSignal,
  ) => Promise<{
    page: IngestionCandidateGeometryPage;
    position: CandidateComparisonPosition;
  }>;
  originalUrl: (assetId: string) => string | undefined;
  onFailure: (kind: CandidateReaderError['kind']) => void;
  onReturn: (selection?: CandidateComparisonSelection) => void;
}
const sides = ['left', 'right'] as const;
const noStacExtents = [] as const;
function PaneMap({
  pane,
  side,
  locale,
  onCamera,
  onSelect,
  ...references
}: {
  pane: Pane;
  side: CandidateComparisonSide;
  locale: Locale;
  onCamera: (camera: MapCamera, owner: string) => void;
  onSelect: (recordId: string) => void;
} & PublicReferenceInput) {
  const dictionary = getDictionary(locale).dataFoundation;
  const copy = dictionary.candidateReader;
  const features = useMemo(() => candidateMapFeatures(pane.page), [pane.page]);
  const labels = useMemo(
    () => ({
      ...dictionary.mapPage,
      authorityLayer: copy.map,
      selectedVersion: copy.processingBatch,
      noSelectedVersion: copy.pending,
    }),
    [dictionary.mapPage, copy.map, copy.processingBatch, copy.pending],
  );
  const owner = candidateComparisonOwner(
    side,
    pane.page,
    pane.position,
    pane.epoch,
  );
  return (
    <DataFoundationMap
      {...references}
      locale={locale}
      ariaLabel={copy.comparison[side]}
      displayCrs="EPSG:4326"
      features={features}
      labels={labels}
      stacExtents={noStacExtents}
      selectedRecordId={pane.selected}
      readingCamera={pane.camera}
      readingCameraOwner={owner}
      onReadingCamera={(camera) => onCamera(camera, owner)}
      onSelectRecord={onSelect}
    />
  );
}

export function CandidateMapComparison({
  ref,
  locale,
  seed,
  assetIds,
  fixedPage,
  blocked,
  readGeometry,
  originalUrl,
  onFailure,
  onReturn,
  ...references
}: Props) {
  const copy = getDictionary(locale).dataFoundation.candidateReader;
  const camera =
    supportedReadingCamera(seed.camera) ??
    candidateComparisonInitialCamera(seed.page);
  const initialPane = (): Pane => ({
    page: seed.page,
    position: { ...seed.position, previous: [...seed.position.previous] },
    selected: seed.selected,
    camera,
    epoch: 0,
    busy: false,
  });
  const [state, setState] = useState(() => ({
    left: initialPane(),
    right: initialPane(),
    synchronized: true,
    active: 'left' as CandidateComparisonSide,
    suspended: false,
  }));
  const current = useRef(state);
  const mounted = useRef(true);
  const controllers = useRef({
    left: createCandidateComparisonReadController(),
    right: createCandidateComparisonReadController(),
  });
  const blocking = useRef(blocked);
  blocking.current = blocked;
  const read = useRef(readGeometry);
  read.current = readGeometry;
  const fail = useRef(onFailure);
  fail.current = onFailure;
  function adopt(update: (previous: typeof state) => typeof state) {
    if (!mounted.current) return;
    current.current = update(current.current);
    setState(current.current);
  }
  function cancel() {
    for (const side of sides) controllers.current[side].cancel();
  }
  function suspend() {
    cancel();
    adopt((value) => ({
      ...value,
      suspended: true,
      left: { ...value.left, busy: false, epoch: value.left.epoch + 1 },
      right: { ...value.right, busy: false, epoch: value.right.epoch + 1 },
    }));
  }
  function available(side?: CandidateComparisonSide) {
    return (
      mounted.current &&
      !blocking.current &&
      !current.current.suspended &&
      (!side || !current.current[side].busy)
    );
  }
  function validate(page: IngestionCandidateGeometryPage, assetId: string) {
    if (
      candidateSavedReferenceKey(page.reference) !==
        candidateSavedReferenceKey(seed.page.reference) ||
      page.assetId.toLowerCase() !== assetId.toLowerCase()
    )
      throw new CandidateReaderError('invalid');
  }
  async function load(
    side: CandidateComparisonSide,
    assetId: string,
    position: CandidateComparisonPosition,
  ) {
    if (
      !available(side) ||
      fixedPage ||
      !assetIds.some((id) => id.toLowerCase() === assetId.toLowerCase())
    )
      return;
    const owner = controllers.current[side];
    const token = owner.start();
    adopt((value) => ({
      ...value,
      [side]: { ...value[side], busy: true, epoch: value[side].epoch + 1 },
    }));
    try {
      const result = await read.current(
        assetId,
        position,
        token.controller.signal,
      );
      const { page } = result;
      validate(page, assetId);
      if (!mounted.current || !owner.current(token)) return;
      adopt((value) => ({
        ...value,
        [side]: {
          ...value[side],
          page,
          position: result.position,
          selected: null,
          busy: false,
          epoch: value[side].epoch + 1,
          camera: value.synchronized
            ? value[value.active].camera
            : candidateComparisonInitialCamera(page),
        },
      }));
    } catch (error) {
      if (!mounted.current || !owner.current(token)) return;
      cancel();
      fail.current(
        error instanceof CandidateReaderError ? error.kind : 'unavailable',
      );
    } finally {
      owner.finish(token);
    }
  }
  useImperativeHandle(ref, () => ({
    suspend,
    resume: () => adopt((value) => ({ ...value, suspended: false })),
    cancel,
    async recover(signal) {
      suspend();
      const snapshot = current.current;
      const tokens = sides.map((side) => controllers.current[side].start());
      const abort = () => cancel();
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (signal.aborted) throw new CandidateReaderError('cancelled');
        const pages = await Promise.all(
          sides.map(async (side, index) => {
            const pane = snapshot[side];
            const result = await read.current(
              pane.page.assetId,
              pane.position,
              tokens[index].controller.signal,
            );
            const { page } = result;
            validate(page, pane.page.assetId);
            return result;
          }),
        );
        if (
          signal.aborted ||
          !mounted.current ||
          !sides.every((side, index) =>
            controllers.current[side].current(tokens[index]),
          )
        )
          throw new CandidateReaderError('cancelled');
        adopt((value) => ({
          ...value,
          left: {
            ...value.left,
            page: pages[0].page,
            position: pages[0].position,
            selected: pages[0].page.features.some(
              (row) =>
                row.recordId.toLowerCase() ===
                value.left.selected?.toLowerCase(),
            )
              ? value.left.selected
              : null,
          },
          right: {
            ...value.right,
            page: pages[1].page,
            position: pages[1].position,
            selected: pages[1].page.features.some(
              (row) =>
                row.recordId.toLowerCase() ===
                value.right.selected?.toLowerCase(),
            )
              ? value.right.selected
              : null,
          },
        }));
      } catch (error) {
        cancel();
        throw error;
      } finally {
        signal.removeEventListener('abort', abort);
        sides.forEach((side, index) =>
          controllers.current[side].finish(tokens[index]),
        );
      }
    },
  }));
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel();
    };
  }, []);
  function select(side: CandidateComparisonSide, recordId: string) {
    if (
      !available(side) ||
      !current.current[side].page.features.some(
        (row) => row.recordId.toLowerCase() === recordId.toLowerCase(),
      )
    )
      return;
    adopt((value) => ({
      ...value,
      active: side,
      [side]: { ...value[side], selected: recordId },
    }));
  }
  function move(
    side: CandidateComparisonSide,
    camera: MapCamera,
    owner: string,
  ) {
    if (!available(side) || !supportedReadingCamera(camera)) return;
    const pane = current.current[side];
    if (
      candidateComparisonOwner(side, pane.page, pane.position, pane.epoch) !==
      owner
    )
      return;
    adopt((value) =>
      value.synchronized
        ? {
            ...value,
            active: side,
            left: { ...value.left, camera },
            right: { ...value.right, camera },
          }
        : { ...value, active: side, [side]: { ...value[side], camera } },
    );
  }
  const disabled = blocked || state.suspended;
  return (
    <section
      className={styles.comparison}
      aria-label={copy.comparison.title}
      aria-busy={disabled}
    >
      <div className={styles.actions}>
        <h3>{copy.comparison.title}</h3>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={state.synchronized}
          onClick={() => {
            if (!available()) return;
            adopt((value) => ({
              ...value,
              synchronized: true,
              left: {
                ...value.left,
                camera: value[value.active].camera,
                epoch: value.left.epoch + 1,
              },
              right: {
                ...value.right,
                camera: value[value.active].camera,
                epoch: value.right.epoch + 1,
              },
            }));
          }}
        >
          {copy.comparison.synchronized}
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={!state.synchronized}
          onClick={() => {
            if (!available()) return;
            adopt((value) => ({
              ...value,
              synchronized: false,
              left: { ...value.left, epoch: value.left.epoch + 1 },
              right: { ...value.right, epoch: value.right.epoch + 1 },
            }));
          }}
        >
          {copy.comparison.independent}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            if (available()) onReturn();
          }}
        >
          {copy.comparison.exit}
        </button>
      </div>
      <p className={styles.supporting}>{copy.comparison.scope}</p>
      {fixedPage ? (
        <p className={styles.notice}>{copy.comparison.fixedScope}</p>
      ) : null}
      <div className={styles.comparisonWindows}>
        {sides.map((side) => {
          const pane = state[side],
            locked = disabled || pane.busy;
          return (
            <section
              key={side}
              className={styles.comparisonPane}
              aria-label={copy.comparison[side]}
              aria-busy={locked}
              onFocusCapture={() => {
                if (available(side))
                  adopt((value) => ({ ...value, active: side }));
              }}
            >
              <h3>{copy.comparison[side]}</h3>
              <label className={styles.comparisonAsset}>
                {copy.comparison.asset}
                <select
                  value={pane.page.assetId}
                  disabled={locked || fixedPage}
                  onChange={(event) =>
                    void load(side, event.target.value, {
                      first: seed.position.first,
                      previous: [],
                    })
                  }
                >
                  {[...new Set([seed.page.assetId, ...assetIds])].map(
                    (assetId) => (
                      <option key={assetId} value={assetId}>
                        {assetId}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <p>
                {copy.geometryRecords}: {pane.page.features.length}
              </p>
              {pane.busy ? <p role="status">{copy.loading}</p> : null}
              <div inert={locked} className={styles.comparisonDrawing}>
                <PaneMap
                  {...references}
                  pane={pane}
                  side={side}
                  locale={locale}
                  onCamera={(camera, owner) => move(side, camera, owner)}
                  onSelect={(recordId) => select(side, recordId)}
                />
                {!pane.page.features.length ? <p>{copy.noGeometry}</p> : null}
                <ul className={styles.geometryList}>
                  {pane.page.features.map((feature) => (
                    <li key={feature.recordId}>
                      <button
                        type="button"
                        disabled={locked}
                        aria-pressed={
                          pane.selected?.toLowerCase() ===
                          feature.recordId.toLowerCase()
                        }
                        onClick={() => select(side, feature.recordId)}
                      >
                        {copy.selectRecord} {feature.index} ·{' '}
                        {copy.geometryKinds[feature.geometry.type]}
                      </button>
                      <span>{feature.sourceId ?? copy.locationUnknown}</span>
                    </li>
                  ))}
                </ul>
                <div className={styles.actions}>
                  {originalUrl(pane.page.assetId) ? (
                    <a href={originalUrl(pane.page.assetId)}>
                      {copy.downloadOriginal}
                    </a>
                  ) : null}
                  <button
                    type="button"
                    disabled={locked || !pane.selected}
                    onClick={() => {
                      if (
                        available(side) &&
                        pane.selected &&
                        pane.page.features.some(
                          (row) =>
                            row.recordId.toLowerCase() ===
                            pane.selected?.toLowerCase(),
                        )
                      )
                        onReturn({
                          reference: pane.page.reference,
                          assetId: pane.page.assetId,
                          recordId: pane.selected,
                        });
                    }}
                  >
                    {copy.comparison.record}
                  </button>
                </div>
              </div>
              <nav
                className={styles.pager}
                aria-label={`${copy.comparison[side]} ${copy.map}`}
              >
                <button
                  type="button"
                  disabled={locked || fixedPage || !pane.position.after}
                  onClick={() =>
                    void load(side, pane.page.assetId, {
                      first: pane.position.first,
                      previous: [],
                    })
                  }
                >
                  {copy.firstPage}
                </button>
                <button
                  type="button"
                  disabled={
                    locked || fixedPage || !pane.position.previous.length
                  }
                  onClick={() =>
                    void load(
                      side,
                      pane.page.assetId,
                      candidateComparisonPrevious(pane.position),
                    )
                  }
                >
                  {copy.previousGeometry}
                </button>
                <button
                  type="button"
                  disabled={locked || fixedPage || !pane.page.nextCursor}
                  onClick={() =>
                    pane.page.nextCursor &&
                    void load(
                      side,
                      pane.page.assetId,
                      candidateComparisonNext(
                        pane.position,
                        pane.page.nextCursor,
                        pane.page.features.at(-1)?.recordId,
                      ),
                    )
                  }
                >
                  {copy.nextGeometry}
                </button>
              </nav>
            </section>
          );
        })}
      </div>
    </section>
  );
}
