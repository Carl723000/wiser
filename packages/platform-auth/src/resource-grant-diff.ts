import {
  resourceAccessReferenceKey,
  type ResourceAccessAction,
  type ResourceAccessReference,
  type ResourceGrantDifference,
} from '@wiser/platform-contracts';
export interface ResourceGrantWindow {
  id: string;
  resources: readonly ResourceAccessReference[];
  actions: readonly ResourceAccessAction[];
  startsAt: string;
  expiresAt: string;
}
export interface ResourceGrantDiffInput {
  resources: readonly ResourceAccessReference[];
  actions: readonly ResourceAccessAction[];
  startsAt: string;
  expiresAt: string;
  grants: readonly ResourceGrantWindow[];
}
function interval(start: string, end: string): [number, number] {
  const a = Date.parse(start),
    b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b)
    throw Error('Invalid grant interval');
  return [a, b];
}
/** Counts explicit resource/action pairs over the complete proposed interval.
 * Input grants must already be scoped to actor/project/purpose and exclude revocations.
 * This compares immutable grant records, not provider permission or actual Data availability. */
export function resourceGrantDiff(
  input: ResourceGrantDiffInput,
): ResourceGrantDifference {
  const [start, end] = interval(input.startsAt, input.expiresAt);
  const wanted = new Set(input.resources.map(resourceAccessReferenceKey));
  const windows = new Map<string, Array<[number, number]>>();
  for (const grant of input.grants) {
    const [from, to] = interval(grant.startsAt, grant.expiresAt);
    if (from >= end || to <= start) continue;
    for (const ref of grant.resources) {
      const key = resourceAccessReferenceKey(ref);
      if (!wanted.has(key)) continue;
      for (const action of grant.actions) {
        if (!input.actions.includes(action)) continue;
        const pair = JSON.stringify([key, action]),
          ranges = windows.get(pair) ?? [];
        ranges.push([Math.max(start, from), Math.min(end, to)]);
        windows.set(pair, ranges);
      }
    }
  }
  const byAction = input.actions.map((action) => {
    let added = 0,
      extended = 0,
      retained = 0;
    for (const key of wanted) {
      const ranges = windows.get(JSON.stringify([key, action]));
      if (!ranges?.length) {
        added++;
        continue;
      }
      ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let covered = start;
      for (const [a, b] of ranges) {
        if (a > covered) break;
        covered = Math.max(covered, b);
      }
      if (covered >= end) retained++;
      else extended++;
    }
    return { action, added, extended, retained };
  });
  return {
    added: byAction.reduce((n, x) => n + x.added, 0),
    extended: byAction.reduce((n, x) => n + x.extended, 0),
    retained: byAction.reduce((n, x) => n + x.retained, 0),
    removed: 0,
    byAction,
  };
}
