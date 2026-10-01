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
