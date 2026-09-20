import { ExternalMetadataInputSchema } from '@wiser/data-contracts';
import { PlatformUuidSchema } from '@wiser/platform-contracts';
import {
  ExternalMetadataError,
  type ExternalMetadataProviderPort,
} from './external-metadata.js';

export interface ExternalMetadataHttpOptions {
  readonly sourceId: string;
  readonly endpoint: string;
  readonly authorization?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly allowInsecureLoopback?: boolean;
}

export class ExternalMetadataHttpProvider implements ExternalMetadataProviderPort {
  readonly #sourceId: string;
  readonly #endpoint: string;
  readonly #authorization: string | undefined;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  /** Trusted host configuration only. This adapter expects a normalized metadata
   * endpoint, not an arbitrary provider protocol. It never grants permission.
   * Real providers remain unconfigured until their protocol and licence are checked.
   */
  constructor(options: ExternalMetadataHttpOptions) {
    const invalid = () =>
      new Error('EXTERNAL_METADATA_HTTP_CONFIGURATION_INVALID');
    let url: URL;
    try {
      url = new URL(options.endpoint);
    } catch {
      throw invalid();
    }
    const timeoutMs = options.timeoutMs ?? 10_000;
    const maxResponseBytes = options.maxResponseBytes ?? 262_144;
    const insecureTest =
      options.allowInsecureLoopback === true &&
      url.protocol === 'http:' &&
      ['127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      !PlatformUuidSchema.safeParse(options.sourceId).success ||
      (url.protocol !== 'https:' && !insecureTest) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 30_000 ||
      !Number.isInteger(maxResponseBytes) ||
      maxResponseBytes < 1 ||
      maxResponseBytes > 1_048_576 ||
      (options.authorization !== undefined &&
        (!options.authorization ||
          options.authorization.length > 8192 ||
          /[\r\n]/u.test(options.authorization)))
    )
      throw invalid();
    this.#sourceId = options.sourceId;
    this.#endpoint = url.href;
    this.#authorization = options.authorization;
    this.#timeoutMs = timeoutMs;
    this.#maxResponseBytes = maxResponseBytes;
  }

  async readPage(
    input: Parameters<ExternalMetadataProviderPort['readPage']>[0],
  ): Promise<unknown> {
    if (input.signal.aborted) throw new ExternalMetadataError('CANCELLED');
    const parsed = ExternalMetadataInputSchema.safeParse(input.request);
    const allowedFields = new Set(['stationCode', 'year', 'province', 'city']);
    if (
      !parsed.success ||
      !input.fields.includes('stationCode') ||
      !input.fields.includes('year') ||
      input.fields.some((field) => !allowedFields.has(field)) ||
      new Set(input.fields).size !== input.fields.length
    )
      throw new ExternalMetadataError('INVALID_INPUT');
    if (parsed.data.sourceId !== this.#sourceId)
      throw new ExternalMetadataError('ACCESS_DENIED');
    const request = parsed.data;
    const url = new URL(this.#endpoint);
    url.search = new URLSearchParams({
      fromYear: String(request.fromYear),
      toYear: String(request.toYear),
      offset: String(request.offset),
      limit: String(request.limit),
      fields: input.fields.join(','),
    }).toString();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.#timeoutMs);
    const signal = AbortSignal.any([input.signal, deadline.signal]);
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        signal,
        headers: {
          accept: 'application/json',
          'cache-control': 'no-store',
          ...(this.#authorization
            ? { authorization: this.#authorization }
            : {}),
        },
      });
      if (response.status === 401 || response.status === 403)
        throw new ExternalMetadataError('SOURCE_ACCESS_DENIED');
      if (response.status !== 200)
        throw new ExternalMetadataError('SOURCE_UNAVAILABLE');
      const type = response.headers
        .get('content-type')
        ?.split(';')[0]
        ?.trim()
        .toLowerCase();
      const length = response.headers.get('content-length');
      if (
        type !== 'application/json' ||
        !response.body ||
        (length !== null &&
          (!/^\d+$/u.test(length) || Number(length) > this.#maxResponseBytes))
      )
        throw new ExternalMetadataError('INVALID_METADATA');
      // Fetch decompresses first. The stream limit therefore also bounds gzip bombs.
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > this.#maxResponseBytes)
          throw new ExternalMetadataError('INVALID_METADATA');
        chunks.push(chunk.value);
      }
      signal.throwIfAborted();
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      try {
        return JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(body),
        ) as unknown;
      } catch {
        throw new ExternalMetadataError('INVALID_METADATA');
      }
    } catch (error) {
      // Never propagate raw transport errors, URLs, provider text or credential values.
      if (input.signal.aborted) throw new ExternalMetadataError('CANCELLED');
      if (deadline.signal.aborted)
        throw new ExternalMetadataError('SOURCE_TIMEOUT');
      if (error instanceof ExternalMetadataError)
        throw new ExternalMetadataError(error.code);
      throw new ExternalMetadataError('SOURCE_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      deadline.abort();
      if (reader) {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      } else if (response?.body) {
        await response.body.cancel().catch(() => undefined);
      }
    }
  }
}
