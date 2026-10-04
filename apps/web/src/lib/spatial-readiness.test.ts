import { describe, expect, it } from 'vitest';
import type {
  Material,
  WorkspacePack,
  WorkspaceRecord,
} from './spatial-workspace-contract';
import { buildReadiness, NEED_IDS } from './spatial-readiness';
import { materialReference } from './spatial-readiness-facts';
import {
  calculateProjectReadiness,
  readinessRecordKey,
} from '@wiser/data-core/project-readiness';
import {
  parseLocalReadinessFacts,
  readableLocalReadinessFacts,
} from './spatial-readiness-input';
import type { ProjectReadinessInput } from '@wiser/data-core';

const material: Material = {
  id: 'report',
  versionId: 'v1',
  title: 'Monthly categories',
  provider: 'Public provider',
  kind: 'report',
  originalSha256: 'a'.repeat(64),
  evidenceUrl: null,
  rights: {
    public: true,
    displayAllowed: true,
    redistributionAllowed: false,
    note: 'Local inspection',
  },
  regionIds: ['bth', 'chaobai', 'beiyun'],
  needIds: ['K5-001'],
  processingVersion: 'p1',
  status: {
    original: 'obtained',
    parsed: 'partial',
    checked: 'cells-verified',
    professionalReview: 'pending',
    space: 'reference',
    use: 'inspect',
  },
  duplicateOf: null,
};
const record: WorkspaceRecord = {
  id: 'r1',
  sourceId: 'report',
  versionId: 'v1',
  objectId: 'source-object-1',
  objectLabel: 'Reported reach',
  kind: 'observation',
  regionIds: ['bth', 'chaobai'],
  needIds: ['K5-001'],
  time: {
    start: '2023-04',
    end: '2023-04',
    precision: 'month',
    role: 'observation',
  },
  metric: '现状水质类别',
  value: 'Ⅲ',
  unit: null,
  positions: [],
  evidence: [{ locator: 'table:1/row:2', text: 'Ⅲ', url: null }],
  processingVersion: 'p1',
  reviewStatus: 'pending',
  missingReasons: ['exact-position-unknown'],
};
const pack = (sources = [material], records = [record]): WorkspacePack => ({
  schemaVersion: 1,
  generatedAt: '2026-10-02',
  processingVersion: 'p1',
  sources,
  records,
  regions: [],
  topicPackages: [],
  rasterReports: [],
});
it('does not promote an undeclared record into an explicitly synthetic source track', () => {
  const input = pack([{ ...material, track: 'SYNTHETIC' }], [record]);
  const result = buildReadiness(input, 'chaobai', [], null, {
    track: 'SYNTHETIC',
    needId: 'K5-001',
    window: null,
    dateRole: 'OBSERVATION',
  });
  expect(result.records).toEqual([]);
  expect(result.project.records).toEqual([]);
  expect(result.counts.records).toBe(0);
  expect(result.needs.find((need) => need.id === 'K5-001')?.recordIds).toEqual(
    [],
  );
});
function publicationFacts(input: WorkspacePack): ProjectReadinessInput {
  const sources = input.sources.map((source) => ({
    ...materialReference(source),
    track: 'REAL' as const,
    kind: 'MONTHLY_REPORT' as const,
    needIds: source.needIds,
    regionIds: source.regionIds,
  }));
  const evidence = {
    source: materialReference(input.sources[0]),
    locator: 'table:1/title',
    excerpt: '2023年4月水质公布资料',
  };
  return {
    track: 'REAL',
    requirement: {
      needId: 'K5-001',
      version: 'test-declared-window',
      regionId: 'chaobai',
      purpose: 'publication-coverage',
      dateRole: 'PUBLICATION',
      window: { start: '2023-04', end: '2023-06' },
    },
    sources,
    series: [
      {
        id: 'declared-series',
        version: 'series-v1',
        sources,
        evidence: [evidence],
      },
    ],
    correspondences: [],
    records: input.records.map((record) => ({
      id: record.id,
      source: materialReference(input.sources[0]),
      needIds: record.needIds,
      regionIds: record.regionIds,
      object: {
        key: record.objectId,
        originalName: record.objectLabel,
        markers: [],
        footnotes: [],
      },
      series:
        record.time.precision === 'month'
          ? { id: 'declared-series', version: 'series-v1' }
          : null,
      time: {
        value: record.time.start,
        role: 'PUBLICATION',
        precision: record.time.precision === 'month' ? 'MONTH' : 'DAY',
      },
      rawValue: record.value,
      metric: {
        code: record.metric,
        kind: 'CATEGORY',
        unit: record.unit,
        method: null,
      },
      parsing: 'READY',
      professionalState: 'PENDING_REVIEW',
      evidence: [evidence],
      spatial: null,
    })),
  };
}

