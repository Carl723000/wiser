import type { z } from 'zod';
import { DATA_CAPABILITY_REGISTRY } from '@wiser/data-contracts';
import { CandidateLoadTransportError } from './a12-candidate-load-driver.ts';

export type A12StandardIntakeCapability =
  | 'data.uploadSession.create'
  | 'data.uploadSession.complete'
  | 'data.ingestion.create'
  | 'data.ingestion.get'
  | 'data.operation.get'
  | 'data.operation.events';
export type A12StandardIntakeBody<C extends A12StandardIntakeCapability> =
  z.output<(typeof DATA_CAPABILITY_REGISTRY)[C]['outputSchema']>;
export interface A12StandardIntakeHttpOptions {
  readonly apiOrigin: string;
  readonly taskApiPort: number;
  readonly storageOrigin: string;
  readonly taskStoragePort: number;
  readonly tenantId: string;
  readonly projectId: string;
  readonly purpose: string;
  readonly accessToken: () => Promise<string>;
  readonly signal?: AbortSignal;
}
export interface A12StandardIntakeRequest<
  C extends A12StandardIntakeCapability,
> {
  readonly capabilityId: C;
  readonly input: unknown;
  readonly idempotencyKey?: string;
  readonly ifMatch?: string;
}
export interface A12StandardIntakeReply<C extends A12StandardIntakeCapability> {
  readonly capabilityId: C;
  readonly status: number;
  readonly contentType: string;
  readonly wireBytes: number;
  readonly wireSha256: string;
  /** Live in-memory DTO only. Use the explicit projection before persistence. */
  readonly body: A12StandardIntakeBody<C>;
}
export interface A12StandardIntakePutInput {
  readonly target: unknown;
  readonly bytes: Uint8Array;
  readonly sizeBytes: number;
  readonly sha256: string;
}
export interface A12StandardIntakePutReply {
  readonly status: number;
  readonly requestBytes: number;
  readonly requestSha256: string;
  readonly wireBytes: number;
  readonly wireSha256: string;
  readonly etag: string | null;
}
export interface A12StandardIntakeProjection<
  C extends A12StandardIntakeCapability,
> {
  readonly kind: 'redacted-actual-http-projection';
  readonly capabilityId: C;
  readonly status: number;
  readonly wireBytes: number;
  readonly wireSha256: string;
  readonly projectionSha256: string;
  readonly redactedFields: readonly string[];
  readonly body: A12StandardIntakeBody<C>;
}
export interface A12StandardIntakeHttpAdapter {
  readonly send: <C extends A12StandardIntakeCapability>(
    request: A12StandardIntakeRequest<C>,
  ) => Promise<A12StandardIntakeReply<C>>;
  readonly put: (
    input: A12StandardIntakePutInput,
  ) => Promise<A12StandardIntakePutReply>;
  readonly close: () => void;
  readonly diagnostics: () => { activeRequests: number; closed: boolean };
}

/** Explicit Red recovery stub. No HTTP/scanner evidence is fabricated. */
export function createA12StandardIntakeHttpAdapter(
  _options: A12StandardIntakeHttpOptions,
): A12StandardIntakeHttpAdapter {
  let closed = false;
  return {
    send: () => Promise.reject(new CandidateLoadTransportError('unavailable')),
    put: () => Promise.reject(new CandidateLoadTransportError('unavailable')),
    close: () => {
      closed = true;
    },
    diagnostics: () => ({ activeRequests: 0, closed }),
  };
}

export function redactA12StandardIntakeReply<
  C extends A12StandardIntakeCapability,
>(_reply: A12StandardIntakeReply<C>): A12StandardIntakeProjection<C> {
  throw new CandidateLoadTransportError('unavailable');
}
