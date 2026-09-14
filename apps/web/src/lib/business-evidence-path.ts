import type { RelationAssertion } from '@wiser/data-contracts';
export interface BusinessEvidencePath {
  nodeIds: string[];
  steps: { row: RelationAssertion; forward: boolean }[];
}
export function businessEvidencePath(_rows: readonly RelationAssertion[], _from: string, _to: string): BusinessEvidencePath | null {
  return null;
}
