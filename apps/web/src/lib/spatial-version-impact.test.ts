import { describe, expect, it } from 'vitest';
import { versionImpact } from './spatial-version-impact';
import { syntheticReviewRecord } from './spatial-candidate-review';

describe('fixed version impact', () => {
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
  it('distinguishes new months from original revisions and allows narrow rule changes', () => {
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
