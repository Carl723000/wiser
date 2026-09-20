import { z } from 'zod';
import {
  businessQueryStatuses,
  type BusinessQuery,
  type RelationAssertion,
} from '@wiser/data-contracts';
import { filterRelationRows, selectRelationRevisions } from '@wiser/data-core';
import { relationVisibleSql } from '@wiser/data-infra';
import { DataCapabilityHandlerError } from './capability-handler.js';
import type { QueryAdapterPgClient } from './query-adapters.js';
import type { AnalysisVersionRef } from './exploration-views.js';
import {
  RELATION_SELECT,
  readRelationAssertion,
} from './knowledge-relation-read.js';

const invalid = () => new DataCapabilityHandlerError('VALIDATION_FAILED');
const conflict = () => new DataCapabilityHandlerError('CONFLICT');
const serverPinsSchema = z
  .array(z.tuple([z.uuid(), z.number().int().positive().max(2147483647)]))
  .max(100000);
export function storedBusinessMembership(
  spec: { scope?: 'project' | undefined },
  raw: unknown,
) {
  if (spec.scope !== 'project') return undefined;
  const parsed = serverPinsSchema.safeParse(raw);
  if (
    !parsed.success ||
    new Set(parsed.data.map(([id]) => id.toLowerCase())).size !==
      parsed.data.length
  )
    throw conflict();
  return { pins: parsed.data };
}
export async function loadBusinessRelations(
  client: QueryAdapterPgClient,
  refs: readonly AnalysisVersionRef[],
  scope: BusinessQuery,
  membership?: { pins?: [string, number][] | undefined },
) {
  const pins = membership ? membership.pins : scope.assertionPins;
  const limit = membership ? 100000 : 2000;
  const result = await client.query(
    `${RELATION_SELECT} where exists(select 1 from jsonb_array_elements($1::jsonb) ref where b.data_item_id=(ref->>'dataItemId')::uuid and b.version_id=(ref->>'versionId')::uuid)
    and a.status=any($2::text[]) and ($3::jsonb is null or exists(select 1 from jsonb_array_elements($3::jsonb) pin where b.assertion_id=(pin->>0)::uuid)) and ${relationVisibleSql()} order by b.assertion_id limit $4`,
    [
      JSON.stringify(refs),
      businessQueryStatuses(scope.status),
      pins ? JSON.stringify(pins) : null,
      limit + 1,
    ],
  );
  if (result.rows.length > limit) throw invalid();
  const all = result.rows.map(readRelationAssertion);
  const versions = new Map(all.map((row) => [row.assertionId, row.version]));
  if (
    pins &&
    (all.length !== pins.length ||
      pins.some(([id, version]) => versions.get(id) !== version))
  )
    throw conflict();
  const current = selectRelationRevisions(all, scope.revisionMode, true);
  const filtered = filterRelationRows(current.items, scope.filters);
  return {
    all,
    items: filtered.items,
    undatedCount: filtered.undatedCount,
    hiddenCount: current.hiddenCount,
  };
}
export type BusinessRecordPin = {
  dataItemId: string;
  versionId: string;
  analysisId: string;
  recordId: string;
  assetId: string;
  assertionIds: string[];
  selection?: { field: string; columns: number[]; keepFields: string[] };
};
export async function bindBusinessRecords(
  client: QueryAdapterPgClient,
  refs: readonly AnalysisVersionRef[],
  scope: BusinessQuery,
  rows: readonly RelationAssertion[],
  _allRows: readonly RelationAssertion[] = rows,
) {
  const requests = new Map<
    string,
    {
      dataItemId: string;
      versionId: string;
      analysisId: string;
      recordId: string;
      assertionIds: string[];
      evidenceAssets: string[];
    }
  >();
  for (const row of rows)
    for (const entity of [row.candidate.subject, row.candidate.object]) {
      if (!entity.externalId?.startsWith('urn:wiser:record:')) continue;
      const id = z
        .uuid()
        .safeParse(entity.externalId.slice('urn:wiser:record:'.length));
      if (!id.success) throw invalid();
      const owner = entity.reference ?? row;
      const ref = refs.find(
        (r) =>
          r.versionId === owner.versionId && r.dataItemId === owner.dataItemId,
      );
      if (!ref?.analysisId) throw conflict();
      const key = ref.versionId + id.data;
      const prior = requests.get(key);
      if (prior) {
        prior.assertionIds.push(row.assertionId);
        prior.evidenceAssets.push(
          ...row.candidate.evidence.map((e) => e.assetId),
        );
      } else
        requests.set(key, {
          dataItemId: ref.dataItemId,
          versionId: ref.versionId,
          analysisId: ref.analysisId,
          recordId: id.data,
          assertionIds: [row.assertionId],
          evidenceAssets: row.candidate.evidence.map((e) => e.assetId),
        });
    }
  const raw = [...requests.values()];
  if (!raw.length) return [];
  const found = await client.query(
    `select r.record_id,r.analysis_id,r.asset_id,r.record_values from jsonb_array_elements($1::jsonb) ref join catalog.analysis_record r on r.record_id=(ref->>'recordId')::uuid and r.analysis_id=(ref->>'analysisId')::uuid`,
    [JSON.stringify(raw)],
  );
  if (found.rows.length !== raw.length) throw conflict();
  const pins: BusinessRecordPin[] = [];
  for (const request of raw) {
    const row = found.rows.find(
      (r) =>
        r['record_id'] === request.recordId &&
        r['analysis_id'] === request.analysisId,
    );
    if (!row || !request.evidenceAssets.includes(String(row['asset_id'])))
      throw conflict();
    const selected = (scope.tableSelections ?? []).filter(
      (s) =>
        s.recordId === request.recordId &&
        request.assertionIds.includes(s.assertionId),
    );
    const pin: BusinessRecordPin = {
      dataItemId: request.dataItemId,
      versionId: request.versionId,
      analysisId: request.analysisId,
      recordId: request.recordId,
      assetId: z.uuid().parse(row['asset_id']),
      assertionIds: [...new Set(request.assertionIds)],
    };
    const containsTable = Object.values(
      z.record(z.string(), z.unknown()).parse(row['record_values']),
    ).some(
      (value) =>
        value !== null &&
        typeof value === 'object' &&
        'kind' in value &&
        value.kind === 'html_table_row',
    );
    if (
      (scope.filters.from || scope.filters.to) &&
      containsTable &&
      !selected.length
    )
      throw invalid();
    if (selected.length) {
      // Column authority comes from the pinned assertion's source-cell evidence,
      // never from a caller-supplied month/column correspondence.
      for (const selection of selected) {
        const assertion = rows.find(
          (r) => r.assertionId === selection.assertionId,
        );
        const values = z
          .record(z.string(), z.unknown())
          .parse(row['record_values']);
        const table = z
          .object({
            kind: z.literal('html_table_row'),
            tableIndex: z.number().int(),
            rowIndex: z.number().int(),
          })
          .safeParse(values[selection.field]);
        if (
          !assertion ||
          !table.success ||
          selection.keepFields.some((f) => f !== selection.field)
        )
          throw invalid();
        const allowed = new Set<number>();
        for (const evidence of assertion.candidate.evidence) {
          if (
            evidence.assetId !== pin.assetId ||
            evidence.polarity !== 'SUPPORTS' ||
            (evidence.source &&
              (evidence.source.versionId !== pin.versionId ||
                evidence.source.analysisId !== pin.analysisId ||
                evidence.source.recordId !== pin.recordId))
          )
            continue;
          const location = /^table:(\d+)\/row:(\d+)\/column:(\d+)$/.exec(
            evidence.locator,
          );
          if (
            location &&
            Number(location[1]) === table.data.tableIndex &&
            Number(location[2]) === table.data.rowIndex
          )
            allowed.add(Number(location[3]));
        }
        if (!allowed.size || selection.columns.some((c) => !allowed.has(c)))
          throw invalid();
      }
      const first = selected[0]!;
      if (
        selected.some(
          (s) =>
            s.field !== first.field ||
            JSON.stringify(s.keepFields) !== JSON.stringify(first.keepFields),
        )
      )
        throw invalid();
      pin.selection = {
        field: first.field,
        keepFields: first.keepFields,
        columns: [...new Set(selected.flatMap((s) => s.columns))].sort(
          (a, b) => a - b,
        ),
      };
      projectBusinessRecord(row['record_values'], pin);
    }
    pins.push(pin);
  }
  return pins;
}
/** Project only verified original cells; original stored content and column numbering remain intact. */
export function projectBusinessRecord(value: unknown, pin: BusinessRecordPin) {
  const raw = z.record(z.string(), z.json()).parse(value);
  if (!pin.selection) return raw;
  const selection = pin.selection;
  if (selection.keepFields.some((field) => !(field in raw))) throw invalid();
  const table = z
    .object({
      cells: z.array(
        z
          .object({
            column: z.number().int(),
            columnSpan: z.number().int().optional(),
          })
          .passthrough(),
      ),
    })
    .passthrough()
    .safeParse(raw[selection.field]);
  if (
    !table.success ||
    selection.columns.some(
      (column) =>
        !table.data.cells.some(
          (cell) => cell.column === column && (cell.columnSpan ?? 1) === 1,
        ),
    )
  )
    throw invalid();
  return z.record(z.string(), z.json()).parse({
    ...Object.fromEntries(
      Object.entries(raw).filter(([field]) =>
        selection.keepFields.includes(field),
      ),
    ),
    [selection.field]: {
      kind: 'html_table_row',
      ...(table.data['tableIndex'] === undefined
        ? {}
        : { tableIndex: table.data['tableIndex'] }),
      ...(table.data['rowIndex'] === undefined
        ? {}
        : { rowIndex: table.data['rowIndex'] }),
      cells: table.data.cells.filter((cell) =>
        selection.columns.includes(cell.column),
      ),
      selectedColumns: selection.columns,
    },
  });
}
export function businessRecordPredicate(alias: string, parameter: string) {
  return `exists(select 1 from jsonb_array_elements(${parameter}::jsonb) pin where ${alias}.analysis_id=(pin->>'analysisId')::uuid and ${alias}.asset_id=(pin->>'assetId')::uuid and ${alias}.record_id=(pin->>'recordId')::uuid)`;
}
