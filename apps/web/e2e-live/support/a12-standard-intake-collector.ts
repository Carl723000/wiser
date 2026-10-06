import type {
  CreateIngestionInputSchema,
  UploadObjectRequestSchema,
} from '@wiser/data-contracts';
import type { A12StandardIntakeHttpAdapter } from './a12-standard-intake-http.ts';
import type { CandidateOriginalHttpAdapter } from './a12-candidate-original-http.ts';
import type {
  CandidateInventoryCollector,
  CandidateInventoryCollectorOptions,
  CandidateInventoryPreparedAsset,
} from './a12-candidate-inventory-collector.ts';
import type { A12StandardIntakeCheck } from './a12-candidate-load-runner.ts';
import type { LoadDataset, LoadFailure } from './a12-candidate-load-driver.ts';

/** PRIVATE DRAFT ONLY. Not a package DTO, observed intake, or runtime certificate. */
export interface A12FreshPreparedObject {
  /** An upload alias already safe to persist; never a private original file name. */
  readonly object: ReturnType<typeof UploadObjectRequestSchema.parse>;
  readonly bytes: Uint8Array;
  /** Hash/size of the actual UPLOADED prepared bytes, not the pre-sanitize original. */
  readonly sha256: string;
  readonly sizeBytes: number;
}
export interface A12FreshIntakeOptions {
  readonly dataset: LoadDataset;
  readonly scope: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly purpose: string;
  };
  readonly prepared: readonly A12FreshPreparedObject[];
  /** Four owned UUIDs, frozen for this attempt; never generate a retry to hide failure. */
  readonly idempotencyKeys: {
    readonly createUpload: string;
    readonly completeUpload: string;
    readonly createIngestion: string;
    readonly submitIngestion: string;
  };
  /**
   * Mechanical construction of the EXISTING public DTO after generated IDs exist.
   * Its result must be descriptor-snapshotted/schema-validated and must preserve
   * exactly the generated ordered IDs, owner project and declared input use.
   * Optional sourceRegistration remains optional. This callback proves no runtime.
   */
  readonly createIngestionInput: (
    orderedAssetIds: readonly string[],
  ) => ReturnType<typeof CreateIngestionInputSchema.parse>;
  readonly api: A12StandardIntakeHttpAdapter;
  readonly original: CandidateOriginalHttpAdapter;
  /** Calls the existing 76+4+4/84-test inventory helper; does not repeat its traversal. */
  readonly createInventory: (
    input: Pick<
      CandidateInventoryCollectorOptions,
      'dataset' | 'reference' | 'prepared'
    >,
  ) => CandidateInventoryCollector;
  /**
   * Explicit bounded collection controls, NOT new A12 performance thresholds.
   * Parent must select actual values before a live run; no implicit 5s gate.
   */
  readonly maximumStatusReads: number;
  readonly maximumEventPages: number;
  readonly signal?: AbortSignal;
}
export type A12FreshIntakeResult =
  | {
      readonly status: 'collected';
      readonly prepared: readonly CandidateInventoryPreparedAsset[];
      /** Existing runner public-receipt shape, PRIVATE MEMORY ONLY; uses safe response projections. */
      readonly receiptBytes: Uint8Array;
      /** Exact frozen inventory for runner, PRIVATE MEMORY ONLY (labels/DTO reason included). */
      readonly inventoryBytes: Uint8Array;
      /** Only safe capture hashes/counts/ordinals; no signed URL/token/raw text. */
      readonly captureBytes: Uint8Array;
      /** This first slice has NO trusted normal-runtime observer. */
      readonly standardAuthority: 'unknown';
    }
  | {
      readonly status: 'not_run' | 'failed';
      readonly reason:
        | LoadFailure
        | 'incomplete_inventory'
        | 'status_bound_exhausted'
        | 'event_bound_exhausted'
        | 'submit_transport_missing'
        | 'collector_not_implemented';
      readonly attemptedHttp: number;
    };
export interface A12StandardIntakeCollector {
  readonly collect: () => Promise<A12FreshIntakeResult>;
  /**
   * Runner-compatible closure over this owner's in-memory capture register.
   * Copyable JSON, DTO validity, hashes, READY, typed callbacks, and GET200
   * cannot issue verified. Without a separately implemented trusted normal-stack
   * scan/fingerprint observation window this slice only returns unknown/rejected.
   */
  readonly verifyStandardIntake: (
    check: A12StandardIntakeCheck,
  ) => Promise<'unknown' | 'rejected'>;
  readonly close: () => void;
  readonly diagnostics: () => { activeCollections: number; closed: boolean };
}

/** Red stub. Apply only AFTER existing data.ingestion.submit transport Red/Green. */
export function createA12StandardIntakeCollector(
  _options: A12FreshIntakeOptions,
): A12StandardIntakeCollector {
  let closed = false;
  return {
    collect: () =>
      Promise.resolve({
        status: 'not_run',
        reason: 'collector_not_implemented',
        attemptedHttp: 0,
      }),
    verifyStandardIntake: () => Promise.resolve('unknown'),
    close: () => {
      closed = true;
    },
    diagnostics: () => ({ activeCollections: 0, closed }),
  };
}
