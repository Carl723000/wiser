import {
  ExplorationRecordSchema,
  ExplorationQueryInputSchema,
  type RelationAssertion,
  type ExplorationRecord,
  type ExplorationResult,
} from '@wiser/data-contracts';
const FocusSchema = ExplorationRecordSchema.pick({
  dataItemId: true,
  versionId: true,
  recordId: true,
});
export type RecordFocus = Pick<
  ExplorationRecord,
  'dataItemId' | 'versionId' | 'recordId'
>;
export function readRecordFocus(value: unknown): RecordFocus | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 512)
    throw Error('Invalid record focus');
  const parsed: unknown = JSON.parse(value);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).some(
      (k) => !['dataItemId', 'versionId', 'recordId'].includes(k),
    )
  )
    throw Error('Invalid record focus');
  return FocusSchema.parse(parsed);
}
export function withRecordFocus(
  href: string,
  focus: RecordFocus | null,
): string {
  const url = new URL(href, 'http://local');
  if (
    url.origin !== 'http://local' ||
    !/^\/(zh-CN|en)\/data-foundation\/explore$/.test(url.pathname)
  )
    throw Error('Invalid exploration route');
  if (focus)
    url.searchParams.set(
      'recordFocus',
      JSON.stringify(FocusSchema.parse(focus)),
    );
  else url.searchParams.delete('recordFocus');
  return url.pathname + url.search + url.hash;
}
export function focusRecordRequest(queryId: string, focus: RecordFocus) {
  return ExplorationQueryInputSchema.parse({
    queryId,
    versionId: focus.versionId,
    recordId: focus.recordId,
    view: 'records',
    first: 1,
  });
}
export function checkedFocusedRecord(
  result: Pick<ExplorationResult, 'records'>,
  focus: RecordFocus,
): ExplorationRecord {
  const r = result.records;
  if (
    r?.length !== 1 ||
    r[0].recordId !== focus.recordId ||
    r[0].versionId !== focus.versionId ||
    r[0].dataItemId !== focus.dataItemId
  )
    throw Error('Focused record unavailable');
  return ExplorationRecordSchema.parse(r[0]);
}

export function relationRecordFocus(
  source: Pick<RelationAssertion, 'dataItemId' | 'versionId'>,
  entity: RelationAssertion['candidate']['subject'],
): RecordFocus | null {
  if (
    entity.kind !== 'OBSERVATION' ||
    !entity.externalId?.startsWith('urn:wiser:record:')
  )
    return null;
  const pin = entity.reference ?? source;
  const parsed = FocusSchema.safeParse({
    dataItemId: pin.dataItemId,
    versionId: pin.versionId,
    recordId: entity.externalId.slice('urn:wiser:record:'.length),
  });
  return parsed.success ? parsed.data : null;
}
