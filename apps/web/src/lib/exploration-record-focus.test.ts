import { expect, it } from 'vitest';
import {
  readRecordFocus,
  withRecordFocus,
  focusRecordRequest,
  checkedFocusedRecord,
} from './exploration-record-focus';
const focus = {
  dataItemId: '20000000-0000-4000-8000-000000000001',
  versionId: '30000000-0000-4000-8000-000000000001',
  recordId: '40000000-0000-4000-8000-000000000001',
};
it('round trips a bounded record identity without source values or authority claims', () => {
  const href = withRecordFocus(
    '/zh-CN/data-foundation/explore?query=q&view=map',
    focus,
  );
  expect(
    readRecordFocus(
      new URL(href, 'http://localhost').searchParams.get('recordFocus'),
    ),
  ).toEqual(focus);
  expect(withRecordFocus(href, null)).toBe(
    '/zh-CN/data-foundation/explore?query=q&view=map',
  );
  for (const bad of [
    'x'.repeat(513),
    JSON.stringify({ ...focus, geometry: {} }),
    JSON.stringify({ ...focus, versionId: 'bad' }),
    [JSON.stringify(focus)],
  ])
    expect(() => readRecordFocus(bad)).toThrow();
  expect(readRecordFocus(undefined)).toBeNull();
});
it('pins the actual record lookup to the freshly authorized query and checks every identity', () => {
  const query = '10000000-0000-4000-8000-000000000001';
  expect(focusRecordRequest(query, focus)).toMatchObject({
    queryId: query,
    view: 'records',
    first: 1,
    versionId: focus.versionId,
    recordId: focus.recordId,
  });
  const record = {
    ...focus,
    featureId: focus.recordId,
    assetId: '50000000-0000-4000-8000-000000000001',
    analysisId: '60000000-0000-4000-8000-000000000001',
    sourceId: '1',
    index: 1,
    values: { c1: 1 },
  };
  const result = { records: [record] };
  expect(checkedFocusedRecord(result, focus)).toEqual(record);
  for (const records of [
    [],
    [record, record],
    [{ ...record, versionId: '30000000-0000-4000-8000-000000000002' }],
    [{ ...record, dataItemId: '20000000-0000-4000-8000-000000000002' }],
  ])
    expect(() => checkedFocusedRecord({ records }, focus)).toThrow();
});
