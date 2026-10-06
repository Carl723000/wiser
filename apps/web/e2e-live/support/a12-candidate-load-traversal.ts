import {
  CandidateLoadTransportError,
  canonicalLoadContent,
  immutableLoadRequest,
  pageFingerprint,
  readFrozenCandidateInput,
  validateLoadReply,
} from './a12-candidate-load-driver.ts';
import type {
  FrozenCandidateDataset,
  LoadAction,
  LoadFailure,
  LoadPorts,
  LoadRequest,
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

interface DigestState {
  count: number;
  chain: string;
}
function fail(kind: LoadFailure): never {
  throw new CandidateLoadTransportError(kind);
}
const canonicalId = (value: string) => value.toLowerCase();
function safeFingerprint(
  fingerprint: LoadPorts['fingerprint'],
): LoadPorts['fingerprint'] {
  return (value) => {
    let digest: string;
    try {
      digest = fingerprint(value);
    } catch {
      return fail('instrumentation');
    }
    if (!/^[a-f0-9]{64}$/.test(digest)) return fail('instrumentation');
    return digest;
  };
}
function startDigest(
  action: LoadAction,
  columns: readonly { readonly key: string; readonly label: string }[],
  fingerprint: LoadPorts['fingerprint'],
): DigestState {
  return {
    count: 0,
    chain: fingerprint({
      domain: 'a12-traversal-v1',
      action,
      columns: canonicalLoadContent(columns),
    }),
  };
}
function appendDigest(
  state: DigestState,
  entry: unknown,
  fingerprint: LoadPorts['fingerprint'],
): void {
  state.chain = fingerprint({
    domain: 'a12-traversal-entry-v1',
    previous: state.chain,
    ordinal: state.count + 1,
    entry: canonicalLoadContent(entry),
  });
  state.count += 1;
}
function finishDigest(
  state: DigestState,
  fingerprint: LoadPorts['fingerprint'],
): string {
  return fingerprint({
    domain: 'a12-traversal-end-v1',
    count: state.count,
    chain: state.chain,
  });
}

/**
 * Frozen inventories and live traversals share this page-independent definition:
 * seed = SHA256({ domain: 'a12-traversal-v1', action, columns });
 * chain = SHA256({ domain: 'a12-traversal-entry-v1', previous, ordinal, entry });
 * digest = SHA256({ domain: 'a12-traversal-end-v1', count, chain }).
 * Entries are already validated candidate DTOs. Object keys are canonicalized;
 * array/column/entry order and missing/null/empty original values are preserved.
 * GeometryCollections remain one entry. The live path updates the same chain
 * incrementally and never stores the original entry arrays in its result.
 */
export function traversalContentDigest(
  action: LoadAction,
  columns: readonly { readonly key: string; readonly label: string }[],
  entries: readonly unknown[],
  fingerprint: LoadPorts['fingerprint'],
): string {
  const checkedFingerprint = safeFingerprint(fingerprint);
  const state = startDigest(action, columns, checkedFingerprint);
  for (const entry of entries) appendDigest(state, entry, checkedFingerprint);
  return finishDigest(state, checkedFingerprint);
}

async function traversePages(
  frozen: FrozenCandidateDataset,
  action: LoadAction,
  assetId: string | undefined,
  expectedCount: number,
  columns: readonly { readonly key: string; readonly label: string }[],
  expectedDigest: string,
  ports: LoadPorts,
  counted: () => void,
): Promise<string> {
  const fingerprint = safeFingerprint(ports.fingerprint);
  const state = startDigest(action, columns, fingerprint);
  // Each successful nonempty page consumes at least one frozen entry. These
  // identity/cursor sets and the request count cannot exceed that fixed count.
  const identities = new Set<string>();
  const cursors = new Set<string>();
  let previousIndex = 0;
  let after: string | undefined;
  let pageCount = 0;
  const firstPage = frozen.firstPages.find(
    (page) =>
      page.action === action &&
      page.first === 200 &&
      (page.assetId === null
        ? assetId === undefined
        : assetId !== undefined &&
          canonicalId(page.assetId) === canonicalId(assetId)),
  );
  if (firstPage === undefined) return fail('drift');
  while (true) {
    if (++pageCount > Math.max(1, expectedCount)) return fail('invalid');
    const request: LoadRequest = immutableLoadRequest({
      method: 'GET',
      action,
      reference: frozen.batch.reference,
      first: 200,
      ...(assetId === undefined ? {} : { assetId }),
      ...(after === undefined ? {} : { after }),
    });
    const checked = validateLoadReply(
      frozen,
      request,
      await ports.send(request),
    );
    if (!checked.ok) return fail(checked.failure);
    const page = checked.page;
    if (
      after === undefined &&
      pageFingerprint(page, fingerprint) !== firstPage.digest
    )
      return fail('drift');
    const entries =
      'assets' in page
        ? page.assets
        : 'records' in page
          ? page.records
          : page.features;
    if (after !== undefined && entries.length === 0) return fail('invalid');
    if (state.count + entries.length > expectedCount) return fail('drift');
    for (const entry of entries) {
      const identity = fingerprint({
        domain: 'a12-traversal-identity-v1',
        id: canonicalId('recordId' in entry ? entry.recordId : entry.assetId),
      });
      if (identities.has(identity)) return fail('invalid');
      if ('index' in entry) {
        if (entry.index <= previousIndex) return fail('invalid');
        previousIndex = entry.index;
      } else {
        const expected = frozen.batch.assets[state.count];
        if (
          expected === undefined ||
          fingerprint(canonicalLoadContent(entry)) !==
            fingerprint(canonicalLoadContent(expected))
        )
          return fail('drift');
      }
      identities.add(identity);
      appendDigest(state, entry, fingerprint);
      counted();
    }
    if (page.nextCursor === null) {
      if (state.count !== expectedCount) return fail('drift');
      const digest = finishDigest(state, fingerprint);
      if (digest !== expectedDigest) return fail('drift');
      return digest;
    }
    if (state.count >= expectedCount || page.nextCursor.length > 2048)
      return fail('invalid');
    const cursorDigest = fingerprint({
      domain: 'a12-traversal-cursor-v1',
      cursor: page.nextCursor,
    });
    if (cursors.has(cursorDigest)) return fail('invalid');
    cursors.add(cursorDigest);
    after = page.nextCursor;
  }
}

export interface CandidateSingleTraversalResult {
  readonly status: 'passed' | 'failed' | 'not_run';
  readonly reason: 'incomplete_inventory' | 'iteration_invalid' | null;
  readonly iteration: TraversalIteration | null;
}

async function traverseAdmittedOnce(
  frozen: FrozenCandidateDataset,
  ports: LoadPorts,
  ordinal: number,
): Promise<TraversalIteration> {
  const counts = { assets: 0, records: 0, geometry: 0 };
  const checks = { assets: false, records: false, geometry: false };
  let digest: string | null = null;
  let outcome: TraversalIteration['outcome'] = 'completed';
  try {
    const fingerprint = safeFingerprint(ports.fingerprint);
    const expectedAssetsDigest = traversalContentDigest(
      'get',
      [],
      frozen.batch.assets,
      fingerprint,
    );
    const assetsDigest = await traversePages(
      frozen,
      'get',
      undefined,
      frozen.batch.assets.length,
      [],
      expectedAssetsDigest,
      ports,
      () => {
        counts.assets += 1;
      },
    );
    checks.assets = true;
    const materials: {
      ordinal: number;
      records: string;
      geometry: string;
    }[] = [];
    // Preserve the frozen material inventory order, independently of its
    // relation to asset-page ordering. No material identity enters the report.
    for (const [index, material] of frozen.materials.entries()) {
      const asset = frozen.batch.assets.find(
        (item) => canonicalId(item.assetId) === canonicalId(material.assetId),
      );
      if (
        asset === undefined ||
        asset.recordCount === null ||
        asset.featureCount === null
      )
        fail('drift');
      const records = await traversePages(
        frozen,
        'records',
        material.assetId,
        asset.recordCount,
        material.columns,
        material.recordsDigest,
        ports,
        () => {
          counts.records += 1;
        },
      );
      checks.records = index + 1 === frozen.materials.length;
      const geometry = await traversePages(
        frozen,
        'geometry',
        material.assetId,
        asset.featureCount,
        [],
        material.geometryDigest,
        ports,
        () => {
          counts.geometry += 1;
        },
      );
      checks.geometry = index + 1 === frozen.materials.length;
      materials.push({ ordinal: index + 1, records, geometry });
    }
    digest = fingerprint({
      domain: 'a12-complete-traversal-v1',
      assets: assetsDigest,
      materials,
    });
  } catch (error) {
    outcome =
      error instanceof CandidateLoadTransportError ? error.kind : 'unavailable';
  }
  return { ordinal, outcome, counts, checks, digest };
}

/** One full traversal for an outer fixed round/member schedule; no retry. */
export async function runCandidateLoadTraversalOnce(
  input: unknown,
  ports: LoadPorts,
  ordinal: number,
): Promise<CandidateSingleTraversalResult> {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 20)
    return { status: 'not_run', reason: 'iteration_invalid', iteration: null };
  let admitted: ReturnType<typeof readFrozenCandidateInput>;
  try {
    admitted = readFrozenCandidateInput(input);
  } catch {
    return {
      status: 'not_run',
      reason: 'incomplete_inventory',
      iteration: null,
    };
  }
  if (admitted.status !== 'ready')
    return { status: 'not_run', reason: admitted.reason, iteration: null };
  const iteration = await traverseAdmittedOnce(admitted.input, ports, ordinal);
  return {
    status: iteration.outcome === 'completed' ? 'passed' : 'failed',
    reason: null,
    iteration,
  };
}

/** Twenty complete attempts, each compared with the same admitted inventory. */
export async function runCandidateLoadTraversal(
  input: unknown,
  ports: LoadPorts,
): Promise<CandidateTraversalResult> {
  let admitted: ReturnType<typeof readFrozenCandidateInput>;
  try {
    admitted = readFrozenCandidateInput(input);
  } catch {
    return {
      status: 'not_run',
      reason: 'incomplete_inventory',
      iterations: [],
    };
  }
  if (admitted.status !== 'ready')
    return { status: 'not_run', reason: admitted.reason, iterations: [] };
  const iterations: TraversalIteration[] = [];
  for (let ordinal = 1; ordinal <= 20; ordinal += 1) {
    const iteration = await traverseAdmittedOnce(
      admitted.input,
      ports,
      ordinal,
    );
    iterations.push(iteration);
    // Preserve all started iterations and the original fixed20 stop behavior.
    if (iteration.outcome !== 'completed')
      return { status: 'failed', reason: null, iterations };
  }
  return { status: 'passed', reason: null, iterations };
}
