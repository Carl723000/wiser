import type {
  ResourceAccessAction,
  ResourceAccessReference,
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
export function resourceGrantDiff(_input: ResourceGrantDiffInput): unknown {
  throw new Error('NOT_IMPLEMENTED');
}
