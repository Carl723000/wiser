import { describe, expect, it } from 'vitest';
import type { WorkspacePack } from './spatial-workspace-contract';
import type { WorkspaceSourcePin } from './spatial-workspace-view';
import {
  decodeWorkspaceReadingUrl,
  encodeWorkspaceReadingUrl,
  type WorkspaceReadingSearchParams,
  type WorkspaceReadingUrlContext,
  type WorkspaceReadingUrlState,
} from './spatial-workspace-url-state';

const source: WorkspaceSourcePin = {
  sourceId: 'synthetic-publication',
  versionId: 'fixture-source-v1',
  sha256: 'a'.repeat(64),
  processingVersion: 'fixture-parser-v1',
};
const geometrySource: WorkspaceSourcePin = {
  sourceId: 'synthetic-reference',
  versionId: 'fixture-geometry-v1',
  sha256: 'b'.repeat(64),
  processingVersion: 'fixture-geometry-rule-v1',
};
function fixture(): WorkspaceReadingUrlContext {
  const material = (pin: WorkspaceSourcePin) => ({
    id: pin.sourceId,
    versionId: pin.versionId,
    title: 'Private fixture title must never enter the link',
    provider: 'Synthetic fixture provider',
    kind: 'report' as const,
    originalSha256: pin.sha256,
    evidenceUrl: null,
    rights: {
      public: false,
      displayAllowed: true,
      redistributionAllowed: false,
      note: 'Synthetic deterministic URL test',
    },
    regionIds: ['chaobai' as const],
    needIds: ['K5-001'],
    processingVersion: pin.processingVersion,
    status: {
      original: 'saved',
      parsed: 'ready',
      checked: 'unknown',
      professionalReview: 'pending',
      space: 'reference',
      use: 'unknown',
    },
    duplicateOf: null,
  });
  const pack: WorkspacePack = {
    schemaVersion: 1,
    generatedAt: '2026-10-04T00:00:00Z',
    processingVersion: 'synthetic-url-test-v1',
    sources: [material(source), material(geometrySource)],
    records: [
      {
        id: 'synthetic-row:table:1',
        sourceId: source.sourceId,
        versionId: source.versionId,
        objectId: 'synthetic-native-name',
        objectLabel: 'Private fixture object',
        kind: 'observation',
        regionIds: ['chaobai'],
        needIds: ['K5-001'],
        time: {
          start: '2023-04',
          end: '2023-04',
          precision: 'month',
          role: 'publication',
        },
        metric: 'source grade',
        value: 'Private fixture raw value',
        unit: null,
        // Synthetic test construction modeling the declared REAL/legacy lane,
        // never an acquired or professionally approved real material.
        track: 'REAL',
        processingVersion: 'synthetic-record-rule-v1',
        reviewStatus: 'pending',
        missingReasons: [],
        evidence: [{ locator: 'table:1/row:1', text: 'Fixture', url: null }],
        positions: [
          {
            id: 'synthetic-native-area',
            expression: 'Private fixture administrative expression',
            role: 'reference',
            match: 'bound',
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
            crs: 'EPSG:4326',
            geometrySourceId: geometrySource.sourceId,
            geometryVersionId: geometrySource.versionId,
            locator: 'fixture-feature:1',
            scaleNote: 'Administrative reference, never a sampling area',
            evidence: { locator: 'table:1/row:1', text: 'Fixture area' },
          },
        ],
      },
    ],
    regions: ['bth', 'chaobai', 'beiyun'].map((id) => ({
      id: id as 'bth' | 'chaobai' | 'beiyun',
      name: 'Synthetic region',
      aliases: [],
      type: 'navigation extent',
      bounds: [113, 36, 120, 43],
    })),
    topicPackages: [],
    rasterReports: [],
  };
  return { pack };
}
const state: WorkspaceReadingUrlState = {
  regionId: 'chaobai',
  needId: 'K5-001',
  dateRole: 'PUBLICATION',
  monthWindow: { start: '2023-02', end: '2023-09' },
  tab: 'spatial',
  pane: 'evidence',
  source,
  selection: {
    recordId: 'synthetic-row:table:1',
    processingVersion: 'synthetic-record-rule-v1',
    position: {
      positionId: 'synthetic-native-area',
      geometrySource,
    },
  },
};
function parameters(value = state): URLSearchParams {
  const params = new URLSearchParams();
  if (value.track !== undefined) params.set('track', value.track);
  if (value.regionId !== null) params.set('region', value.regionId);
  if (value.needId !== null) params.set('need', value.needId);
  if (value.dateRole !== null) params.set('dateRole', value.dateRole);
  if (value.monthWindow !== null) {
    params.set('monthStart', value.monthWindow.start);
    params.set('monthEnd', value.monthWindow.end);
  }
  if (value.tab !== null) params.set('tab', value.tab);
  if (value.pane !== null) params.set('pane', value.pane);
  if (value.source !== null) {
    params.set('source', value.source.sourceId);
    params.set('version', value.source.versionId);
    params.set('sourceHash', value.source.sha256);
    params.set('sourceRule', value.source.processingVersion);
  }
  if (value.selection !== null) {
    params.set('record', value.selection.recordId);
    params.set('recordRule', value.selection.processingVersion);
    if (value.selection.position !== null) {
      params.set('position', value.selection.position.positionId);
      params.set('geometrySource', geometrySource.sourceId);
      params.set('geometryVersion', geometrySource.versionId);
      params.set('geometryHash', geometrySource.sha256);
      params.set('geometryRule', geometrySource.processingVersion);
    }
  }
  return params;
}
function rejected(
  params: URLSearchParams,
  reason: string,
  context = fixture(),
) {
  expect(decodeWorkspaceReadingUrl(params, context)).toEqual({
    status: 'invalid',
    reason,
  });
}

