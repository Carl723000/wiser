import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  RelationAssertionSchema,
  type BusinessQuery,
} from '@wiser/data-contracts';
import {
  bindBusinessRecords,
  projectBusinessRecord,
} from '../src/data-foundation/business-query-runtime.js';
const item = randomUUID(),
  version = randomUUID(),
  analysis = randomUUID(),
  asset = randomUUID(),
  record = randomUUID(),
  assertion = randomUUID();
const table = {
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
const pin = {
  dataItemId: item,
  versionId: version,
  analysisId: analysis,
  assetId: asset,
  recordId: record,
  assertionIds: [assertion],
  selection: { field: 'c3', columns: [1, 2, 3], keepFields: ['c2', 'c3'] },
};
it('returns only the source columns for the selected business period without rewriting the original row', () => {
  const result = projectBusinessRecord(table, pin);
  expect(result).not.toHaveProperty('c1');
  expect(JSON.stringify(result)).not.toContain('20');
  expect(table.c3.cells).toHaveLength(4);
  expect(result['c3']).toMatchObject({ selectedColumns: [1, 2, 3] });
});
it('rejects missing and merged original cells instead of guessing a monthly value', () => {
  expect(() =>
    projectBusinessRecord(table, {
      ...pin,
      selection: { ...pin.selection, columns: [7] },
    }),
  ).toThrow();
  expect(() =>
    projectBusinessRecord(
      {
        ...table,
        c3: { cells: [{ column: 2, columnSpan: 3, text: 'merged' }] },
      },
      pin,
    ),
  ).toThrow();
});
it('requires source-cell bindings for dated tables even when only one declared period is visible', async () => {
  const scope: BusinessQuery = {
    schemaVersion: 1,
    status: 'PENDING_REVIEW',
    revisionMode: 'current',
    filters: {
      kind: 'ALL',
      timeRole: 'ALL',
      from: '2019-06-01',
      to: '2019-06-30',
      includeUndated: false,
    },
  };
  const relation = RelationAssertionSchema.parse({
    assertionId: assertion,
    dataItemId: item,
    versionId: version,
    mappingVersion: 'v1',
    version: 1,
    status: 'PENDING_REVIEW',
    createdAt: '2026-09-14T00:00:00Z',
    confidence: null,
    reviews: [],
    candidate: {
      subject: {
        key: 'obs',
        label: 'June mean',
        kind: 'OBSERVATION',
        externalId: 'urn:wiser:record:' + record,
      },
      predicate: 'OBSERVES_ENTITY',
      object: {
        key: 'river',
        label: 'Yongding',
        kind: 'RIVER_REACH',
        externalId: null,
      },
      qualifiers: {
        measure: null,
        unit: null,
        observedAt: '2019-06',
        spatialScope: null,
        missing: false,
        limitations: [],
        reportedConclusion: null,
      },
      generation: { method: 'SOURCE_TABLE', model: null },
      evidence: [
        {
          assetId: asset,
          sourceHash: 'a'.repeat(64),
          locator: 'table1/row1',
          excerpt: null,
          polarity: 'SUPPORTS',
        },
      ],
      supersedesId: null,
    },
  });
  const client = {
    query: vi.fn(() =>
      Promise.resolve({
        rows: [
          {
            record_id: record,
            analysis_id: analysis,
            asset_id: asset,
            record_values: table,
          },
        ],
        rowCount: 1,
      }),
    ),
    release: vi.fn(),
  };
  await expect(
    bindBusinessRecords(
      client,
      [{ dataItemId: item, versionId: version, analysisId: analysis }],
      scope,
      [relation],
      [
        relation,
        {
          ...relation,
          candidate: {
            ...relation.candidate,
            qualifiers: {
              ...relation.candidate.qualifiers,
              observedAt: '2019-08',
            },
          },
        },
      ],
    ),
  ).rejects.toThrow();
  client.query.mockResolvedValue({
    rows: [
      {
        record_id: record,
        analysis_id: analysis,
        asset_id: asset,
        record_values: {
          ...table,
          c1: 'June 10',
          c3: { ...table.c3, cells: table.c3.cells.slice(0, 3) },
        },
      },
    ],
    rowCount: 1,
  });
  await expect(
    bindBusinessRecords(
      client,
      [{ dataItemId: item, versionId: version, analysisId: analysis }],
      scope,
      [relation],
      [relation],
    ),
  ).rejects.toThrow();
});
