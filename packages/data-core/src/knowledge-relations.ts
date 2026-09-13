import {
  RelationCandidateSchema,
  RelationEntitySchema,
  type RelationCandidate,
} from '@wiser/data-contracts';

export function assertRelationEntityConsistency(
  entities: readonly unknown[],
): void {
  const seen = new Map<string, string>();
  for (const raw of entities) {
    const entity = RelationEntitySchema.parse(raw),
      value = JSON.stringify(entity),
      old = seen.get(entity.key);
    if (old && old !== value) throw Error('Conflicting source entity');
    seen.set(entity.key, value);
  }
}

/** Stable identity within the separately bound source Version. No cross-source merge. */
export function groupRelationCandidates(
  rows: readonly unknown[],
): readonly { identity: string; candidate: RelationCandidate }[] {
  const parsed = rows.map((row) => RelationCandidateSchema.parse(row));
  for (const row of parsed) assertTypedRelation(row);
  assertRelationEntityConsistency(
    parsed.flatMap((row) => [row.subject, row.object]),
  );
  const grouped = new Map<
    string,
    {
      base: string;
      candidate: RelationCandidate;
      evidence: Map<string, RelationCandidate['evidence'][number]>;
    }
  >();
  for (const row of parsed) {
    const candidate = RelationCandidateSchema.parse(row);
    const identity = JSON.stringify([
      candidate.subject.key,
      candidate.predicate,
      candidate.object.key,
    ]);
    const { evidence, ...attributes } = candidate;
    const base = JSON.stringify(attributes);
    const existing = grouped.get(identity);
    if (existing && existing.base !== base)
      throw new Error('Conflicting relation candidate');
    const group = existing ?? { base, candidate, evidence: new Map() };
    for (const item of evidence) group.evidence.set(JSON.stringify(item), item);
    if (group.evidence.size > 64)
      throw new Error('Too many evidence locations');
    grouped.set(identity, group);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([identity, g]) => ({
      identity,
      candidate: {
        ...g.candidate,
        evidence: [...g.evidence.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([, e]) => e),
      },
    }));
}

/** Versioned code registry: new types share intake/review mechanics, never arbitrary LLM strings. */
export const KNOWLEDGE_RELATION_RULES = {
  EXPRESSES_CLAIM: { subjects: ['PERSON', 'ORGANIZATION'], objects: ['CLAIM'] },
  REPORTS_CLAIM: { subjects: ['DOCUMENT'], objects: ['CLAIM'] },
  ABOUT_ENTITY: {
    subjects: ['CLAIM', 'EVENT', 'DOCUMENT', 'POLICY', 'MODEL_RUN'],
    objects: null,
  },
  OBSERVES_ENTITY: {
    subjects: ['OBSERVATION'],
    objects: [
      'MONITORING_POINT',
      'RIVER_REACH',
      'BASIN',
      'PLACE',
      'ENTERPRISE',
      'EXTERNAL_ENTITY',
    ],
  },
  OCCURRED_IN: {
    subjects: ['EVENT'],
    objects: ['RIVER_REACH', 'BASIN', 'PLACE'],
  },
  CITES_SOURCE: { subjects: ['DOCUMENT', 'CLAIM'], objects: ['DOCUMENT'] },
  DERIVED_FROM: {
    subjects: ['DOCUMENT', 'CLAIM', 'OBSERVATION', 'MODEL_RUN'],
    objects: ['DOCUMENT', 'OBSERVATION', 'MODEL_RUN', 'EXTERNAL_ENTITY'],
  },
  APPLIES_TO: { subjects: ['POLICY', 'CLAIM'], objects: null },
  USES_DATA: {
    subjects: ['MODEL_RUN'],
    objects: ['DOCUMENT', 'OBSERVATION', 'EXTERNAL_ENTITY'],
  },
} as const;

function assertTypedRelation(row: RelationCandidate): void {
  const rule = (
    KNOWLEDGE_RELATION_RULES as Readonly<
      Record<
        string,
        {
          subjects: readonly string[];
          objects: readonly string[] | null;
        }
      >
    >
  )[row.predicate];
  // Legacy relation semantics remain unchanged for existing clients.
  if (!rule) {
    const legacyKinds = [
      'ENTERPRISE',
      'MONITORING_POINT',
      'INDICATOR_RECORD',
      'RIVER_REACH',
      'BASIN',
      'EXTERNAL_ENTITY',
    ];
    if (
      !legacyKinds.includes(row.subject.kind) ||
      !legacyKinds.includes(row.object.kind)
    ) {
      throw Error('Extended entities require a registered knowledge predicate');
    }
    return;
  }
  if (!row.qualifiers.context)
    throw Error('Knowledge relation requires explicit context');
  if (
    !rule.subjects.includes(row.subject.kind) ||
    (rule.objects && !rule.objects.includes(row.object.kind))
  ) {
    throw Error('Invalid knowledge relation endpoint types');
  }
  const context = row.qualifiers.context;
  if (
    context.recordNature !== 'REPORTED_OBSERVATION' &&
    context.timeRole === 'OBSERVATION_TIME'
  ) {
    throw Error('Non-observation cannot use observation time');
  }
  if (
    row.predicate === 'OBSERVES_ENTITY' &&
    context.recordNature !== 'REPORTED_OBSERVATION'
  ) {
    throw Error('Observed relation requires reported observation');
  }
}
