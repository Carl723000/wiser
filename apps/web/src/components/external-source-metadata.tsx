'use client';
import { useEffect, useRef, useState } from 'react';
import {
  ExternalMetadataInputSchema,
  ExternalMetadataOutputSchema,
  type ExternalMetadataInput,
  type ExternalMetadataOutput,
} from '@wiser/data-contracts';
import { getDictionary, type Locale } from '@/lib/i18n';
import { externalMetadataFailureCode } from '@/lib/external-metadata-state';
import styles from './external-source-metadata.module.css';
import { ContextHelp } from './context-help';

export function ExternalSourceMetadata({
  sourceId,
  locale,
}: {
  sourceId: string;
  locale: Locale;
}) {
  const copy = getDictionary(locale).externalMetadata;
  const [start, setStart] = useState(''),
    [end, setEnd] = useState('');
  const [page, setPage] = useState<ExternalMetadataOutput | null>(null);
  const [applied, setApplied] = useState<ExternalMetadataInput | null>(null);
  const [state, setState] = useState<keyof typeof copy>('registered');
  const active = useRef<AbortController | null>(null);
  const stop = () => {
    active.current?.abort();
    active.current = null;
  };
  const clear = () => {
    stop();
    setPage(null);
    setApplied(null);
    setState('registered');
  };
  useEffect(() => {
    // Source changes and a hidden page must not keep a previous permission result alive.
    const hide = () => {
      if (document.hidden) clear();
    };
    clear();
    document.addEventListener('visibilitychange', hide);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', hide);
    };
  }, [sourceId]);
  async function read(input: ExternalMetadataInput) {
    stop();
    const controller = new AbortController();
    active.current = controller;
    setPage(null);
    setState('loading');
    const timer = setTimeout(() => {
      if (active.current === controller) {
        clear();
        setState('timeout');
      }
    }, 35000);
    try {
      const response = await fetch('/api/data-foundation/external-metadata', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        cache: 'no-store',
        signal: controller.signal,
      });
      const value: unknown = await response.json();
      if (active.current !== controller || controller.signal.aborted) return;
      if (!response.ok) {
        const code = externalMetadataFailureCode(
          value && typeof value === 'object' && 'code' in value
            ? value.code
            : undefined,
          response.status,
        );
        setState(
          response.status === 401
            ? 'authentication'
            : code === 'EXTERNAL_AUTHORIZATION_EXPIRED'
              ? 'expired'
              : response.status === 403
                ? 'denied'
                : code === 'EXTERNAL_SOURCE_UNCONFIGURED'
                  ? 'unconfigured'
                  : code === 'EXTERNAL_SOURCE_TIMEOUT'
                    ? 'timeout'
                    : 'unavailable',
        );
        return;
      }
      const parsed = ExternalMetadataOutputSchema.safeParse(value);
      if (
        !parsed.success ||
        parsed.data.sourceId !== sourceId ||
        parsed.data.items.length > input.limit ||
        parsed.data.items.some(
          (row) => row.year < input.fromYear || row.year > input.toYear,
        )
      )
        throw new Error('invalid metadata');
      const result = parsed.data,
        count = input.offset + result.items.length;
      if (
        result.status !== (result.items.length ? 'AVAILABLE' : 'EMPTY') ||
        result.total < count ||
        (!result.items.length && result.total !== input.offset) ||
        result.nextOffset !== (count < result.total ? count : undefined) ||
        new Set(
          result.items.map((row) =>
            JSON.stringify([row.stationCode, row.year]),
          ),
        ).size !== result.items.length
      )
        throw new Error('inconsistent metadata');
      setPage(result);
      setApplied(input);
      setState(result.items.length ? 'checked' : 'empty');
    } catch {
      if (active.current === controller && !controller.signal.aborted)
        setState('unavailable');
    } finally {
      clearTimeout(timer);
      if (active.current === controller) active.current = null;
    }
  }
  const busy = state === 'loading';
  return (
    <section className={styles.panel} aria-label={copy.title}>
      <h2>
        {copy.title} <ContextHelp label={copy.help}>{copy.note}</ContextHelp>
      </h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const input = ExternalMetadataInputSchema.safeParse({
            sourceId,
            fromYear: Number(start),
            toYear: Number(end),
            offset: 0,
            limit: 25,
          });
          if (!input.success) {
            clear();
            setState('invalid');
            return;
          }
          void read(input.data);
        }}
      >
        <label>
          {copy.start}
          <input
            inputMode="numeric"
            value={start}
            onChange={(event) => {
              clear();
              setStart(event.target.value);
            }}
          />
        </label>
        <label>
          {copy.end}
          <input
            inputMode="numeric"
            value={end}
            onChange={(event) => {
              clear();
              setEnd(event.target.value);
            }}
          />
        </label>
        <button type="submit" disabled={busy}>
          {copy.query}
        </button>
        {busy ? (
          <button type="button" onClick={clear}>
            {copy.cancel}
          </button>
        ) : null}
      </form>
      <p role="status">
        <span>{copy[state]}</span>
        {page ? <span>{` · ${page.checkedAt}`}</span> : null}
      </p>
      {page && page.items.length ? (
        <>
          <div
            className={styles.table}
            tabIndex={0}
            role="region"
            aria-label={copy.title}
          >
            <table>
              <caption>
                {copy.count}: {page.items.length}
              </caption>
              <thead>
                <tr>
                  {[copy.station, copy.year, copy.province, copy.city].map(
                    (label) => (
                      <th key={label} scope="col">
                        {label}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {page.items.map((row) => (
                  <tr key={JSON.stringify([row.stationCode, row.year])}>
                    <td>{row.stationCode}</td>
                    <td>{row.year}</td>
                    <td>{row.province ?? '—'}</td>
                    <td>{row.city ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={styles.actions}>
            {page.nextOffset !== undefined && applied ? (
              <button
                type="button"
                onClick={() =>
                  void read({ ...applied, offset: page.nextOffset! })
                }
              >
                {copy.next}
              </button>
            ) : null}
            <button type="button" onClick={clear}>
              {copy.clear}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
