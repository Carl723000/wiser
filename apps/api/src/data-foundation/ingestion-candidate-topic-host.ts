import { z } from 'zod';
import { PlatformUuidSchema } from '@wiser/platform-contracts';
import {
  CANDIDATE_MONTHLY_RULE_VERSION,
  CANDIDATE_MONTHLY_RULE_VERSION_V2,
  CANDIDATE_MONTHLY_RULE_VERSION_V3,
} from '@wiser/data-core';
import type { CreateIngestionCandidateTopicInput } from '@wiser/data-contracts';
import type { CandidateTopicPinAuthorities } from './ingestion-candidate-topic-pins.js';
import {
  DataCapabilityHandlerError,
  type DataCapabilityExecutionContext,
} from './capability-handler.js';
import { readCandidateRelationPinAuthorities } from './ingestion-candidate-relations.js';

export interface CandidateTopicHostConfig {
  readonly profile: 'goal101-engineering-inspection/1';
  readonly tenantId: string;
  readonly projectId: string;
  readonly purpose: string;
}
const ConfigSchema = z.strictObject({
  profile: z.literal('goal101-engineering-inspection/1'),
  tenantId: PlatformUuidSchema.refine((id) => id === id.toLowerCase()),
  projectId: PlatformUuidSchema.refine((id) => id === id.toLowerCase()),
  // Bind an existing Auth purpose; this never creates a purpose or grant.
  purpose: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
});
const FIELDS = [
  'DATA_CANDIDATE_TOPIC_PROFILE',
  'DATA_CANDIDATE_TOPIC_TENANT_ID',
  'DATA_CANDIDATE_TOPIC_PROJECT_ID',
  'DATA_CANDIDATE_TOPIC_PURPOSE',
] as const;

/** Host startup input only; no request may populate or register this binding. */
export function loadCandidateTopicHostConfig(
  environment: NodeJS.ProcessEnv,
): CandidateTopicHostConfig | undefined {
  if (FIELDS.every((field) => environment[field] === undefined))
    return undefined;
  const parsed = ConfigSchema.safeParse({
    profile: environment[FIELDS[0]],
    tenantId: environment[FIELDS[1]],
    projectId: environment[FIELDS[2]],
    purpose: environment[FIELDS[3]],
  });
  if (!parsed.success)
    throw new Error('Invalid candidate topic host startup binding.');
  return Object.freeze(parsed.data);
}

type RulePin =
  CreateIngestionCandidateTopicInput['viewSpec']['rulePins'][number];
/** New local engineering adoption, 2026-10-08. These fixed producer digests
 * identify internal definitions, not professional standards or source grants.
 * The requirement input-version strategy remains independent of its rule pin.
 * Changed producers require explicit new recipes; old applicable recipes stay.
 * No filesystem or local pack is read by this server provider.
 */
