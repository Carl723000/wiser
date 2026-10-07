import type { CandidateTopicPinAuthorities } from './ingestion-candidate-topic-pins.js';
import { DataCapabilityHandlerError } from './capability-handler.js';

export interface CandidateTopicHostConfig {
  readonly profile: 'goal101-engineering-inspection/1';
  readonly tenantId: string;
  readonly projectId: string;
  readonly purpose: string;
}

/** Red checkpoint: no unregistered rules or relationship authority can pass. */
export function loadCandidateTopicHostConfig(
  _environment: NodeJS.ProcessEnv,
): CandidateTopicHostConfig | undefined {
  return undefined;
}

export function createCandidateTopicHost(
  config?: CandidateTopicHostConfig,
): CandidateTopicPinAuthorities | undefined {
  if (!config) return undefined;
  return {
    loadRules() {
      return Promise.reject(new DataCapabilityHandlerError('EXECUTION_FAILED'));
    },
  };
}
