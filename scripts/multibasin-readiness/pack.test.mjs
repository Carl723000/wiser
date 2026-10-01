import assert from 'node:assert/strict';
import test from 'node:test';
import { monthlyRegions, monthlyRecord } from './pack.mjs';

test('only source headings or explicit named reservoirs add subregion associations', () => {
  assert.deepEqual(
    monthlyRegions({ waterSystem: '潮白河水系', objectLabel: '潮白河上段' }),
    ['bth', 'chaobai'],
  );
  assert.deepEqual(
    monthlyRegions({ waterSystem: null, objectLabel: '同名未知湖泊' }),
    ['bth'],
  );
  assert.deepEqual(
    monthlyRegions({ waterSystem: null, objectLabel: '官厅水库' }),
    ['bth', 'yongding'],
  );
});
test('monthly records retain category, unknown unit, raw evidence and textual position', () => {
  const row = {
    id: 'r',
    objectId: 's:obj',
    objectLabel: '潮白河上段',
    waterSystem: '潮白河水系',
    waterSystemRaw: '潮白河水系',
    area: '密云',
    rawValue: '无水',
    month: '2023-04',
    valueLocator: 'c4',
    objectLocator: 'c2',
    areaLocator: 'c3',
    waterSystemLocator: 'c1',
    categoryValid: false,
  };
  const record = monthlyRecord(
    row,
    { sourceId: 's', originalSha256: 'a'.repeat(64) },
    [],
  );
  assert.equal(record.value, '无水');
  assert.equal(record.unit, null);
  assert.equal(record.time.role, 'observation');
  assert.equal(record.reviewStatus, 'pending');
  assert.ok(record.missingReasons.includes('category-not-reported'));
  assert.ok(record.positions.every((position) => position.geometry === null));
  assert.equal(record.evidence[0].text, '无水');
});
test('a named admin polygon remains reference and cannot become a precise sampling location', () => {
  const geo = {
    id: 'g',
    sourceId: 'osm',
    versionId: 'g1',
    properties: { name: '通州区', limitation: 'reference' },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [116, 40],
          [117, 40],
          [117, 41],
          [116, 40],
        ],
      ],
    },
  };
  const row = {
    id: 'monthly-2023-04:t1:r38',
    objectId: 's:obj',
    objectLabel: '北运河',
    waterSystem: '北运河水系',
    area: '通州',
    rawValue: 'Ⅲ',
    month: '2023-04',
    valueLocator: 'c4',
    objectLocator: 'c2',
    areaLocator: 'c3',
    waterSystemLocator: 'c1',
    categoryValid: true,
  };
  const record = monthlyRecord(
    row,
    { sourceId: 's', originalSha256: 'a'.repeat(64) },
    [geo],
  );
  assert.equal(record.positions.at(-1).role, 'reference');
  assert.equal(record.positions.at(-1).geometrySourceId, 'osm');
  assert.ok(record.missingReasons.includes('exact-position-unknown'));
  assert.equal(
    record.positions.filter((position) => position.role === 'sampling').length,
    0,
  );
});
