'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  parseOperationEventPage,
  type OperationEventPageDto,
} from '@/lib/data-foundation';
import { getDictionary, type Locale } from '@/lib/i18n';
import {
  DataFailureState,
  DataSection,
  OperationEventList,
  SectionHeading,
} from './data-foundation-workspace';
import styles from './data-foundation-workspace.module.css';

type FailureKind =
  | 'authentication'
  | 'authorization'
  | 'not-found'
  | 'invalid-request'
  | 'unavailable'
  | 'contract';
const failureKind = (status: number): FailureKind =>
  status === 401
    ? 'authentication'
    : status === 403
      ? 'authorization'
      : status === 404
        ? 'not-found'
        : status === 400 || status === 422
          ? 'invalid-request'
          : status === 502
            ? 'contract'
            : 'unavailable';

async function boundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.headers.get('content-type')?.includes('application/json')) {
    void response.body?.cancel().catch(() => {});
    throw 'contract';
  }
  const reader = response.body?.getReader();
  if (!reader) throw 'contract';
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1_048_576) {
        abort();
        throw 'contract';
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
    } catch {
      throw 'contract';
    }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

export function OperationEventReader({
  operationId,
  initialPage,
  locale,
  children,
}: {
  readonly operationId: string;
  readonly initialPage: OperationEventPageDto;
  readonly locale: Locale;
  readonly children?: ReactNode;
}) {
  const copy = getDictionary(locale).dataFoundation.operationPage;
  const [page, setPage] = useState<OperationEventPageDto | null>(initialPage);
  const [failure, setFailure] = useState<FailureKind | null>(null);
  const [pending, setPending] = useState(false);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const status = useRef<HTMLParagraphElement>(null);
  const current = useRef({ operationId, initialPage, locale });
  const fresh =
    current.current.operationId === operationId &&
    current.current.initialPage === initialPage &&
    current.current.locale === locale;
  useEffect(() => {
    generation.current++;
    request.current?.abort();
    request.current = null;
    current.current = { operationId, initialPage, locale };
    setPage(initialPage);
    setFailure(null);
    setPending(false);
    return () => {
      generation.current++;
      request.current?.abort();
    };
  }, [operationId, initialPage, locale]);

  async function read(first: boolean) {
    if (request.current || !fresh || (!first && !page?.nextCursor)) return;
    const after = first ? undefined : page?.nextCursor;
    const lastSequence = first ? 0 : (page?.items.at(-1)?.sequence ?? 0);
    const controller = new AbortController();
    request.current = controller;
    const turn = ++generation.current;
    const timer = setTimeout(() => controller.abort(), 15_000);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject('unavailable');
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    setPending(true);
    setFailure(null);
    try {
      const work = async () => {
        const response = await fetch('/api/data-foundation/operation-events', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            operationId,
            ...(after === undefined ? {} : { after }),
          }),
        });
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          throw 'unavailable';
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw failureKind(response.status);
        }
        const value = await boundedJson(response, controller.signal);
        try {
          return parseOperationEventPage(
            value,
            operationId,
            after,
            lastSequence,
          );
        } catch {
          throw 'contract';
        }
      };
      const next = await Promise.race([work(), aborted]);
      if (turn !== generation.current || controller.signal.aborted) return;
      setPage(next);
    } catch (error) {
      if (turn !== generation.current) return;
      setPage(null);
      setFailure(
        typeof error === 'string' &&
          [
            'authentication',
            'authorization',
            'not-found',
            'invalid-request',
            'unavailable',
            'contract',
          ].includes(error)
          ? (error as FailureKind)
          : 'unavailable',
      );
    } finally {
      clearTimeout(timer);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      if (turn === generation.current) {
        request.current = null;
        setPending(false);
        status.current?.focus();
      }
    }
  }
  const visible = fresh ? page : null;
  const range =
    visible && visible.items.length > 0
      ? copy.range
          .replace('{first}', String(visible.items[0].sequence))
          .replace('{last}', String(visible.items.at(-1)!.sequence))
      : copy.noEvents;
  return (
    <>
      {visible ? children : null}
      <DataSection>
        <SectionHeading title={copy.eventsTitle} lede={copy.eventsLede} />
        <p ref={status} tabIndex={-1} role="status" aria-live="polite">
          {pending ? copy.loading : failure ? copy.failed : range}
        </p>
        {failure ? (
          <>
            <DataFailureState locale={locale} error={{ kind: failure }} />
            <p>
              {failure === 'invalid-request' || failure === 'contract'
                ? copy.restartRequired
                : copy.restartGuidance}
            </p>
          </>
        ) : visible ? (
          <>
            <OperationEventList events={visible.items} locale={locale} />
            <p>{visible.nextCursor ? copy.more : copy.end}</p>
          </>
        ) : null}
        <div className={styles.readingControls}>
          <button
            type="button"
            disabled={pending || !fresh}
            onClick={() => void read(true)}
          >
            {copy.first}
          </button>
          <button
            type="button"
            disabled={pending || !visible?.nextCursor}
            onClick={() => void read(false)}
          >
            {copy.next}
          </button>
        </div>
        <p>{copy.refreshNote}</p>
      </DataSection>
    </>
  );
}