describe('private fixed workspace reading links', () => {
  it('retains legacy eight-field state as REAL without inferring a track from a record', () => {
    const context = fixture();
    delete context.pack.sources[0].track;
    delete context.pack.records[0].track;
    expect(decodeWorkspaceReadingUrl(parameters(), context)).toEqual({
      status: 'valid',
      state,
    });
    expect(Object.keys(state)).toHaveLength(8);
  });
  it('round trips an explicitly selected REAL track', () => {
    const choice = { ...state, track: 'REAL' as const };
    const context = fixture();
    const encoded = encodeWorkspaceReadingUrl('zh-CN', choice, context);
    expect(encoded.status).toBe('valid');
    if (encoded.status !== 'valid') throw new Error('Expected track link');
    const url = new URL(encoded.href, 'https://wiser.example.test');
    expect(url.searchParams.get('track')).toBe('REAL');
    expect(decodeWorkspaceReadingUrl(url.searchParams, context)).toEqual({
      status: 'valid',
      state: choice,
    });
  });
  it('round trips explicit SYNTHETIC material with permitted REAL reference geometry without changing its role', () => {
    const context = fixture();
    context.pack.sources[0].track = 'SYNTHETIC';
    context.pack.sources[1].track = 'REAL';
    context.pack.records[0].track = 'SYNTHETIC';
    context.pack.records[0].reviewStatus = 'synthetic-reviewed';
    const original = JSON.stringify(context);
    const choice = { ...state, track: 'SYNTHETIC' as const };
    const encoded = encodeWorkspaceReadingUrl('en', choice, context);
    expect(encoded.status).toBe('valid');
    if (encoded.status !== 'valid') throw new Error('Expected exercise link');
    const url = new URL(encoded.href, 'https://wiser.example.test');
    expect(url.searchParams.get('track')).toBe('SYNTHETIC');
    expect(decodeWorkspaceReadingUrl(url.searchParams, context)).toEqual({
      status: 'valid',
      state: choice,
    });
    expect(JSON.stringify(context)).toBe(original);
    expect(context.pack.records[0].positions[0].role).toBe('reference');
    expect(context.pack.records[0].positions[0].geometry?.type).toBe('Polygon');
  });
  it('does not infer SYNTHETIC from explicit source and record tracks when the URL omitted it', () => {
    const context = fixture();
    context.pack.sources[0].track = 'SYNTHETIC';
    context.pack.records[0].track = 'SYNTHETIC';
    rejected(parameters(), 'source', context);
  });
  it.each(['record', 'legacy record'])(
    'rejects SYNTHETIC %s under a REAL source and default URL',
    (kind) => {
      const context = fixture();
      context.pack.sources[0].track = 'REAL';
      if (kind === 'record') context.pack.records[0].track = 'SYNTHETIC';
      else {
        delete context.pack.records[0].track;
        context.pack.records[0].reviewStatus = 'synthetic-reviewed';
      }
      rejected(parameters(), 'record', context);
    },
  );
  it.each(['REAL', 'missing'])(
    'does not accept an explicit SYNTHETIC source with a %s record',
    (kind) => {
      const context = fixture();
      context.pack.sources[0].track = 'SYNTHETIC';
      if (kind === 'REAL') context.pack.records[0].track = 'REAL';
      else delete context.pack.records[0].track;
      rejected(parameters({ ...state, track: 'SYNTHETIC' }), 'record', context);
    },
  );
  it.each(['REAL', 'missing'])(
    'does not accept explicit SYNTHETIC records through a %s source',
    (kind) => {
      const context = fixture();
      context.pack.records[0].track = 'SYNTHETIC';
      if (kind === 'REAL') context.pack.sources[0].track = 'REAL';
      else delete context.pack.sources[0].track;
      rejected(parameters({ ...state, track: 'SYNTHETIC' }), 'source', context);
    },
  );
  it('does not treat synthetic-reviewed as a REAL review state', () => {
    const context = fixture();
    context.pack.records[0].reviewStatus = 'synthetic-reviewed';
    rejected(parameters(), 'record', context);
  });
  it('can select explicit SYNTHETIC matrix state without inventing a material or record', () => {
    const choice: WorkspaceReadingUrlState = {
      ...state,
      track: 'SYNTHETIC',
      tab: 'readiness',
      pane: null,
      source: null,
      selection: null,
    };
    expect(decodeWorkspaceReadingUrl(parameters(choice), fixture())).toEqual({
      status: 'valid',
      state: choice,
    });
  });
  it.each(['real', 'synthetic', 'UNKNOWN', 'REAL,SYNTHETIC'])(
    'rejects the unknown track %s',
    (track) => {
      const params = parameters();
      params.set('track', track);
      rejected(params, 'scope');
    },
  );
  it('rejects repeated tracks rather than choosing one lane', () => {
    const params = parameters({ ...state, track: 'REAL' });
    params.append('track', 'REAL');
    rejected(params, 'duplicate');
  });
  it('rejects an explicit undefined track instead of silently dropping it', () => {
    expect(
      encodeWorkspaceReadingUrl(
        'zh-CN',
        { ...state, track: undefined },
        fixture(),
      ),
    ).toEqual({ status: 'invalid', reason: 'parameters' });
  });
  it('keeps no supplied selection distinct from an invalid supplied selection', () => {
    expect(decodeWorkspaceReadingUrl(new URLSearchParams(), fixture())).toEqual(
      {
        status: 'absent',
      },
    );
    expect(decodeWorkspaceReadingUrl({ region: undefined }, fixture())).toEqual(
      {
        status: 'absent',
      },
    );
    rejected(new URLSearchParams('region='), 'parameters');
  });
  it('round trips both locales, the original fixed area and every applied reading choice without private content', () => {
    const context = fixture();
    const original = JSON.stringify(context);
    for (const locale of ['zh-CN', 'en'] as const) {
      const encoded = encodeWorkspaceReadingUrl(locale, state, context);
      expect(encoded.status).toBe('valid');
      if (encoded.status !== 'valid') throw new Error('Expected reading link');
      const href = new URL(encoded.href, 'https://wiser.example.test');
      expect(href.pathname).toBe(
        `/${locale}/data-foundation/spatial-workspace`,
      );
      expect(decodeWorkspaceReadingUrl(href.searchParams, context)).toEqual({
        status: 'valid',
        state,
      });
      expect(encoded.href).not.toMatch(
        /Private|Fixture|raw.value|token|https?:/,
      );
    }
    expect(JSON.stringify(context)).toBe(original);
    expect(context.pack.records[0].positions[0].role).toBe('reference');
    expect(context.pack.records[0].positions[0].geometry?.type).toBe('Polygon');
  });
  it('keeps an explicitly chosen matrix cell and date role without inventing a record', () => {
    const cell: WorkspaceReadingUrlState = {
      ...state,
      tab: 'readiness',
      pane: null,
      source: null,
      selection: null,
      dateRole: 'OBSERVATION',
    };
    expect(decodeWorkspaceReadingUrl(parameters(cell), fixture())).toEqual({
      status: 'valid',
      state: cell,
    });
  });
  it('allows an unspecified scope only as null, without silently defaulting it', () => {
    const partial = {
      ...state,
      regionId: null,
      needId: null,
      dateRole: null,
      monthWindow: null,
      tab: null,
      pane: null,
      selection: null,
    };
    expect(decodeWorkspaceReadingUrl(parameters(partial), fixture())).toEqual({
      status: 'valid',
      state: partial,
    });
  });
  it('uses the existing fixed source route rather than creating a new object or a saved view', () => {
    const encoded = encodeWorkspaceReadingUrl(
      'zh-CN',
      state,
      fixture(),
      'source',
    );
    expect(encoded.status).toBe('valid');
    if (encoded.status !== 'valid') throw new Error('Expected source link');
    const url = new URL(encoded.href, 'https://wiser.example.test');
    expect(url.pathname).toBe(
      '/zh-CN/data-foundation/spatial-workspace/source',
    );
    expect(url.searchParams.get('source')).toBe(source.sourceId);
    expect(url.searchParams.get('version')).toBe(source.versionId);
    expect(url.searchParams.has('saved')).toBe(false);
    expect(url.searchParams.has('candidateView')).toBe(false);
  });
  it.each([
    'region',
    'need',
    'source',
    'version',
    'record',
    'position',
    'monthStart',
  ])('rejects repeated %s including repeated equal values', (key) => {
    const params = parameters();
    params.append(key, params.get(key) ?? 'chaobai');
    rejected(params, 'duplicate');
  });
  it('rejects Next-style array parameters rather than picking their first value', () => {
    expect(
      decodeWorkspaceReadingUrl({ region: ['chaobai'] }, fixture()),
    ).toEqual({
      status: 'invalid',
      reason: 'duplicate',
    });
  });
  it.each([
    ['date object', new Date(0)],
    [
      'unresolved Next search parameters',
      Promise.resolve({ region: 'chaobai' }),
    ],
  ])('does not turn unsupported %s into absent state', (_label, input) => {
    expect(
      decodeWorkspaceReadingUrl(
        input as unknown as WorkspaceReadingSearchParams,
        fixture(),
      ),
    ).toEqual({ status: 'invalid', reason: 'parameters' });
  });
  it.each([
    'token',
    'versionId',
    'saved',
    'candidateView',
    'originalPath',
    'surprise',
  ])('rejects unknown or cross-transport %s', (key) => {
    const params = parameters();
    params.set(key, 'must-not-be-read');
    rejected(params, 'unknown-parameter');
  });
  it.each([
    ['region', 'unknown-region'],
    ['region', 'bohai'],
    ['need', 'K5-020'],
    ['need', 'K5-000'],
    ['dateRole', 'ACQUISITION'],
    ['tab', 'management'],
    ['pane', 'everything'],
  ])('closes an unknown or unavailable scope %s=%s', (key, value) => {
    const params = parameters();
    params.set(key, value);
    rejected(params, 'scope');
  });
  it.each([
    ['2023-00', '2023-09'],
    ['2023-02', '2023-13'],
    ['2023-02-01', '2023-09'],
    ['0000-01', '0000-02'],
    ['2023-10', '2023-09'],
    ['2023-01', '2123-01'],
  ])(
    'rejects an invalid, reversed or oversized month window %s to %s',
    (start, end) => {
      const params = parameters();
      params.set('monthStart', start);
      params.set('monthEnd', end);
      rejected(params, 'month-window');
    },
  );
  it('does not infer a date role or the other half of a month window', () => {
    const oneEnd = parameters();
    oneEnd.delete('monthEnd');
    rejected(oneEnd, 'month-window');
    const noRole = parameters();
    noRole.delete('dateRole');
    rejected(noRole, 'month-window');
  });
  it.each(['source', 'version', 'sourceHash', 'sourceRule'])(
    'requires the full fixed source pin, including %s',
    (key) => {
      const params = parameters();
      params.delete(key);
      rejected(params, 'source');
    },
  );
  it.each([
    ['source', geometrySource.sourceId],
    ['version', 'a-different-version'],
    ['sourceHash', 'c'.repeat(64)],
    ['sourceRule', 'a-different-rule'],
  ])('does not replace the selected fixed source %s', (key, value) => {
    const params = parameters();
    params.set(key, value);
    rejected(params, 'source');
  });
  it('keeps unknown records and source/record or need/region mismatches closed', () => {
    const unknown = parameters();
    unknown.set('record', 'unknown-record');
    rejected(unknown, 'record');
    const differentRule = parameters();
    differentRule.set('recordRule', 'new-record-rule');
    rejected(differentRule, 'record');
    const anotherNeed = parameters();
    anotherNeed.set('need', 'K5-002');
    rejected(anotherNeed, 'scope');
    const anotherRegion = parameters();
    anotherRegion.set('region', 'beiyun');
    rejected(anotherRegion, 'scope');
  });
  it('does not restore an out-of-window or differently dated selected record', () => {
    const outside = parameters();
    outside.set('monthStart', '2023-05');
    rejected(outside, 'scope');
    const wrongRole = parameters();
    wrongRole.set('dateRole', 'EVENT');
    rejected(wrongRole, 'scope');
  });
  it('does not restore a record through an ambiguous reused record identifier', () => {
    const context = fixture();
    context.pack.records.push({ ...context.pack.records[0] });
    rejected(parameters(), 'record', context);
  });
  it.each([
    'position',
    'geometrySource',
    'geometryVersion',
    'geometryHash',
    'geometryRule',
  ])(
    'requires the complete position and fixed geometry evidence including %s',
    (key) => {
      const params = parameters();
      params.delete(key);
      rejected(params, 'position');
    },
  );
  it.each([
    ['position', 'position-from-another-record'],
    ['geometryVersion', 'changed-geometry-version'],
    ['geometryHash', 'c'.repeat(64)],
    ['geometryRule', 'changed-geometry-rule'],
  ])(
    'does not substitute another location or geometry rule %s',
    (key, value) => {
      const params = parameters();
      params.set(key, value);
      rejected(params, 'position');
    },
  );
  it('keeps a record without a selected position readable without choosing its first geometry', () => {
    const recordOnly = {
      ...state,
      selection: { ...state.selection!, position: null },
    };
    expect(
      decodeWorkspaceReadingUrl(parameters(recordOnly), fixture()),
    ).toEqual({
      status: 'valid',
      state: recordOnly,
    });
  });
  it('does not select an unbound position or geometry with revoked display permission', () => {
    const unbound = fixture();
    unbound.pack.records[0].positions[0].match = 'candidate';
    rejected(parameters(), 'position', unbound);
    const hidden = fixture();
    hidden.pack.sources[1].rights.displayAllowed = false;
    rejected(parameters(), 'position', hidden);
  });
  it.each(['bound', 'candidate'] as const)(
    'does not pick one of two reused position identities when the additional position is %s',
    (match) => {
      const context = fixture();
      const additional = structuredClone(context.pack.records[0].positions[0]);
      additional.match = match;
      additional.geometrySourceId = source.sourceId;
      additional.geometryVersionId = source.versionId;
      context.pack.records[0].positions.push(additional);
      rejected(parameters(), 'position', context);
    },
  );
  it('allows the existing inclusive 1200-month limit and does not infer a selected record', () => {
    const cell: WorkspaceReadingUrlState = {
      ...state,
      source: null,
      selection: null,
      tab: 'readiness',
      pane: null,
      monthWindow: { start: '2023-01', end: '2122-12' },
    };
    expect(decodeWorkspaceReadingUrl(parameters(cell), fixture())).toEqual({
      status: 'valid',
      state: cell,
    });
  });
  it('rejects an explicitly dated selected record whose time or date role remains unknown', () => {
    const unknownTime = fixture();
    unknownTime.pack.records[0].time.precision = 'unknown';
    rejected(parameters(), 'scope', unknownTime);
    const unknownRole = fixture();
    unknownRole.pack.records[0].time.role = 'unknown';
    rejected(parameters(), 'scope', unknownRole);
  });
  it('rechecks the selected geometry source without revoking unrelated records', () => {
    const geometryWithdrawal = fixture();
    geometryWithdrawal.invalidations = [
      {
        sourceId: geometrySource.sourceId,
        versionId: geometrySource.versionId,
        state: 'revoked',
        affectedRecordIds: [state.selection!.recordId],
      },
    ];
    rejected(parameters(), 'position', geometryWithdrawal);
    const unrelatedWithdrawal = fixture();
    unrelatedWithdrawal.invalidations = [
      {
        sourceId: source.sourceId,
        versionId: source.versionId,
        state: 'stale',
        affectedRecordIds: ['a-different-record'],
      },
    ];
    expect(
      decodeWorkspaceReadingUrl(parameters(), unrelatedWithdrawal),
    ).toEqual({
      status: 'valid',
      state,
    });
  });
  it('rejects an ambiguous fixed source even if its duplicate is otherwise permitted', () => {
    const context = fixture();
    context.pack.sources.push(structuredClone(context.pack.sources[0]));
    rejected(parameters(), 'source', context);
  });
  it('does not infer a selected record through missing source or record-rule parameters', () => {
    const missingRule = parameters();
    missingRule.delete('recordRule');
    rejected(missingRule, 'record');
    const missingSource = parameters();
    for (const key of ['source', 'version', 'sourceHash', 'sourceRule'])
      missingSource.delete(key);
    rejected(missingSource, 'record');
  });
  it('rechecks current source and record withdrawal instead of granting access through a URL', () => {
    const hidden = fixture();
    hidden.pack.sources[0].rights.displayAllowed = false;
    rejected(parameters(), 'source', hidden);
    const withdrawn = fixture();
    withdrawn.invalidations = [
      {
        sourceId: source.sourceId,
        versionId: source.versionId,
        state: 'revoked',
      },
    ];
    rejected(parameters(), 'source', withdrawn);
    const recordWithdrawal = fixture();
    recordWithdrawal.invalidations = [
      {
        sourceId: source.sourceId,
        versionId: source.versionId,
        state: 'stale',
        affectedRecordIds: [state.selection!.recordId],
      },
    ];
    rejected(parameters(), 'record', recordWithdrawal);
  });
  it('refuses overlong encoded state and control characters without reflecting input', () => {
    const huge = parameters();
    huge.set('source', 'x'.repeat(8193));
    rejected(huge, 'size');
    const control = parameters();
    control.set('record', 'bad\nrecord');
    rejected(control, 'parameters');
  });
  it('validates outgoing links with the same authority and rejects a source target without a source', () => {
    const hidden = fixture();
    hidden.pack.sources[0].rights.displayAllowed = false;
    expect(encodeWorkspaceReadingUrl('en', state, hidden)).toEqual({
      status: 'invalid',
      reason: 'source',
    });
    expect(
      encodeWorkspaceReadingUrl(
        'en',
        { ...state, source: null, selection: null },
        fixture(),
        'source',
      ),
    ).toEqual({ status: 'invalid', reason: 'target' });
  });
  it('does not silently drop a new outgoing state field or a supplied undefined choice', () => {
    expect(
      encodeWorkspaceReadingUrl(
        'en',
        { ...state, extraScope: 'unapplied' } as WorkspaceReadingUrlState,
        fixture(),
      ),
    ).toEqual({ status: 'invalid', reason: 'parameters' });
    expect(
      encodeWorkspaceReadingUrl(
        'en',
        { ...state, pane: undefined } as unknown as WorkspaceReadingUrlState,
        fixture(),
      ),
    ).toEqual({ status: 'invalid', reason: 'parameters' });
  });
});


