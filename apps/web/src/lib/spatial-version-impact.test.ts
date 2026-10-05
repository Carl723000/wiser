import { describe, expect, it } from 'vitest';
import { versionImpact } from './spatial-version-impact';
import { syntheticReviewRecord } from './spatial-candidate-review';

describe('fixed version impact', () => {
  it.each(['original-revised', 'rule-changed'] as const)(
    'does not narrow a shared %s to the supplied record hint',
    (reason) => {
      const record = syntheticReviewRecord();
      const sibling = { ...record, id: 'same-fixed-input-sibling' };
      const unrelated = {
        ...record,
        id: 'different-fixed-input',
        sourceId: 'unrelated-source',
        positions: [],
      };
      const before = JSON.stringify([record, sibling, unrelated]);
      const impact = versionImpact(
        [record, sibling, unrelated],
        [
          {
            sourceId: record.sourceId,
            previousVersionId: record.versionId,
            nextVersionId: record.versionId,
            previousProcessingVersion: record.processingVersion,
            reason,
            scope: { kind: 'records', recordIds: [record.id] },
          },
        ],
        [],
      );
      expect(impact.recordIds).toEqual([record.id, sibling.id]);
      expect(impact.findings.map((finding) => finding.reason)).toEqual([
        reason,
        reason,
      ]);
      expect(JSON.stringify([record, sibling, unrelated])).toBe(before);
    },
  );
  it('keeps a shared geometry revision complete despite a position correction hint', () => {
    const record = syntheticReviewRecord();
    const position = record.positions[0];
    const sibling = {
      ...record,
      id: 'other-geometry-dependent',
      positions: [{ ...position, id: 'other-dependent-position' }],
    };
    const impact = versionImpact(
      [record, sibling],
      [
        {
          sourceId: position.geometrySourceId!,
          previousVersionId: position.geometryVersionId!,
          nextVersionId: 'new-geometry-version',
          reason: 'geometry-revised',
          scope: {
            kind: 'positions',
            recordId: record.id,
            positionIds: [position.id],
          },
        },
      ],
      [],
    );
    expect(impact.recordIds).toEqual([record.id, sibling.id]);
    expect(impact.positionIds).toEqual([
      position.id,
      'other-dependent-position',
    ]);
  });
  it('keeps a single-record correction narrow across the complete frozen input', () => {
    const record = syntheticReviewRecord();
    const sibling = {
      ...record,
      id: 'same-source-other-record',
      objectId: 'other-object',
      positions: [{ ...record.positions[0], id: 'other-position' }],
    };
    const records = [record, sibling];
    const before = JSON.stringify(records);
    const change = {
      sourceId: record.sourceId,
      previousVersionId: record.versionId,
      nextVersionId: 'corrected',
      reason: 'record-corrected' as const,
      scope: { kind: 'records' as const, recordIds: [record.id] },
    };
    const topics = [record, sibling].map((item) => ({
      id: `topic-${item.id}`,
      title: item.objectLabel,
      regionIds: item.regionIds,
      sourceIds: [item.sourceId],
      recordIds: [item.id],
      question: 'Synthetic fixed input',
      gaps: [],
    }));
    const result = versionImpact(records, [change], topics);
    expect(result.recordIds).toEqual([record.id]);
    expect(result.objectIds).toEqual([record.objectId]);
    expect(result.positionIds).toEqual(record.positions.map((item) => item.id));
    expect(result.topicIds).toEqual([`topic-${record.id}`]);
    expect(JSON.stringify(records)).toBe(before);
  });
  it('limits a position correction to its exact record and position reference', () => {
    const record = syntheticReviewRecord();
    const position = record.positions[0];
    const selected = {
      ...record,
      positions: [position, { ...position, id: 'another-position' }],
    };
    const sibling = {
      ...record,
      id: 'same-reference-other-record',
      positions: [{ ...position, id: 'another-record-position' }],
    };
    const change = {
      sourceId: position.geometrySourceId!,
      previousVersionId: position.geometryVersionId!,
      nextVersionId: 'position-corrected',
      reason: 'position-corrected' as const,
      scope: {
        kind: 'positions' as const,
        recordId: record.id,
        positionIds: [position.id],
      },
    };
    const result = versionImpact([selected, sibling], [change], []);
    expect(result.recordIds).toEqual([record.id]);
    expect(result.positionIds).toEqual([position.id]);
  });
  it('does not widen empty or mismatched fixed correction scopes', () => {
    const record = syntheticReviewRecord();
    const change = {
      sourceId: record.sourceId,
      previousVersionId: record.versionId,
      nextVersionId: 'corrected',
      reason: 'record-corrected' as const,
      scope: { kind: 'records' as const, recordIds: [] as string[] },
    };
    expect(versionImpact([record], [change], []).recordIds).toEqual([]);
    expect(
      versionImpact(
        [record],
        [{ ...change, scope: { kind: 'records', recordIds: ['absent'] } }],
        [],
      ).recordIds,
    ).toEqual([]);
  });
  it.each([{ positionIds: [] }, { positionIds: ['absent-position'] }])(
    'keeps an explicit position scope $positionIds empty when it selects no fixed reference',
    ({ positionIds }) => {
      const record = syntheticReviewRecord();
      expect(
        versionImpact(
          [record],
          [
            {
              sourceId: record.sourceId,
              previousVersionId: record.versionId,
              nextVersionId: 'corrected',
              reason: 'position-corrected',
              scope: { kind: 'positions', recordId: record.id, positionIds },
            },
          ],
          [],
        ).recordIds,
      ).toEqual([]);
    },
  );
  it.each([
    { reason: 'record-corrected', hint: 'missing' },
    { reason: 'record-corrected', hint: 'mismatched' },
    { reason: 'position-corrected', hint: 'missing' },
    { reason: 'position-corrected', hint: 'mismatched' },
  ] as const)(
    'conservatively checks fixed dependents when $reason has a $hint scope',
    ({ reason, hint }) => {
      const record = syntheticReviewRecord();
      const sibling = {
        ...record,
        id: 'same-source-sibling',
        objectId: 'same-source-other-object',
        positions: [{ ...record.positions[0], id: 'sibling-position' }],
      };
      const geometryDependent = {
        ...record,
        id: 'other-source-geometry-dependent',
        sourceId: 'other-business-source',
        versionId: 'other-business-version',
        objectId: 'other-business-object',
        positions: [
          {
            ...record.positions[0],
            id: 'fixed-geometry-reference',
            geometrySourceId: record.sourceId,
            geometryVersionId: record.versionId,
          },
          {
            ...record.positions[0],
            id: 'unrelated-geometry-reference',
            geometrySourceId: 'unrelated-geometry-source',
            geometryVersionId: record.versionId,
          },
        ],
      };
      const records = [
        record,
        sibling,
        geometryDependent,
        {
          ...record,
          id: 'other-source',
          sourceId: 'unrelated-source',
          positions: [],
        },
        {
          ...record,
          id: 'other-version',
          versionId: 'unrelated-version',
          positions: [],
        },
      ];
      const topics = records.map((item) => ({
        id: `topic-${item.id}`,
        title: item.objectLabel,
        regionIds: item.regionIds,
        sourceIds: [item.sourceId],
        recordIds: [item.id],
        question: 'Synthetic fixed dependent',
        gaps: [],
      }));
      const change = {
        sourceId: record.sourceId,
        previousVersionId: record.versionId,
        nextVersionId: record.versionId,
        reason,
      };
      const mismatchedScope =
        reason === 'record-corrected'
          ? {
              kind: 'positions' as const,
              recordId: record.id,
              positionIds: record.positions.map((position) => position.id),
            }
          : { kind: 'records' as const, recordIds: [record.id] };
      const changes = [
        hint === 'missing' ? change : { ...change, scope: mismatchedScope },
      ];
      const before = JSON.stringify({ records, changes, topics });
      const result = versionImpact(records, changes, topics);
      expect(result).toEqual({
        recordIds: [record.id, sibling.id, geometryDependent.id],
        objectIds: [
          record.objectId,
          sibling.objectId,
          geometryDependent.objectId,
        ],
        positionIds: [
          record.positions[0].id,
          'sibling-position',
          'fixed-geometry-reference',
        ],
        needIds: record.needIds,
        regionIds: record.regionIds,
        topicIds: [
          `topic-${record.id}`,
          `topic-${sibling.id}`,
          `topic-${geometryDependent.id}`,
        ],
        findings: [record, sibling, geometryDependent].map((item) => ({
          recordId: item.id,
          sourceId: record.sourceId,
          reason,
        })),
      });
      expect(JSON.stringify({ records, changes, topics })).toBe(before);
    },
  );
  it.each([
    { reason: 'new-period', previous: 'existing' },
    { reason: 'record-corrected', previous: null },
    { reason: 'position-corrected', previous: null },
  ] as const)(
    'keeps $reason without a replaced fixed version outside dependency invalidation',
    ({ reason, previous }) => {
      const record = syntheticReviewRecord();
      const result = versionImpact(
        [record],
        [
          {
            sourceId: record.sourceId,
            previousVersionId: previous === null ? null : record.versionId,
            nextVersionId: 'new-version',
            reason,
          },
        ],
        [],
      );
      expect(result.recordIds).toEqual([]);
      expect(result.findings).toEqual([]);
    },
  );
  it('keeps a withdrawn source invalidation complete despite a narrow correction hint', () => {
    const record = syntheticReviewRecord();
    const sibling = { ...record, id: 'also-withdrawn' };
    const change = {
      sourceId: record.sourceId,
      previousVersionId: record.versionId,
      nextVersionId: null,
      reason: 'rights-withdrawn' as const,
      scope: { kind: 'records' as const, recordIds: [record.id] },
    };
    expect(versionImpact([record, sibling], [change], []).recordIds).toEqual([
      record.id,
      sibling.id,
    ]);
  });
  it('propagates changed original evidence to record, map, demand use and topic package', () => {
    const record = syntheticReviewRecord();
    const result = versionImpact(
      [record],
      [
        {
          sourceId: record.sourceId,
          previousVersionId: record.versionId,
          nextVersionId: 'v2',
          reason: 'original-revised',
        },
      ],
      [
        {
          id: 'topic',
          title: 'Topic',
          regionIds: ['chaobai'],
          sourceIds: [record.sourceId],
          recordIds: [record.id],
          question: 'Question',
          gaps: [],
        },
      ],
    );
    expect(result.recordIds).toEqual([record.id]);
    expect(result.objectIds).toEqual([record.objectId]);
    expect(result.needIds).toEqual(record.needIds);
    expect(result.topicIds).toEqual(['topic']);
    expect(result.findings[0].reason).toBe('original-revised');
  });
  it('a reference geometry revision invalidates dependents, independently of their own source version', () => {
    const record = syntheticReviewRecord();
    const position = record.positions[0];
    const result = versionImpact(
      [record],
      [
        {
          sourceId: position.geometrySourceId!,
          previousVersionId: position.geometryVersionId!,
          nextVersionId: 'g2',
          reason: 'geometry-revised',
        },
      ],
      [],
    );
    expect(result.recordIds).toEqual([record.id]);
    expect(result.positionIds).toContain(position.id);
  });
  it('distinguishes new months and restricts a rule change to its processing version', () => {
    const record = syntheticReviewRecord();
    expect(
      versionImpact(
        [record],
        [
          {
            sourceId: 'new-month',
            previousVersionId: null,
            nextVersionId: 'new',
            reason: 'new-period',
          },
        ],
        [],
      ).recordIds,
    ).toEqual([]);
    const other = {
      ...record,
      id: 'other',
      processingVersion: 'different-rule',
    };
    const result = versionImpact(
      [record, other],
      [
        {
          sourceId: record.sourceId,
          previousVersionId: record.versionId,
          nextVersionId: record.versionId,
          reason: 'rule-changed',
          previousProcessingVersion: record.processingVersion,
        },
      ],
      [],
    );
    expect(result.recordIds).toEqual([record.id]);
  });
  it('propagates a geometry processing-rule change using the referenced source and fixed version', () => {
    const record = syntheticReviewRecord();
    const position = record.positions[0];
    const dependent = {
      ...record,
      processingVersion: 'independent-monthly-parser',
      positions: [
        position,
        {
          ...position,
          id: 'other-reference',
          geometrySourceId: 'unrelated-geometry-source',
        },
      ],
    };
    const before = JSON.stringify(dependent);
    const result = versionImpact(
      [dependent],
      [
        {
          sourceId: position.geometrySourceId!,
          previousVersionId: position.geometryVersionId!,
          nextVersionId: position.geometryVersionId!,
          reason: 'rule-changed',
          previousProcessingVersion: 'geometry-conversion-rule',
        },
      ],
      [
        {
          id: 'dependent-topic',
          title: 'Synthetic dependent topic',
          regionIds: dependent.regionIds,
          sourceIds: [dependent.sourceId],
          recordIds: [dependent.id],
          question: 'Synthetic question',
          gaps: [],
        },
      ],
    );
    expect(result.recordIds).toEqual([dependent.id]);
    expect(result.objectIds).toEqual([dependent.objectId]);
    expect(result.positionIds).toEqual([position.id]);
    expect(result.needIds).toEqual(dependent.needIds);
    expect(result.regionIds).toEqual(dependent.regionIds);
    expect(result.topicIds).toEqual(['dependent-topic']);
    expect(result.findings).toEqual([
      {
        recordId: dependent.id,
        sourceId: position.geometrySourceId!,
        reason: 'rule-changed',
      },
    ]);
    expect(JSON.stringify(dependent)).toBe(before);
  });
  it('includes every matching geometry reference without widening unrelated source or version scopes', () => {
    const record = syntheticReviewRecord();
    const position = record.positions[0];
    const matching = {
      ...record,
      positions: [position, { ...position, id: 'second-reference' }],
    };
    const wrongVersion = {
      ...record,
      id: 'wrong-geometry-version',
      positions: [{ ...position, geometryVersionId: 'different-version' }],
    };
    const wrongSource = {
      ...record,
      id: 'wrong-geometry-source',
      positions: [{ ...position, geometrySourceId: 'different-source' }],
    };
    const change = {
      sourceId: position.geometrySourceId!,
      previousVersionId: position.geometryVersionId!,
      nextVersionId: position.geometryVersionId!,
      reason: 'rule-changed' as const,
    };
    const result = versionImpact(
      [matching, wrongVersion, wrongSource],
      [change, change],
      [],
    );
    expect(result.recordIds).toEqual([matching.id]);
    expect(result.positionIds).toEqual([position.id, 'second-reference']);
    expect(result.findings).toHaveLength(1);
  });
  it('keeps rule changes narrow for own records without a matching geometry dependency', () => {
    const record = syntheticReviewRecord();
    const oldRule = { ...record, positions: [] };
    const otherRule = {
      ...oldRule,
      id: 'other-own-rule',
      processingVersion: 'different-rule',
    };
    const result = versionImpact(
      [oldRule, otherRule],
      [
        {
          sourceId: record.sourceId,
          previousVersionId: record.versionId,
          nextVersionId: record.versionId,
          reason: 'rule-changed',
          previousProcessingVersion: record.processingVersion,
        },
      ],
      [],
    );
    expect(result.recordIds).toEqual([oldRule.id]);
    expect(result.positionIds).toEqual([]);
  });
  it('deduplicates overlapping impacts and does not mutate records', () => {
    const record = syntheticReviewRecord();
    const frozen = JSON.stringify(record);
    const change = {
      sourceId: record.sourceId,
      previousVersionId: record.versionId,
      nextVersionId: null,
      reason: 'source-missing' as const,
    };
    const result = versionImpact(
      [record],
      [change, { ...change, reason: 'rights-withdrawn' }],
      [],
    );
    expect(result.recordIds).toHaveLength(1);
    expect(result.findings).toHaveLength(2);
    expect(JSON.stringify(record)).toBe(frozen);
  });
});