export const CANDIDATE_TOPIC_ENGINEERING_ADOPTION = Object.freeze({
  profile: 'goal101-engineering-inspection/1',
  adoptedAt: '2026-10-08',
  basis: 'bounded candidate compatibility engineering configuration',
  projection: Object.freeze({
    // Historical adoption: this digest belongs to this frozen source revision.
    sourceRevision: 'a32ad00c148bc1de08b18cfa168e0ee9952784e2',
    source: 'packages/data-core/src/candidate-monthly-projection.ts',
    sha256: '729b83e1fe6d3e34be916278bbaacf0ccc09566591485c72d8d5d1568ae6c220',
  }),
  conversionProjection: Object.freeze({
    adoptedAt: '2026-10-09',
    version: CANDIDATE_MONTHLY_RULE_VERSION_V3,
    source: 'packages/data-core/src/candidate-monthly-projection.ts',
    sha256: '154a7a266ac49da2591408e54d6a9c1aa2dbd0bcc10ab8cec61ce501878a3258',
    basis:
      'Explicit conversion-aware producer; legacy 1.0.0 and 2.0.0 behavior retained',
  }),
  readiness: Object.freeze({
    source: 'packages/data-core/src/project-readiness.ts',
    sha256: '3b1f8b28333514e06f8e2bc0864065ebbca36402658c9d3132b0bcaeabbd1757',
  }),
  requirement: Object.freeze({
    source: 'apps/web/src/lib/spatial-readiness-facts.ts',
    sha256: '40d10fc1a5b1d27a7c617d0939c4334e70451eee1f7fd0081856815a2763612d',
    inputVersion:
      'trusted-facts-version-or-local-inspection-processing-version',
    inspectionPurpose: 'source-evidence-inspection',
  }),
  impact: Object.freeze({
    source: 'apps/web/src/lib/spatial-version-impact.ts',
    sha256: 'f1337694aa082608e313a62e063fda3ee0d93a0284f34a28ad84ad2bc1de9ba3',
  }),
});
const commonRules: readonly RulePin[] = Object.freeze([
  Object.freeze({
    kind: 'readiness',
    ruleId: 'wiser.project-readiness',
    version: 'wiser.project-readiness.v3',
  } as const),
  Object.freeze({
    kind: 'requirement',
    ruleId: 'wiser.candidate-topic.requirement-inspection',
    version: `sha256:${CANDIDATE_TOPIC_ENGINEERING_ADOPTION.requirement.sha256}`,
  } as const),
  Object.freeze({
    kind: 'impact',
    ruleId: 'wiser.candidate-topic.version-impact',
    version: `sha256:${CANDIDATE_TOPIC_ENGINEERING_ADOPTION.impact.sha256}`,
  } as const),
]);
const bundles = Object.freeze(
  [
    CANDIDATE_MONTHLY_RULE_VERSION,
    CANDIDATE_MONTHLY_RULE_VERSION_V2,
    CANDIDATE_MONTHLY_RULE_VERSION_V3,
  ].map((version) =>
    Object.freeze([
      Object.freeze({
        kind: 'projection',
        ruleId: 'beijing-monthly-docx-c3',
        version,
      } as const),
      ...commonRules,
    ]),
  ),
);
const regions = new Set([
  'bth',
  'yongding',
  'chaobai',
  'beiyun',
  'daqing-baiyangdian',
  'bohai',
]);
const needs = new Set(
  Array.from({ length: 19 }, (_, i) => `K5-${String(i + 1).padStart(3, '0')}`),
);
const key = (pin: RulePin) =>
  JSON.stringify([pin.kind, pin.ruleId, pin.version]);

/** A finite source-owned recipe, not a registry populated from caller pins. */
export function createCandidateTopicHost(
  config?: CandidateTopicHostConfig,
): CandidateTopicPinAuthorities | undefined {
  if (!config) return undefined;
  const parsed = ConfigSchema.safeParse(config);
  if (!parsed.success)
    throw new Error('Invalid candidate topic host startup binding.');
  // Copy primitives; mutation of startup input cannot retarget this host.
  const binding = Object.freeze(parsed.data);
  const assertBinding = (context: DataCapabilityExecutionContext) => {
    if (context.signal.aborted)
      throw new DataCapabilityHandlerError('CAPABILITY_TIMEOUT');
    if (
      context.authorization.tenantId !== binding.tenantId ||
      context.authorization.projectId !== binding.projectId ||
      context.authorization.purpose !== binding.purpose
    )
      throw new DataCapabilityHandlerError('NOT_FOUND');
  };
  return {
    async loadRules(_client, context, selection, pins, period) {
      assertBinding(context);
      if (
        !selection.regionIds.length ||
        !selection.needIds.length ||
        selection.regionIds.some((id) => !regions.has(id)) ||
        selection.needIds.some((id) => !needs.has(id))
      )
        throw new DataCapabilityHandlerError('NOT_FOUND');
      const requested = new Set(pins.map(key));
      const adopted = bundles.find(
        (bundle) =>
          pins.length === bundle.length &&
          requested.size === bundle.length &&
          bundle.every((pin) => requested.has(key(pin))),
      );
      if (!adopted) throw new DataCapabilityHandlerError('NOT_FOUND');
      if (
        period &&
        period.timeRole !==
          (adopted[0]!.version === CANDIDATE_MONTHLY_RULE_VERSION
            ? 'PUBLICATION'
            : 'REPORT_PERIOD')
      )
        throw new DataCapabilityHandlerError('NOT_FOUND');
      return Promise.resolve(adopted.map((pin) => ({ ...pin })));
    },
    async loadRelations(client, context, pins, references) {
      assertBinding(context);
      const actual = await readCandidateRelationPinAuthorities(
        client,
        context,
        pins,
        references,
      );
      assertBinding(context);
      return actual;
    },
    // No reliable sourceObjectKey mapping exists. Selected keys fail closed;
    // the shared whole-record and geometry material checks remain unchanged.
  };
}
