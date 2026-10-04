'use client';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { IngestionCandidateReference } from '@wiser/data-contracts';
import {
  CANDIDATE_RASTER_BANDS,
  validateRasterSelection,
  type CandidateRasterQuality,
  type CandidateRasterWindowResult,
} from '@/lib/candidate-raster-window';
import { discoverCandidateRasterAssets } from '@/lib/candidate-raster-ui-assets';
import { readCandidateRasterWindow } from '@/lib/candidate-raster-original-reader';
import { CandidateReaderError } from '@/lib/ingestion-candidate-reader';
import { getDictionary, type Locale } from '@/lib/i18n';
import { ContextHelp } from './context-help';
import styles from './ingestion-candidate-raster-panel.module.css';

const RESULT_PAGE_SIZE = 64;

function integer(value: string): number {
  return /^(0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
}

export function IngestionCandidateRasterPanel({
  reference,
  locale,
  savedViewId,
  parentBusy,
  cancelSlot,
  onAuthorityFailure,
}: {
  readonly reference: IngestionCandidateReference;
  readonly locale: Locale;
  readonly savedViewId?: string;
  readonly parentBusy: boolean;
  readonly cancelSlot: RefObject<(() => void) | null>;
  readonly onAuthorityFailure: (kind: 'denied' | 'stale') => void;
}) {
  const copy = getDictionary(locale).dataFoundation.candidateReader.raster;
  const [open, setOpen] = useState(false);
  const [row, setRow] = useState('0');
  const [column, setColumn] = useState('0');
  const [rows, setRows] = useState('1');
  const [columns, setColumns] = useState('1');
  const [qualityMode, setQualityMode] = useState<'raw' | 'scl-classes'>('raw');
  const [classes, setClasses] = useState('');
  const [ruleVersion, setRuleVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<CandidateRasterWindowResult | null>(
    null,
  );
  const [resultPage, setResultPage] = useState(0);
  const active = useRef<AbortController | null>(null);
  const deadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(() => {
    if (deadline.current !== null) clearTimeout(deadline.current);
    deadline.current = null;
    active.current?.abort();
    active.current = null;
  }, []);

  useEffect(() => {
    cancelSlot.current = cancel;
    return () => {
      cancel();
      if (cancelSlot.current === cancel) cancelSlot.current = null;
    };
  }, [cancel, cancelSlot]);

  function stop() {
    cancel();
    setBusy(false);
    setResult(null);
    setFailure(null);
  }

  async function read() {
    if (parentBusy) return;
    stop();
    let selection;
    try {
      const quality: CandidateRasterQuality =
        qualityMode === 'raw'
          ? { kind: 'raw' }
          : {
              kind: 'scl-classes',
              allowedClasses: classes
                .split(',')
                .map((part) => integer(part.trim())),
              ruleVersion,
            };
      selection = validateRasterSelection({
        window: {
          row: integer(row),
          column: integer(column),
          rows: integer(rows),
          columns: integer(columns),
        },
        quality,
        bands: CANDIDATE_RASTER_BANDS,
      });
    } catch {
      setFailure(copy.invalidSelection);
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    // Discovery is part of this user selection, not extra time before the
    // existing reader's 120-second deadline begins.
    deadline.current = setTimeout(() => {
      if (active.current !== controller) return;
      active.current = null;
      deadline.current = null;
      controller.abort();
      setBusy(false);
      setResult(null);
      setFailure(copy.unavailable);
    }, 120_000);
    setBusy(true);
    try {
      const assets = await discoverCandidateRasterAssets(
        reference,
        controller.signal,
      );
      if (controller.signal.aborted || active.current !== controller) return;
      const pixels = await readCandidateRasterWindow(
        {
          reference,
          locale,
          ...(savedViewId ? { savedViewId } : {}),
          assets,
          window: selection.window,
          quality: selection.quality,
        },
        controller.signal,
      );
      if (controller.signal.aborted || active.current !== controller) return;
      setResult(pixels);
      setResultPage(0);
    } catch (error) {
      if (controller.signal.aborted || active.current !== controller) return;
      setResult(null);
      const kind =
        error instanceof CandidateReaderError ? error.kind : 'unavailable';
      if (kind === 'denied' || kind === 'stale') onAuthorityFailure(kind);
      else if (kind !== 'cancelled') setFailure(copy[kind]);
    } finally {
      if (active.current === controller) {
        if (deadline.current !== null) clearTimeout(deadline.current);
        deadline.current = null;
        active.current = null;
        setBusy(false);
      }
    }
  }

  const total = result ? result.window.rows * result.window.columns : 0;
  const first = resultPage * RESULT_PAGE_SIZE;
  const visible = result
    ? Array.from(
        { length: Math.min(RESULT_PAGE_SIZE, total - first) },
        (_, index) => first + index,
      )
    : [];
  let originalValid = 0;
  let qualitySelected = 0;
  let jointIncluded = 0;
  const sclCounts = new Map<number, number>();
  if (result) {
    for (let index = 0; index < total; index++) {
      const original = result.validMask[index] !== 0;
      const selected = result.qualityMask[index] !== 0;
      if (original) originalValid++;
      if (selected) qualitySelected++;
      if (original && selected) jointIncluded++;
      const code = result.values.SCL[index];
      sclCounts.set(code, (sclCounts.get(code) ?? 0) + 1);
    }
  }
  const projectedCellArea = result
    ? Math.abs(
        result.affine[0] * result.affine[4] -
          result.affine[1] * result.affine[3],
      )
    : 0;
  return (
    <section className={styles.panel} aria-label={copy.title}>
      <button
        type="button"
        aria-expanded={open}
        disabled={parentBusy}
        onClick={() => {
          if (open) stop();
          setOpen(!open);
        }}
      >
        {open ? copy.close : copy.open}
      </button>
      {open ? (
        <div className={styles.content}>
          <h4>
            {copy.title}{' '}
            <ContextHelp label={copy.scopeHelpLabel}>
              {copy.scopeHelp}
            </ContextHelp>
          </h4>
          <p>{copy.scope}</p>
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              void read();
            }}
          >
            {(
              [
                [copy.row, row, setRow],
                [copy.column, column, setColumn],
                [copy.rows, rows, setRows],
                [copy.columns, columns, setColumns],
              ] as const
            ).map(([label, value, setValue]) => (
              <label key={label}>
                {label}
                <input
                  type="number"
                  disabled={parentBusy || busy}
                  min={label === copy.row || label === copy.column ? 0 : 1}
                  step="1"
                  value={value}
                  onChange={(event) => {
                    stop();
                    setValue(event.target.value);
                  }}
                />
              </label>
            ))}
            <label>
              {copy.qualitySelection}
              <select
                value={qualityMode}
                disabled={parentBusy || busy}
                onChange={(event) => {
                  stop();
                  setQualityMode(event.target.value as 'raw' | 'scl-classes');
                }}
              >
                <option value="raw">{copy.rawQuality}</option>
                <option value="scl-classes">{copy.sclQuality}</option>
              </select>
            </label>
            {qualityMode === 'scl-classes' ? (
              <>
                <label>
                  {copy.allowedClasses}
                  <input
                    type="text"
                    maxLength={64}
                    value={classes}
                    disabled={parentBusy || busy}
                    onChange={(event) => {
                      stop();
                      setClasses(event.target.value);
                    }}
                  />
                </label>
                <label>
                  {copy.ruleVersion}
                  <input
                    type="text"
                    maxLength={64}
                    value={ruleVersion}
                    disabled={parentBusy || busy}
                    onChange={(event) => {
                      stop();
                      setRuleVersion(event.target.value);
                    }}
                  />
                </label>
                <ContextHelp label={copy.filterHelpLabel}>
                  {copy.filterHelp}
                </ContextHelp>
              </>
            ) : null}
            <button type="submit" disabled={parentBusy || busy}>
              {copy.read}
            </button>
            {busy ? (
              <button type="button" onClick={stop}>
                {copy.cancel}
              </button>
            ) : null}
          </form>
          {busy ? <p role="status">{copy.loading}</p> : null}
          {failure ? <p role="alert">{failure}</p> : null}
          {result ? (
            <div data-testid="candidate-raster-window-values">
              <p>
                {copy.nativeCrs}: {result.crs} · {copy.window}:{' '}
                {result.window.row}, {result.window.column} (
                {result.window.rows} × {result.window.columns})
              </p>
              <p>
                {copy.appliedQuality}:{' '}
                {result.quality.kind === 'raw'
                  ? copy.rawQuality
                  : `${copy.sclQuality} ${result.quality.allowedClasses.join(', ')} · ${copy.ruleVersion}: ${result.quality.ruleVersion}`}
              </p>
              <p>
                {copy.classCounts}:{' '}
                {[...sclCounts.entries()]
                  .sort(([a], [b]) => a - b)
                  .map(([code, count]) => `${code}=${count}`)
                  .join(', ')}
              </p>
              <div className={styles.counts}>
                <p>
                  {copy.requestedCells}: {total}
                </p>
                <p>
                  {copy.originalValid}: {originalValid}
                </p>
                <p>
                  {copy.qualitySelected}: {qualitySelected}
                </p>
                <p>
                  {copy.jointIncluded}: {jointIncluded}
                </p>
                <p>
                  {copy.excludedCells}: {total - jointIncluded}
                </p>
              </div>
              <p>
                {copy.projectedCellArea}: {projectedCellArea} m² ·{' '}
                {copy.includedGridArea}: {jointIncluded * projectedCellArea} m²
              </p>
              <p>
                {copy.maskBasisLabel}{' '}
                <ContextHelp label={copy.maskBasisLabel}>
                  {copy.maskBasis}
                </ContextHelp>
                {' · '}
                {copy.areaLimitLabel}{' '}
                <ContextHelp label={copy.areaLimitLabel}>
                  {copy.areaLimit}
                </ContextHelp>
              </p>
              <div className={styles.tableWrap} tabIndex={0}>
                <table>
                  <thead>
                    <tr>
                      <th>{copy.row}</th>
                      <th>{copy.column}</th>
                      <th>{copy.b03Value}</th>
                      <th>{copy.b8aValue}</th>
                      <th>SCL</th>
                      <th>TCI</th>
                      <th>{copy.validMask}</th>
                      <th>{copy.qualityMask}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((index) => (
                      <tr key={index}>
                        <td>
                          {result.window.row +
                            Math.floor(index / result.window.columns)}
                        </td>
                        <td>
                          {result.window.column +
                            (index % result.window.columns)}
                        </td>
                        <td>{result.values.B03[index]}</td>
                        <td>{result.values.B8A[index]}</td>
                        <td>{result.values.SCL[index]}</td>
                        <td>
                          {result.values.TCI.map((band) => band[index]).join(
                            ', ',
                          )}
                        </td>
                        <td>{result.validMask[index]}</td>
                        <td>{result.qualityMask[index]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {total > RESULT_PAGE_SIZE ? (
                <nav className={styles.pager} aria-label={copy.pixelPages}>
                  <button
                    type="button"
                    disabled={resultPage === 0}
                    onClick={() => setResultPage(resultPage - 1)}
                  >
                    {copy.previousPixels}
                  </button>
                  <span>
                    {first + 1}–{Math.min(first + RESULT_PAGE_SIZE, total)} /{' '}
                    {total}
                  </span>
                  <button
                    type="button"
                    disabled={first + RESULT_PAGE_SIZE >= total}
                    onClick={() => setResultPage(resultPage + 1)}
                  >
                    {copy.nextPixels}
                  </button>
                </nav>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