describe('exact native day reading state', () => {
  const exact = {
    ...state,
    monthWindow: null,
    dayWindow: { start: '2023-04-01', end: '2023-04-17' },
  } as WorkspaceReadingUrlState & { dayWindow: { start: string | null; end: string | null } };
  it('round-trips exact days without expanding the end to a month or changing original time', () => {
    const context = fixture();
    const before = JSON.stringify(context.pack);
    const encoded = encodeWorkspaceReadingUrl('en', exact, context);
    expect(encoded.status).toBe('valid');
    if (encoded.status !== 'valid') throw new Error('Day state rejected');
    const params = new URL(encoded.href, 'https://example.invalid').searchParams;
    expect(params.get('dayEnd')).toBe('2023-04-17');
    expect(params.has('monthEnd')).toBe(false);
    expect(decodeWorkspaceReadingUrl(params, context)).toEqual({ status: 'valid', state: exact });
    expect(JSON.stringify(context.pack)).toBe(before);
  });
  it.each([
    { start: '2023-04-01', end: null },
    { start: null, end: '2023-04-30' },
  ])('preserves an existing open native day boundary %j', (dayWindow) => {
    const input = { ...exact, dateRole: null, dayWindow };
    const encoded = encodeWorkspaceReadingUrl('en', input, fixture());
    expect(encoded.status).toBe('valid');
    if (encoded.status !== 'valid') throw new Error('Open day state rejected');
    expect(decodeWorkspaceReadingUrl(new URL(encoded.href, 'https://example.invalid').searchParams, fixture())).toEqual({ status: 'valid', state: input });
  });
  it('accepts a leap day as an actual calendar day', () => {
    const params = new URLSearchParams({ dayStart: '2024-02-29', dayEnd: '2024-02-29', region: 'chaobai' });
    expect(decodeWorkspaceReadingUrl(params, fixture())).toEqual({ status: 'valid', state: { regionId:'chaobai', needId:null, dateRole:null, monthWindow:null, dayWindow:{start:'2024-02-29',end:'2024-02-29'},tab:null,pane:null,source:null,selection:null } });
  });
  it.each([
    { dayStart: '2023-02-29' },
    { dayStart: '1900-02-29' },
    { dayStart: '2023-04-31' },
    { dayStart: '0000-01-01' },
    { dayStart: '2023-4-01' },
    { dayStart: '2023-04' },
    { dayStart: '2023-05-01', dayEnd: '2023-04-30' },
    { dayStart: '2023-04-01', monthStart: '2023-04', monthEnd: '2023-04', dateRole: 'PUBLICATION' },
  ])('rejects invalid or ambiguous calendar boundaries %j', (fields) => {
    const params = new URLSearchParams(Object.entries(fields) as [string,string][]);
    expect(decodeWorkspaceReadingUrl(params, fixture())).toEqual({ status:'invalid', reason:'day-window' });
  });
  it('rejects duplicate day inputs and a supplied empty day window without choosing a first value', () => {
    const params = new URLSearchParams('dayStart=2023-04-01&dayStart=2023-04-02');
    expect(decodeWorkspaceReadingUrl(params,fixture())).toEqual({status:'invalid',reason:'duplicate'});
    expect(encodeWorkspaceReadingUrl('en',{...exact,dayWindow:{start:null,end:null}},fixture())).toEqual({status:'invalid',reason:'day-window'});
  });
});
