import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  RelationAssertionSchema,
  BusinessQuerySchema,
} from '@wiser/data-contracts';
import {
  bindBusinessRecords,
  projectBusinessRecord,
} from '../src/data-foundation/business-query-runtime.js';
const dataItemId = randomUUID(),
  versionId = randomUUID(),
  analysisId = randomUUID(),
  assetId = randomUUID(),
  recordId = randomUUID(),
  assertionId = randomUUID();
it('rejects August cell selection for a June assertion instead of trusting caller columns', async () => {
  const june = {
    assertionId,
    dataItemId,
    versionId,
    mappingVersion: 'v1',
    version: 1,
    status: 'PENDING_REVIEW',
    createdAt: '2026-09-14T00:00:00Z',
    reviews: [],
    confidence: null,
    candidate: {
      subject: {
        key: 'obs',
        label: 'June',
        kind: 'OBSERVATION',
        externalId: 'urn:wiser:record:' + recordId,
      },
      object: {
        key: 'river',
        label: 'river',
        kind: 'RIVER_REACH',
        externalId: null,
      },
      predicate: 'OBSERVES_ENTITY',
      qualifiers: {
        observedAt: '2019-06',
        context: {
          timeRole: 'OBSERVATION_TIME',
          validFrom: '2019-06-01',
          validTo: '2019-06-30',
        },
      },
      evidence: [
        {
          assetId,
          sourceHash: 'a'.repeat(64),
          locator: 'table:1/row:1/column:2',
          excerpt: 'June 10',
          polarity: 'SUPPORTS',
        },
      ],
    },
  } as any;
  const august = {
    ...june,
    assertionId: randomUUID(),
    candidate: {
      ...june.candidate,
      qualifiers: {
        observedAt: '2019-08',
        context: {
          timeRole: 'OBSERVATION_TIME',
          validFrom: '2019-08-01',
          validTo: '2019-08-31',
        },
      },
    },
  };
  const scope = {
    schemaVersion: 1,
    status: 'PENDING_REVIEW',
    revisionMode: 'current',
    filters: {
      kind: 'ALL',
      timeRole: 'OBSERVATION_TIME',
      from: '2019-06-01',
      to: '2019-06-30',
      includeUndated: false,
    },
    tableSelections: [
      {
        recordId,
        assertionId,
        field: 'c3',
        columns: [1, 4],
        keepFields: ['c2', 'c3'],
      },
    ],
  } as any;
  for (const row of [june, august]) {
    row.candidate.qualifiers = {
      measure: null,
      unit: null,
      missing: false,
      spatialScope: null,
      limitations: [],
      reportedConclusion: null,
      ...row.candidate.qualifiers,
    };
    row.candidate.qualifiers.context = {
      recordNature: 'REPORTED_OBSERVATION',
      locationRole: 'UNKNOWN',
      applicability: 'Source monthly report',
      ...row.candidate.qualifiers.context,
    };
    row.candidate.generation = { method: 'SOURCE_TABLE', model: null };
    row.candidate.supersedesId = null;
    RelationAssertionSchema.parse(row);
  }
  BusinessQuerySchema.parse(scope);
  const values = {
    c1: 'June 10 August 20',
    c2: 'row:1',
    c3: {
      kind: 'html_table_row',
      cells: [
        { column: 1, text: 'TN' },
        { column: 2, text: '10' },
        { column: 3, text: '1' },
        { column: 4, text: '20' },
      ],
    },
  };
  const client = {
    query: async () => ({
      rows: [
        {
          record_id: recordId,
          analysis_id: analysisId,
          asset_id: assetId,
          record_values: values,
        },
      ],
    }),
    release() {},
  };
  const operation = bindBusinessRecords(
    client as any,
    [{ dataItemId, versionId, analysisId }],
    scope,
    [june],
    [june, august],
  ).then((pins) => projectBusinessRecord(values, pins[0]!));
  await expect(operation).rejects.toThrow();
});
