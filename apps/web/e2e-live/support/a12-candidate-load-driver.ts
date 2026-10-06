import type {
  IngestionCandidateAssetPage,
  IngestionCandidateBatch,
  IngestionCandidateGeometryPage,
  IngestionCandidateRecordPage,
  IngestionCandidateReference,
} from '@wiser/data-contracts';

/** This utility measures reads; it does not authorize, seed or publish data. */
export type LoadDataset = 'AUTHENTICATED-REAL' | 'SYNTHETIC-S10';
export type LoadAction = 'get' | 'records' | 'geometry';
export type LoadPage =
  | IngestionCandidateAssetPage
  | IngestionCandidateRecordPage
  | IngestionCandidateGeometryPage;
export type LoadFailure =
  | 'denied'
  | 'stale'
  | 'invalid'
  | 'unavailable'
  | 'cancelled'
  | 'drift'
  | 'instrumentation';

export interface LoadCondition {
  readonly dataset: LoadDataset;
  readonly action: LoadAction;
  readonly first: 50 | 200;
  readonly concurrency: 1 | 4 | 8;
}
export interface MaterialInventory {
  readonly assetId: string;
  readonly columns: readonly { readonly key: string; readonly label: string }[];
  readonly recordsDigest: string;
  readonly geometryDigest: string;
}
export interface FrozenCandidateDataset {
  readonly dataset: LoadDataset;
  readonly provenance: {
    readonly kind: 'standard-intake-http';
    readonly receiptSha256: string;
    readonly inventorySha256: string;
  };
  readonly batch: IngestionCandidateBatch;
  readonly materials: readonly MaterialInventory[];
  readonly firstPages: readonly {
    readonly action: LoadAction;
    readonly first: 50 | 200;
    readonly assetId: string | null;
    readonly digest: string;
  }[];
}
export type FrozenInputResult =
  | { readonly status: 'ready'; readonly input: FrozenCandidateDataset }
  | { readonly status: 'not_run'; readonly reason: 'incomplete_inventory' };

export interface LoadRequest {
  readonly method: 'GET';
  readonly action: LoadAction;
  readonly reference: IngestionCandidateReference;
  readonly first: 50 | 200;
  readonly assetId?: string;
  readonly after?: string;
}
export interface LoadReply {
  readonly boundary: 'api-http' | 'web-bff';
  readonly status: number;
  readonly contentType: string;
  readonly wireBytes: number;
  readonly body: unknown;
}
export interface LoadPorts {
  readonly send: (request: LoadRequest) => Promise<LoadReply>;
  readonly now: () => number;
  /** Inject a deterministic SHA256 implementation; never persist its input. */
  readonly fingerprint: (value: unknown) => string;
}
export type ValidatedReply =
  | {
      readonly ok: true;
      readonly page: LoadPage;
      readonly dtoBytes: number;
    }
  | { readonly ok: false; readonly failure: LoadFailure };
export interface LoadSample {
  readonly ordinal: number;
  readonly elapsedMs: number | null;
  readonly outcome: 'completed' | LoadFailure;
  readonly wireBytes: number | null;
  readonly dtoBytes: number | null;
}
export interface LoadStatistics {
  readonly completed: number;
  readonly failed: number;
  readonly medianMs: number | null;
  readonly p95Ms: number | null;
  readonly meetsLatencyTarget: boolean;
}
export interface LoadConditionResult {
  readonly condition: LoadCondition;
  readonly status: 'passed' | 'failed' | 'not_run';
  readonly reason: 'incomplete_inventory' | 'condition_invalid' | null;
  readonly warmup: readonly LoadSample[];
  readonly measured: readonly LoadSample[];
  readonly statistics: LoadStatistics;
}

export const LOAD_PAGE_BYTES = 3 * 1024 * 1024;

export function candidateLoadConditions(
  _dataset: LoadDataset,
): LoadCondition[] {
  return [];
}
export function readFrozenCandidateInput(_value: unknown): FrozenInputResult {
  return { status: 'not_run', reason: 'incomplete_inventory' };
}
export function validateLoadReply(
  _frozen: FrozenCandidateDataset,
  _request: LoadRequest,
  _reply: LoadReply,
): ValidatedReply {
  return { ok: false, failure: 'invalid' };
}
export function pageFingerprint(
  _page: LoadPage,
  _fingerprint: LoadPorts['fingerprint'],
): string {
  return '';
}
export function summarizeCandidateSamples(
  _samples: readonly LoadSample[],
): LoadStatistics {
  return {
    completed: 0,
    failed: 0,
    medianMs: null,
    p95Ms: null,
    meetsLatencyTarget: false,
  };
}
export async function runCandidateLoadCondition(
  _input: unknown,
  condition: LoadCondition,
  _ports: LoadPorts,
): Promise<LoadConditionResult> {
  return {
    condition,
    status: 'not_run',
    reason: 'incomplete_inventory',
    warmup: [],
    measured: [],
    statistics: summarizeCandidateSamples([]),
  };
}
