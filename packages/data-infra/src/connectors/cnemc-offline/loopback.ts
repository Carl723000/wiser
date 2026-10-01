import { request as httpRequest } from 'node:http';
import {
  CNEMC_PAGE_SIZE,
  CnemcOfflineError,
  buildCnemcRequest,
  decodeCnemcResponse,
  inspectCnemcPages,
  type CnemcPage,
  type CnemcQuery,
  type CnemcRow,
} from './protocol.js';

export const SYNTHETIC_ONLINE_TOKEN = 'SYNTHETIC_ONLY_NO_PROVIDER_CREDENTIAL';
export interface CnemcLoopbackOptions {
  readonly origin: string;
  readonly timeoutMs?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
}

/** This transport cannot be enabled for a real supplier by changing a URL/token. */
export class CnemcLoopbackClient {
  readonly #origin: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  constructor(options: CnemcLoopbackOptions) {
    const invalid = () => new CnemcOfflineError('INVALID_CONFIGURATION');
    let url: URL;
    try {
      url = new URL(options.origin);
    } catch {
      throw invalid();
    }
    const timeout = options.timeoutMs ?? 2000,
      bytes = options.maxResponseBytes ?? 4_194_304;
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.port ||
      url.pathname !== '/' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !Number.isInteger(timeout) ||
      timeout < 1 ||
      timeout > 30_000 ||
      !Number.isInteger(bytes) ||
      bytes < 1 ||
      bytes > 4_194_304
    )
      throw invalid();
    this.#origin = url.origin;
    this.#timeoutMs = timeout;
    this.#maxResponseBytes = bytes;
  }

  async readPage(
    query: CnemcQuery,
    offset = 0,
    signal?: AbortSignal,
  ): Promise<CnemcPage> {
    if (signal?.aborted) throw new CnemcOfflineError('CANCELLED');
    const input = buildCnemcRequest(query, offset);
    const url = new URL(input.path, this.#origin);
    url.search = new URLSearchParams(input.query).toString();
    return new Promise<CnemcPage>((resolve, reject) => {
      let settled = false;
      const finish = (error?: CnemcOfflineError, page?: CnemcPage) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (error) reject(new CnemcOfflineError(error.code));
        else resolve(page!);
        request.destroy();
      };
      const cancel = () => finish(new CnemcOfflineError('CANCELLED'));
      const timer = setTimeout(
        () => finish(new CnemcOfflineError('SOURCE_TIMEOUT')),
        this.#timeoutMs,
      );
      const request = httpRequest(
        url,
        {
          method: input.method,
          agent: false,
          headers: {
            OnlineToken: SYNTHETIC_ONLINE_TOKEN,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': '0',
            Accept: 'application/json, application/xml, text/xml',
            'Accept-Encoding': 'identity',
            'Cache-Control': 'no-store',
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            finish(new CnemcOfflineError('SOURCE_REDIRECT'));
            return;
          }
          if (status === 401 || status === 403) {
            finish(new CnemcOfflineError('SOURCE_AUTHENTICATION'));
            return;
          }
          if (status !== 200) {
            finish(new CnemcOfflineError('SOURCE_UNAVAILABLE'));
            return;
          }
          const encoding = response.headers['content-encoding'];
          if (encoding !== undefined && encoding !== 'identity') {
            finish(new CnemcOfflineError('UNSUPPORTED_ENCODING'));
            return;
          }
          const length = response.headers['content-length'];
          if (
            length !== undefined &&
            (!/^\d+$/u.test(length) || Number(length) > this.#maxResponseBytes)
          ) {
            finish(new CnemcOfflineError('RESPONSE_TOO_LARGE'));
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            if (settled) return;
            bytes += chunk.byteLength;
            if (bytes > this.#maxResponseBytes) {
              finish(new CnemcOfflineError('RESPONSE_TOO_LARGE'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('error', () =>
            finish(new CnemcOfflineError('SOURCE_UNAVAILABLE')),
          );
          response.on('end', () => {
            if (settled) return;
            try {
              const text = new TextDecoder('utf-8', { fatal: true }).decode(
                Buffer.concat(chunks),
              );
              finish(
                undefined,
                decodeCnemcResponse(query.resource, text, offset),
              );
            } catch (error) {
              finish(
                error instanceof CnemcOfflineError
                  ? error
                  : new CnemcOfflineError('INVALID_RESPONSE'),
              );
            }
          });
        },
      );
      request.on('error', () =>
        finish(new CnemcOfflineError('SOURCE_UNAVAILABLE')),
      );
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      else request.end(input.body);
    });
  }

  async collect(
    query: CnemcQuery,
    options: { readonly signal?: AbortSignal; readonly maxPages?: number } = {},
  ) {
    buildCnemcRequest(query);
    const maximum = options.maxPages ?? 4;
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 32)
      throw new CnemcOfflineError('INVALID_QUERY');
    const pages: CnemcPage[] = [];
    for (let index = 0; index < maximum; index++) {
      try {
        pages.push(
          await this.readPage(query, index * CNEMC_PAGE_SIZE, options.signal),
        );
      } catch (error) {
        const code =
          error instanceof CnemcOfflineError
            ? error.code
            : 'SOURCE_UNAVAILABLE';
        return {
          report: inspectCnemcPages(pages, [code]),
          rows: [] as readonly CnemcRow[],
        };
      }
      const report = inspectCnemcPages(pages);
      if (report.state !== 'incomplete')
        return { report, rows: pages.flatMap((page) => page.rows) };
      if (report.issues.some((issue) => issue !== 'MISSING_PAGE'))
        return { report, rows: [] as readonly CnemcRow[] };
    }
    return {
      report: inspectCnemcPages(pages, ['PAGE_LIMIT']),
      rows: [] as readonly CnemcRow[],
    };
  }
}