describe('multi-region readiness', () => {
  it('has 19 demand slots for each of six regions without treating slots as datasets', () => {
    expect(NEED_IDS).toHaveLength(19);
    const result = buildReadiness(pack(), 'chaobai');
    expect(result.needs).toHaveLength(19);
    expect(result.questions).toHaveLength(9);
    expect(result.counts.sources).toBe(1);
    expect(result.needs[1].state).toBe('not-obtained');
  });
  it('does not invent cleaning or quality-control result sets when no task is recorded', () => {
    const result = buildReadiness(pack(), 'chaobai');
    for (const id of ['cleaning', 'quality-control'] as const) {
      expect(
        result.questions.find((question) => question.id === id)?.recordIds,
      ).toEqual([]);
    }
  });
  it('resolves readability by the exact source version rather than the last matching source ID', () => {
    const restrictedRevision = {
      ...material,
      versionId: 'v2',
      rights: { ...material.rights, displayAllowed: false },
    };
    const result = buildReadiness(
      pack([material, restrictedRevision]),
      'chaobai',
    );
    expect(result.uses.find((use) => use.id === 'archive')?.eligible).toBe(
      true,
    );
  });
  it('does not include record contents with no matching readable fixed source', () => {
    const orphan = { ...record, id: 'orphan', versionId: 'not-present' };
    const result = buildReadiness(
      pack([material], [record, orphan]),
      'chaobai',
    );
    expect(result.counts.records).toBe(1);
    expect(
      result.questions.flatMap((question) => question.recordIds),
    ).not.toContain('orphan');
  });
  it('does not import synthetic series, tasks or publication declarations into the real result', () => {
    const input = pack();
    const synthetic = {
      ...publicationFacts(input),
      track: 'SYNTHETIC' as const,
    };
    const result = buildReadiness(input, 'chaobai', [], synthetic);
    expect(result.counts.monthlyRecords).toBe(0);
    expect(result.project.monthly.raw).toEqual([]);
    expect(result.project.tasks).toEqual([]);
  });
  it('counts all displayable fixed geometry references of a record, with repeated references deduplicated', () => {
    const position = {
      id: 'position-1',
      expression: 'Test reference area',
      role: 'reference' as const,
      match: 'bound' as const,
      crs: 'EPSG:4326' as const,
      nativeCrs: 'EPSG:4326',
      geometry: { type: 'Point' as const, coordinates: [116, 40] },
      geometrySourceId: material.id,
      geometryVersionId: material.versionId,
      locator: 'table:1/row:2',
      scaleNote: 'Synthetic test reference',
      evidence: { locator: 'table:1/row:2', text: 'Test reference area' },
    };
    const second = {
      ...position,
      id: 'position-2',
      locator: 'table:1/row:3',
      geometry: { type: 'Point' as const, coordinates: [116.1, 40.1] },
    };
    const input = pack(
      [material],
      [
        {
          ...record,
          positions: [position, second, { ...second, id: 'position-copy' }],
        },
      ],
    );
    expect(buildReadiness(input, 'chaobai').counts.geometryRecords).toBe(2);
  });
  it('does not turn a pending workspace record into professional approval through supplementary facts', () => {
    const input = pack();
    const facts = publicationFacts(input);
    const result = buildReadiness(input, 'chaobai', [], {
      ...facts,
      records: facts.records.map((item) => ({
        ...item,
        professionalState: 'APPROVED',
      })),
    });
    expect(result.counts.professionallyReviewed).toBe(0);
    expect(result.project.records[0].professionalState).toBe('PENDING_REVIEW');
  });
  it('global union deduplicates a source used by several regions and a format copy', () => {
    const duplicate = { ...material, id: 'copy', duplicateOf: 'report' };
    const result = buildReadiness(
      pack(
        [material, duplicate],
        [
          record,
          {
            ...record,
            id: 'r2',
            regionIds: ['beiyun'],
            objectId: 'source-object-2',
          },
        ],
      ),
      'bth',
    );
    expect(result.counts.sources).toBe(1);
    expect(result.counts.versions).toBe(1);
    expect(result.counts.records).toBe(2);
    expect(result.counts.sourceObjects).toBe(2);
  });
  it('keeps unknown observation counts and density separate from record counts', () => {
    const input = pack();
    const result = buildReadiness(
      input,
      'chaobai',
      [],
      publicationFacts(input),
    );
    expect(result.counts.validObservations).toBeNull();
    expect(result.density.spatial).toBeNull();
    expect(result.density.reportWindows).toEqual(['2023-04']);
    expect(
      result.uses.find((u) => u.id === 'concentration-trend')?.eligible,
    ).toBe(false);
    expect(result.uses.find((u) => u.id === 'monthly-category')?.eligible).toBe(
      true,
    );
    // A label and month alone cannot establish a publication-series declaration.
    expect(buildReadiness(input, 'chaobai').density.reportWindows).toEqual([]);
    expect(
      buildReadiness(input, 'chaobai').uses.find(
        (u) => u.id === 'monthly-category',
      )?.eligible,
    ).toBe(false);
  });
  it('counts separate queries of one work once without collapsing their versions or objects', () => {
    const first = { ...material, workId: 'openstreetmap' };
    const second = {
      ...material,
      id: 'query2',
      versionId: 'v2',
      workId: 'openstreetmap',
    };
    const result = buildReadiness(
      pack(
        [first, second],
        [
          record,
          {
            ...record,
            id: 'r2',
            sourceId: 'query2',
            versionId: 'v2',
            objectId: 'different-source-object',
          },
        ],
      ),
      'bth',
    );
    expect(result.counts.sources).toBe(1);
    expect(result.counts.versions).toBe(2);
    expect(result.counts.sourceObjects).toBe(2);
  });
  it('does not count synthetic decisions, missing geometry, or an institutional address as valid mapped sampling', () => {
    const synthetic = {
      ...record,
      id: 'synth',
      reviewStatus: 'synthetic-reviewed' as const,
    };
    const address = {
      id: 'address',
      expression: 'Author institution',
      role: 'institution-address' as const,
      match: 'bound' as const,
      geometry: { type: 'Point' as const, coordinates: [116, 40] },
      crs: 'EPSG:4326' as const,
      geometrySourceId: 'report',
      geometryVersionId: 'v1',
      locator: 'paragraph:1',
      scaleNote: null,
      evidence: { locator: 'paragraph:1', text: 'Author institution' },
    };
    const result = buildReadiness(
      pack([material], [{ ...record, positions: [address] }, synthetic]),
      'chaobai',
    );
    expect(result.counts.records).toBe(1);
    expect(result.counts.geometryRecords).toBe(0);
    expect(result.counts.samplingSites).toBeNull();
    expect(result.counts.professionallyReviewed).toBe(0);
  });
  it('stale records explain affected uses and preserve quantities', () => {
    const result = buildReadiness(pack(), 'chaobai', ['r1']);
    expect(result.staleRecordIds).toEqual(['r1']);
    expect(result.counts.records).toBe(1);
    expect(result.uses.every((u) => !u.eligible)).toBe(true);
  });
  it('time windows expose missing months and distinguish publication from observations', () => {
    const input = pack(
      [material],
      [
        record,
        {
          ...record,
          id: 'june',
          time: { ...record.time, start: '2023-06', end: '2023-06' },
        },
        {
          ...record,
          id: 'press',
          time: {
            start: '2026-06-04',
            end: '2026-06-04',
            precision: 'day',
            role: 'publication',
          },
        },
      ],
    );
    const result = buildReadiness(
      input,
      'chaobai',
      [],
      publicationFacts(input),
    );
    expect(result.density.missingReportWindows).toEqual(['2023-05']);
    expect(result.density.reportWindows).not.toContain('2026-06-04');
  });
});

