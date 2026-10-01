import { describe, expect, it } from 'vitest';
import type { WorkspacePack } from './spatial-workspace-contract';
import { parseWorkspacePack } from './spatial-workspace-pack';

function pack(): WorkspacePack {
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-02T00:00:00Z',
    processingVersion: 'p1',
    sources: [
      {
        id: 'report',
        versionId: 'v1',
        title: 'Monthly report',
        provider: 'Public agency',
        kind: 'report',
        originalSha256: 'a'.repeat(64),
        originalPath: '/private/original.doc',
        evidenceUrl: 'https://example.org/report',
        rights: {
          public: true,
          displayAllowed: true,
          redistributionAllowed: false,
          note: 'Public reading',
        },
        regionIds: ['beiyun'],
        needIds: ['K5-001'],
        processingVersion: 'p1',
        duplicateOf: null,
        status: {
          original: 'saved',
          parsed: 'rows',
          checked: 'checked',
          professionalReview: 'pending',
          space: 'text',
          use: 'reading',
        },
      },
    ],
    records: [
      {
        id: 'row1',
        sourceId: 'report',
        versionId: 'v1',
        objectId: 'report:row:1',
        objectLabel: 'Northern canal',
        kind: 'observation',
        regionIds: ['beiyun'],
        needIds: ['K5-001'],
        time: {
          start: '2026-04',
          end: '2026-04',
          precision: 'month',
          role: 'observation',
        },
        metric: 'category',
        value: 'Ⅲ',
        unit: null,
        positions: [
          {
            id: 'place',
            expression: 'Tongzhou',
            role: 'reference',
            match: 'text-only',
            geometry: null,
            crs: null,
            geometrySourceId: null,
            geometryVersionId: null,
            locator: 'table:1/row:1',
            scaleNote: null,
            evidence: { locator: 'table:1/row:1', text: 'Tongzhou' },
          },
        ],
        evidence: [
          {
            locator: 'table:1/row:1',
            text: 'Northern canal | Tongzhou | Ⅲ',
            url: null,
          },
        ],
        processingVersion: 'p1',
        reviewStatus: 'pending',
        missingReasons: ['No precise reach boundary'],
      },
    ],
    regions: [
      {
        id: 'beiyun',
        name: '北运河',
        aliases: [],
        type: 'navigation',
        bounds: [115, 38, 118, 41],
      },
    ],
    topicPackages: [
      {
        id: 'topic',
        title: 'Canal records',
        regionIds: ['beiyun'],
        sourceIds: ['report'],
        recordIds: ['row1'],
        question: 'What is recorded?',
        gaps: [],
      },
    ],
    rasterReports: [],
  };
}

describe('local spatial pack server boundary', () => {
  it('keeps exact values, locators and source versions without serializing paths or unknown payloads', () => {
    const input = { ...pack(), credential: 'DO_NOT_SERIALIZE' };
    Object.assign(input.sources[0], { token: 'DO_NOT_SERIALIZE' });
    const safe = parseWorkspacePack(input);
    expect(safe.records[0]?.value).toBe('Ⅲ');
    expect(safe.records[0]?.evidence[0]?.locator).toBe('table:1/row:1');
    expect(safe.records[0]?.versionId).toBe('v1');
    expect(JSON.stringify(safe)).not.toMatch(
      /DO_NOT_SERIALIZE|\/private\/original/,
    );
  });
  it('removes nonpublic or undisplayable material and all its records and topic references', () => {
    const input = pack();
    input.sources[0].rights.public = false;
    const safe = parseWorkspacePack(input);
    expect(safe.sources).toEqual([]);
    expect(safe.records).toEqual([]);
    expect(safe.topicPackages[0]?.sourceIds).toEqual([]);
    expect(safe.topicPackages[0]?.recordIds).toEqual([]);
  });
  it('rejects orphan and changed-version records instead of attaching them to another version', () => {
    const input = pack();
    input.records[0].versionId = 'v2';
    expect(() => parseWorkspacePack(input)).toThrow(
      'spatial-pack:source-version',
    );
  });
  it('rejects malformed hashes, reversed dates, impossible coordinates and unsafe links', () => {
    const badHash = pack();
    badHash.sources[0].originalSha256 = 'not-a-hash';
    expect(() => parseWorkspacePack(badHash)).toThrow();
    const time = pack();
    time.records[0].time.end = '2025-04';
    expect(() => parseWorkspacePack(time)).toThrow();
    const coord = pack();
    coord.records[0].positions[0].geometry = {
      type: 'Point',
      coordinates: [NaN, 39],
    };
    expect(() => parseWorkspacePack(coord)).toThrow();
    const url = pack();
    url.sources[0].evidenceUrl = 'javascript:alert(1)';
    expect(() => parseWorkspacePack(url)).toThrow();
  });
  it('does not accept a fabricated bound position without fixed geometry evidence', () => {
    const input = pack();
    input.records[0].positions[0].match = 'bound';
    expect(() => parseWorkspacePack(input)).toThrow();
  });
});
