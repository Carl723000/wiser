import type {
  LoadAction,
  LoadFailure,
  LoadPorts,
} from './a12-candidate-load-driver.ts';

export interface TraversalIteration {
  readonly ordinal: number;
  readonly outcome: 'completed' | LoadFailure;
  readonly counts: {
    readonly assets: number;
    readonly records: number;
    readonly geometry: number;
  };
  readonly checks: {
    readonly assets: boolean;
    readonly records: boolean;
    readonly geometry: boolean;
  };
  readonly digest: string | null;
}
export interface CandidateTraversalResult {
  readonly status: 'passed' | 'failed' | 'not_run';
  readonly reason: 'incomplete_inventory' | null;
  readonly iterations: readonly TraversalIteration[];
}

/**
 * Frozen inventories and live traversals share this page-independent definition:
 * seed = SHA256({ domain: 'a12-traversal-v1', action, columns });
 * chain = SHA256({ domain: 'a12-traversal-entry-v1', previous, ordinal, entry });
 * digest = SHA256({ domain: 'a12-traversal-end-v1', count, chain }).
 * Object keys are canonicalized; array/column/entry order and missing/null/empty
 * original values are preserved. GeometryCollections remain one entry.
 */
export function traversalContentDigest(
  _action: LoadAction,
  _columns: readonly { readonly key: string; readonly label: string }[],
  _entries: readonly unknown[],
  _fingerprint: LoadPorts['fingerprint'],
): string {
  throw new Error('A12 complete traversal digest behavior is pending');
}

/** Twenty attempts; only the existing public candidate GET actions are used. */
export async function runCandidateLoadTraversal(
  _input: unknown,
  _ports: LoadPorts,
): Promise<CandidateTraversalResult> {
  throw new Error('A12 complete traversal behavior is pending');
}