describe('readiness visibility and use-check provenance', () => {
  it('does not expose unreadable material identities in need summaries', () => {
    const hidden = {
      ...material,
      id: 'private-source',
      rights: { ...material.rights, displayAllowed: false },
    };
    const result = buildReadiness(
      pack([hidden], [{ ...record, sourceId: hidden.id }]),
      'chaobai',
    );
    expect(result.needs[0].sourceIds).toEqual([]);
    expect(result.needs[0].recordIds).toEqual([]);
    expect(result.counts.sources).toBe(0);
    expect(JSON.stringify(result)).not.toContain('private-source');
  });
  it('keeps missing computation checks unknown rather than returning a constant negative verdict', () => {
    const result = buildReadiness(pack(), 'chaobai');
    expect(result.uses.find((use) => use.id === 'pollution-load')?.state).toBe(
      'UNKNOWN',
    );
    expect(
      result.uses.find((use) => use.id === 'concentration-trend')?.state,
    ).toBe('UNKNOWN');
  });
  it('retains explicitly synthetic reviewed records only in a separately selected synthetic track', () => {
    const source = {
      ...material,
      track: 'SYNTHETIC' as const,
      status: { ...material.status, professionalReview: 'approved' },
    };
    const row = {
      ...record,
      track: 'SYNTHETIC' as const,
      reviewStatus: 'synthetic-reviewed' as const,
    };
    const input = pack([source], [row]);
    const facts = {
      ...publicationFacts(input),
      track: 'SYNTHETIC' as const,
      sources: publicationFacts(input).sources.map((value) => ({
        ...value,
        track: 'SYNTHETIC' as const,
      })),
      records: publicationFacts(input).records.map((value) => ({
        ...value,
        professionalState: 'APPROVED' as const,
      })),
    };
    expect(buildReadiness(input, 'chaobai', [], facts).counts.records).toBe(0);
    const selected = buildReadiness(input, 'chaobai', [], facts, {
      needId: 'K5-001',
      window: facts.requirement.window,
      dateRole: 'PUBLICATION',
      track: 'SYNTHETIC',
    });
    expect(selected.counts.records).toBe(1);
    expect(selected.project.track).toBe('SYNTHETIC');
    expect(selected.counts.professionallyReviewed).toBe(1);
    expect(selected.records[0].id).toBe(row.id);
  });
  it('retains a separately selected complete SYNTHETIC flux positive with both original zeros', () => {
    const source: Material = { ...material, track: 'SYNTHETIC' };
    const concentration: WorkspaceRecord = {
      ...record,
      id: 'synthetic-concentration',
      track: 'SYNTHETIC',
      reviewStatus: 'synthetic-reviewed',
      metric: 'NH3-N',
      unit: 'mg/L',
      value: '0.00',
      time: {
        start: '2023-04-01',
        end: '2023-04-01',
        precision: 'day',
        role: 'observation',
      },
      method: {
        code: 'synthetic-colorimetry-v1',
        evidence: record.evidence[0],
      },
    };
    const flow: WorkspaceRecord = {
      ...concentration,
      id: 'synthetic-flow',
      metric: 'DISCHARGE',
      unit: 'm3/s',
      value: '0',
      method: {
        code: 'synthetic-current-meter-v1',
        evidence: record.evidence[0],
      },
    };
    const input = pack([source], [concentration, flow]);
    const initial = publicationFacts(input);
    const facts: ProjectReadinessInput = {
      ...initial,
      track: 'SYNTHETIC',
      requirement: {
        ...initial.requirement,
        purpose: 'synthetic-flux-conditions',
        dateRole: 'OBSERVATION',
        window: { start: '2023-04', end: '2023-04' },
      },
      sources: initial.sources.map((value) => ({
        ...value,
        track: 'SYNTHETIC',
        kind: 'TABLE',
      })),
      records: initial.records.map((value, index) => ({
        ...value,
        time: { ...value.time, role: 'OBSERVATION' },
        metric: {
          ...value.metric!,
          kind: index === 0 ? 'CONCENTRATION' : 'FLOW',
          method: input.records[index].method!.code,
        },
        professionalState: 'APPROVED',
      })),
      useChecks: [
        {
          id: 'synthetic-load-check-v1',
          purpose: 'synthetic-flux-conditions',
          computation: 'FLUX',
          state: 'CHECKS_PASSED',
          recordIds: initial.records.map(readinessRecordKey),
          reasons: [],
          evidence: initial.records[0].evidence,
        },
      ],
    };
    const result = buildReadiness(input, 'chaobai', [], facts, {
      track: 'SYNTHETIC',
      needId: facts.requirement.needId,
      dateRole: 'OBSERVATION',
      window: facts.requirement.window,
    });
    expect(
      result.uses.find((item) => item.id === 'pollution-load'),
    ).toMatchObject({
      state: 'CHECKS_PASSED',
      eligible: true,
      reasons: [],
    });
    expect(result.project.records.map((value) => value.rawValue)).toEqual([
      '0.00',
      '0',
    ]);
    expect(result).not.toHaveProperty('flux');
  });
  it('keeps REAL flux methods unknown and professional eligibility false', () => {
    const concentration: WorkspaceRecord = {
      ...record,
      id: 'concentration',
      metric: '氨氮',
      value: '0.2',
      unit: 'mg/L',
      method: { code: 'synthetic-method', evidence: record.evidence[0] },
      time: {
        start: '2023-04-01',
        end: '2023-04-01',
        precision: 'day',
        role: 'observation',
      },
    };
    const flow: WorkspaceRecord = {
      ...concentration,
      id: 'flow',
      metric: '流量',
      value: '2',
      unit: 'm3/s',
    };
    const input = pack([material], [concentration, flow]);
    const facts = publicationFacts(input);
    const withChecks: ProjectReadinessInput = {
      ...facts,
      requirement: {
        ...facts.requirement,
        purpose: 'nitrogen-load',
        dateRole: 'OBSERVATION',
      },
      records: facts.records.map((value, index) => ({
        ...value,
        time: { ...value.time, role: 'OBSERVATION' },
        metric: {
          ...value.metric!,
          kind: index === 0 ? 'CONCENTRATION' : 'FLOW',
          method: 'synthetic-method',
        },
      })),
      useChecks: [
        {
          id: 'load-check-v1',
          purpose: 'nitrogen-load',
          computation: 'FLUX',
          state: 'CHECKS_PASSED',
          recordIds: facts.records.map((value) =>
            JSON.stringify([
              JSON.stringify([
                value.source.workId,
                value.source.versionId,
                value.source.assetId,
              ]),
              value.id,
            ]),
          ),
          reasons: ['paired-synthetic-input-test'],
          evidence: facts.records[0].evidence,
        },
      ],
    };
    const result = buildReadiness(input, 'chaobai', [], withChecks);
    const use = result.uses.find((item) => item.id === 'pollution-load');
    expect(use?.state).toBe('UNKNOWN');
    expect(result.project.useChecks[0]?.reasons).toEqual([
      'METHOD_UNKNOWN',
      'paired-synthetic-input-test',
    ]);
    expect(use?.checkIds).toEqual(['load-check-v1']);
    expect(use?.eligible).toBe(false);
    expect(use?.ruleVersion).toBe(result.project.ruleVersion);
    expect(result.counts.professionallyReviewed).toBe(0);
    const stale = buildReadiness(input, 'chaobai', ['flow'], withChecks);
    expect(stale.uses.find((item) => item.id === 'pollution-load')?.state).toBe(
      'BLOCKED',
    );
    const withdrawn = buildReadiness(
      pack(
        [
          {
            ...material,
            rights: { ...material.rights, displayAllowed: false },
          },
        ],
        input.records,
      ),
      'chaobai',
      [],
      withChecks,
    );
    expect(
      withdrawn.uses.find((item) => item.id === 'pollution-load')?.checkIds,
    ).toEqual([]);
    expect(
      withdrawn.uses.find((item) => item.id === 'pollution-load')?.state,
    ).toBe('UNKNOWN');
    expect(withdrawn.counts.records).toBe(0);
  });
});

