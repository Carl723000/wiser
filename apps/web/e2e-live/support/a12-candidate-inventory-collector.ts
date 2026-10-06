import type { IngestionCandidateReference } from '@wiser/data-contracts';
import type {
  FrozenCandidateDataset,
  LoadDataset,
  LoadFailure,
} from './a12-candidate-load-driver.ts';
import type { CandidateLoadHttpAdapter } from './a12-candidate-load-http.ts';

export interface CandidateInventoryPreparedAsset {
  readonly assetId: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}
export interface CandidateInventoryCollectorOptions {
  readonly dataset: LoadDataset;
  /** The reference already returned by the actual getIngestion capability. */
  readonly reference: IngestionCandidateReference;
  readonly prepared: readonly CandidateInventoryPreparedAsset[];
  /** Ownership transfers after valid construction; no other adapter is closed. */
  readonly adapter: CandidateLoadHttpAdapter;
  readonly signal?: AbortSignal;
}
export type CollectedCandidateInventory = Pick<
  FrozenCandidateDataset,
  'batch' | 'materials' | 'firstPages'
>;
export type CandidateInventoryCollectionResult =
  | {
      readonly status: 'collected';
      readonly inventory: CollectedCandidateInventory;
    }
  | {
      readonly status: 'not_run';
      readonly reason:
        LoadFailure | 'incomplete_inventory' | 'collector_not_implemented';
    };
export interface CandidateInventoryCollector {
  readonly collect: () => Promise<CandidateInventoryCollectionResult>;
  readonly close: () => void;
  readonly diagnostics: () => {
    readonly activeCollections: number;
    readonly closed: boolean;
  };
}

/**
 * Private preparation utility only. Collection is not scan/current-permission
 * admission, READY relabelling, a verified intake receipt, or formal A12.
 * This explicit Red stub has no collection implementation.
 */
export function createCandidateInventoryCollector(
  _options: CandidateInventoryCollectorOptions,
): CandidateInventoryCollector {
  let closed = false;
  return {
    collect: () =>
      Promise.resolve({
        status: 'not_run',
        reason: 'collector_not_implemented',
      }),
    close: () => {
      closed = true;
    },
    diagnostics: () => ({ activeCollections: 0, closed }),
  };
}
