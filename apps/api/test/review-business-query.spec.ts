import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
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
it('binds June to governed source cells and rejects caller-selected August or whole-row text', async () => {
  const june = RelationAssertionSchema.parse({
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
        measure: null,
        unit: null,
        missing: false,
        spatialScope: null,
        limitations: [],
        reportedConclusion: null,
        context: {
          recordNature: 'REPORTED_OBSERVATION',
          locationRole: 'UNKNOWN',
          applicability: 'Source monthly report',
          timeRole: 'OBSERVATION_TIME',
          validFrom: '2019-06-01',
          validTo: '2019-06-30',
        },
      },
      generation: { method: 'SOURCE_TABLE', model: null },
      supersedesId: null,
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
  });
  const values = {
    c1: 'June 10 August 20',
    c2: 'table:1/row:1',
    c3: {
      kind: 'html_table_row',
      tableIndex: 1,
      rowIndex: 1,
      cells: [
        { column: 1, text: 'TN' },
        { column: 2, text: '10' },
        { column: 3, text: '1' },
        { column: 4, text: '20' },
      ],
    },
  };
  const client = {
    query: () =>
      Promise.resolve({
        rows: [
          {
            record_id: recordId,
            analysis_id: analysisId,
            asset_id: assetId,
            record_values: values,
          },
        ],
        rowCount: 1,
      }),
    release() {},
  };
  const check = (
    columns: number[],
    keepFields: string[],
    locator = 'table:1/row:1/column:2',
  ) => {
    const bound = {
      ...june,
      candidate: {
        ...june.candidate,
        evidence: [{ ...june.candidate.evidence[0]!, locator }],
      },
    };
    const scope = BusinessQuerySchema.parse({
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
        { recordId, assertionId, field: 'c3', columns, keepFields },
      ],
    });
    return bindBusinessRecords(
      client as never,
      [{ dataItemId, versionId, analysisId }],
      scope,
      [bound],
    ).then((pins) => projectBusinessRecord(values, pins[0]!));
  };
  await expect(check([1, 4], ['c2', 'c3'])).rejects.toThrow();
  await expect(check([2], ['c3'])).resolves.toEqual({
    c3: {
      kind: 'html_table_row',
      tableIndex: 1,
      rowIndex: 1,
      cells: [{ column: 2, text: '10' }],
      selectedColumns: [2],
    },
  });
  await expect(check([2], ['c1', 'c3'])).rejects.toThrow();
  await expect(check([2], ['c3'], 'table:1/row:1')).rejects.toThrow();
  await expect(check([2], ['c3'], 'table:1/row:2/column:2')).rejects.toThrow();
  await expect(check([2], ['c3'], 'table:1/row:1/column:4')).rejects.toThrow();
  await expect(check([4], ['c3'])).rejects.toThrow();
});