describe('readiness rechecks current evidence bindings', () => {
  const privateExcerpt = 'WITHDRAWN_PRIVATE_EXCERPT';
  const currentExcerpt = 'CURRENT_A_ORIGINAL_EXCERPT';
  function evidenceFixture() {
    const other: Material = {
      ...material,
      id: 'withdrawn-source-B',
      title: 'B original',
      originalSha256: 'b'.repeat(64),
    };
    const input = pack([material, other]);
    const facts = publicationFacts(input);
    const a = { ...facts.records[0].evidence[0], excerpt: currentExcerpt };
    const b = {
      source: materialReference(other),
      locator: 'page:1',
      excerpt: privateExcerpt,
    };
    const valid = {
      id: 'current-A-check',
      kind: 'INTEGRITY' as const,
      state: 'PASSED' as const,
      recordIds: [],
      sources: [materialReference(material)],
      findings: [],
      evidence: [a],
    };
    return { input, facts, other, a, b, valid };
  }
  it('removes an initially readable B check after withdrawal while keeping the valid A check and original', () => {
    const { input, facts, other, a, b, valid } = evidenceFixture();
    const initiallyReadable = readableLocalReadinessFacts(
      input,
      parseLocalReadinessFacts({
        ...facts,
        checks: [
          valid,
          { ...valid, id: 'B-dependent-check', evidence: [a, b] },
        ],
      }),
    );
    expect(
      buildReadiness(input, 'chaobai', [], initiallyReadable).project.checks,
    ).toHaveLength(2);
    const withdrawn = pack([
      material,
      { ...other, rights: { ...other.rights, displayAllowed: false } },
    ]);
    const snapshot = JSON.stringify(withdrawn);
    const result = buildReadiness(withdrawn, 'chaobai', [], initiallyReadable);
    expect(result.project.checks).toEqual([valid]);
    expect(result.project.records[0].rawValue).toBe(record.value);
    expect(result.project.records[0].evidence).toEqual(
      facts.records[0].evidence,
    );
    expect(JSON.stringify(result)).not.toContain(other.id);
    expect(JSON.stringify(result)).not.toContain(privateExcerpt);
    expect(JSON.stringify(withdrawn)).toBe(snapshot);
  });
  it.each([
    'record-evidence',
    'object-footnotes',
    'field',
    'task',
    'use-check',
  ] as const)(
    'rechecks the complete %s evidence binding when B is withdrawn',
    (carrier) => {
      const { input, facts, other, a, b } = evidenceFixture();
      const key = readinessRecordKey(facts.records[0]);
      const value: ProjectReadinessInput = {
        ...facts,
        records: facts.records.map((item) => ({
          ...item,
          evidence: carrier === 'record-evidence' ? [a, b] : item.evidence,
          object: {
            ...item.object!,
            footnotes: carrier === 'object-footnotes' ? [b] : [],
          },
        })),
        fields:
          carrier === 'field'
            ? [
                {
                  id: 'B-dependent-field',
                  source: facts.sources[0],
                  name: 'B-only field',
                  type: 'text',
                  unit: null,
                  timeRole: null,
                  positionRole: null,
                  primaryKey: null,
                  formatVersion: null,
                  evidence: [a, b],
                },
              ]
            : [],
        tasks:
          carrier === 'task'
            ? [
                {
                  id: 'B-dependent-task',
                  kind: 'CLEANING',
                  state: 'OPEN',
                  recordIds: [key],
                  sources: [],
                  processor: null,
                  owner: 'B-only owner',
                  nextAction: 'B-only action',
                  evidence: [a, b],
                },
              ]
            : [],
        useChecks:
          carrier === 'use-check'
            ? [
                {
                  id: 'B-dependent-use',
                  purpose: facts.requirement.purpose,
                  computation: 'CATEGORY_REVIEW',
                  state: 'CHECKS_PASSED',
                  recordIds: [key],
                  reasons: ['B-only reason'],
                  evidence: [a, b],
                },
              ]
            : [],
      };
      const admitted = readableLocalReadinessFacts(
        input,
        parseLocalReadinessFacts(value),
      );
      expect(
        JSON.stringify(buildReadiness(input, 'chaobai', [], admitted)),
      ).toContain(privateExcerpt);
      const withdrawn = pack([
        material,
        { ...other, rights: { ...other.rights, displayAllowed: false } },
      ]);
      const result = buildReadiness(withdrawn, 'chaobai', [], admitted);
      expect(JSON.stringify(result)).not.toContain(privateExcerpt);
      expect(JSON.stringify(result)).not.toContain(other.id);
      if (carrier === 'field') expect(result.project.fields).toEqual([]);
      if (carrier === 'task') expect(result.project.tasks).toEqual([]);
      if (carrier === 'use-check') expect(result.project.useChecks).toEqual([]);
      expect(result.records.map((item) => item.id)).toEqual([record.id]);
      expect(result.project.records[0].rawValue).toBe(record.value);
      if (carrier === 'record-evidence' || carrier === 'object-footnotes') {
        expect(result.project.records[0].evidence[0].excerpt).toBe(
          record.evidence[0].text,
        );
        expect(result.project.records[0].object?.footnotes).toEqual([]);
      }
    },
  );
  it.each(['version', 'hash'] as const)(
    'rejects old evidence after B changes its fixed %s',
    (changed) => {
      const { input, facts, other, b, valid } = evidenceFixture();
      const admitted = readableLocalReadinessFacts(
        input,
        parseLocalReadinessFacts({
          ...facts,
          checks: [valid, { ...valid, id: 'old-B-check', evidence: [b] }],
        }),
      );
      const current = pack([
        material,
        {
          ...other,
          ...(changed === 'version'
            ? { versionId: 'v2' }
            : { originalSha256: 'c'.repeat(64) }),
        },
      ]);
      const result = buildReadiness(current, 'chaobai', [], admitted);
      expect(result.project.checks).toEqual([valid]);
      expect(JSON.stringify(result)).not.toContain(privateExcerpt);
    },
  );
  it('clears a stale series binding rather than returning its withdrawn declaration identifier', () => {
    const { input, facts, other, b } = evidenceFixture();
    const seriesId = 'WITHDRAWN_PRIVATE_SERIES';
    const admitted = readableLocalReadinessFacts(
      input,
      parseLocalReadinessFacts({
        ...facts,
        series: [{ ...facts.series[0], id: seriesId, evidence: [b] }],
        records: facts.records.map((item) => ({
          ...item,
          series: { id: seriesId, version: facts.series[0].version },
        })),
      }),
    );
    expect(
      buildReadiness(input, 'chaobai', [], admitted).project.monthly.raw,
    ).toHaveLength(1);
    const result = buildReadiness(
      pack([
        material,
        { ...other, rights: { ...other.rights, displayAllowed: false } },
      ]),
      'chaobai',
      [],
      admitted,
    );
    expect(result.project.records[0].series).toBeNull();
    expect(JSON.stringify(result)).not.toContain(seriesId);
    expect(result.project.records[0].rawValue).toBe(record.value);
  });
  it('keeps history but removes density authority when its evidence source is withdrawn', () => {
    const { input, facts, other, b } = evidenceFixture();
    const key = readinessRecordKey(facts.records[0]);
    const admitted = readableLocalReadinessFacts(
      input,
      parseLocalReadinessFacts({
        ...facts,
        reconciliations: [
          {
            id: 'B-reconciliation',
            status: 'VERIFIED',
            recordIds: [key],
            independentObservationCount: 3,
            evidence: [b],
          },
        ],
        selectedReconciliationId: 'B-reconciliation',
        areaDenominator: { recordIds: [key], areaKm2: 2, evidence: [b] },
      }),
    );
    const prior = buildReadiness(input, 'chaobai', [], admitted);
    expect(prior.counts.validObservations).toBe(3);
    expect(prior.project.density.observationsPerKm2).toBe(1.5);
    const result = buildReadiness(
      pack([
        material,
        { ...other, rights: { ...other.rights, displayAllowed: false } },
      ]),
      'chaobai',
      [],
      admitted,
    );
    expect(result.counts.validObservations).toBeNull();
    expect(result.project.density.areaKm2).toBeNull();
    expect(result.records.map((item) => item.id)).toEqual([record.id]);
    expect(result.project.records[0].rawValue).toBe(record.value);
    expect(JSON.stringify(result)).not.toContain(other.id);
  });
  it('does not let a later readable relationship with the same ID revive an earlier withdrawn evidence lookup', () => {
    const { other, a, b } = evidenceFixture();
    const input = pack(
      [material, other],
      [
        record,
        {
          ...record,
          id: 'r2',
          objectId: 'source-object-2',
          objectLabel: 'Another reported reach',
        },
      ],
    );
    const facts = publicationFacts(input);
    const relationship = {
      id: 'ambiguous-B-relationship',
      memberRecordIds: facts.records.map(readinessRecordKey),
      status: 'PENDING_REVIEW',
      evidence: [b],
    };
    const admitted = readableLocalReadinessFacts(
      input,
      parseLocalReadinessFacts({
        ...facts,
        correspondences: [
          relationship,
          { ...relationship, evidence: [a] },
          { ...relationship, id: 'safe-A-relationship', evidence: [a] },
        ],
      }),
    );
    expect(
      buildReadiness(input, 'chaobai', [], admitted).project.monthly
        .appliedHypothesisIds,
    ).toContain(relationship.id);
    const result = buildReadiness(
      {
        ...input,
        sources: [
          material,
          { ...other, rights: { ...other.rights, displayAllowed: false } },
        ],
      },
      'chaobai',
      [],
      admitted,
    );
    expect(result.project.monthly.appliedHypothesisIds).toEqual([
      'safe-A-relationship',
    ]);
    expect(
      result.questions
        .find((item) => item.id === 'structure')
        ?.details.map((item) => item.factId),
    ).not.toContain(relationship.id);
  });
  it('retains currently readable cross-scope evidence as UNKNOWN without extending A calculation scope', () => {
    const { other, b, valid } = evidenceFixture();
    const current = pack([
      material,
      { ...other, regionIds: ['beiyun'], needIds: ['K5-002'] },
    ]);
    const facts = publicationFacts(current);
    const check = { ...valid, evidence: [b] };
    const admitted = readableLocalReadinessFacts(
      current,
      parseLocalReadinessFacts({ ...facts, checks: [check] }),
    );
    const core = calculateProjectReadiness(admitted);
    expect(core.checks).toEqual([{ ...check, state: 'UNKNOWN' }]);
    expect(core.counts.works).toBe(1);
    const result = buildReadiness(current, 'chaobai', [], admitted);
    expect(result.project.checks).toEqual([{ ...check, state: 'UNKNOWN' }]);
    expect(result.project.checks[0].evidence[0].excerpt).toBe(privateExcerpt);
    expect(result.sources.map((item) => item.id)).toEqual([material.id]);
    expect(result.counts.sources).toBe(1);
    expect(result.records.map((item) => item.id)).toEqual([record.id]);
    const withoutB = buildReadiness(pack(), 'chaobai', [], admitted);
    expect(withoutB.project.checks).toEqual([]);
    expect(JSON.stringify(withoutB)).not.toContain(privateExcerpt);
  });
  it('preserves currently permitted nonpublic evidence instead of adding a public-only rule', () => {
    const { facts, other, b, valid } = evidenceFixture();
    const current = pack([
      material,
      { ...other, rights: { ...other.rights, public: false } },
    ]);
    const result = buildReadiness(current, 'chaobai', [], {
      ...facts,
      checks: [
        valid,
        { ...valid, id: 'current-nonpublic-B-check', evidence: [b] },
      ],
    });
    expect(result.project.checks).toHaveLength(2);
    expect(result.project.checks[1].state).toBe('PASSED');
    expect(JSON.stringify(result.project.checks[1])).toContain(privateExcerpt);
  });
});
