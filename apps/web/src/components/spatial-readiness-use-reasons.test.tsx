// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  calculateProjectReadiness,
  readinessRecordKey,
  type ProjectReadinessInput,
  type ProjectReadinessRecord,
} from '@wiser/data-core/project-readiness';
import { getDictionary } from '../lib/i18n';
import { buildReadiness } from '../lib/spatial-readiness';
import type { WorkspacePack } from '../lib/spatial-workspace-contract';
import { SpatialReadinessPanel } from './spatial-readiness-panel';

afterEach(cleanup);

function fixture(
  computation: 'FLUX' | 'CONCENTRATION_DIFFERENCE' = 'FLUX',
): ProjectReadinessInput {
  const source = {
    workId: 'synthetic-pair',
    versionId: 'fixed-v1',
    assetId: `sha256:${'a'.repeat(64)}`,
    track: 'SYNTHETIC' as const,
    kind: 'TABLE' as const,
    needIds: ['K5-001'],
    regionIds: ['bohai'],
  };
  const evidence = [
    {
      source,
      locator: 'synthetic:pair',
      excerpt: 'Synthetic native pair only.',
    },
  ];
  const records: ProjectReadinessRecord[] = (
    [
      ['concentration', '0'],
      ['flow', '2'],
    ] as const
  ).map(([id, value], index) => ({
    id,
    source,
    needIds: source.needIds,
    regionIds: source.regionIds,
    object: {
      key: 'native-object',
      originalName: 'Synthetic original object',
      markers: [],
      footnotes: [],
    },
    series: null,
    time: { value: '2023-04-01', role: 'OBSERVATION', precision: 'DAY' },
    rawValue: value,
    metric:
      index === 0 || computation === 'CONCENTRATION_DIFFERENCE'
        ? {
            code: 'NH3-N',
            kind: 'CONCENTRATION',
            unit: 'mg/L',
            method: 'synthetic-colorimetry-v1',
          }
        : {
            code: 'DISCHARGE',
            kind: 'FLOW',
            unit: 'm3/s',
            method: 'synthetic-current-meter-v1',
          },
    parsing: 'READY',
    professionalState: 'APPROVED',
    evidence,
    spatial: null,
  }));
  return {
    track: 'SYNTHETIC',
    requirement: {
      needId: 'K5-001',
      version: 'synthetic-conditions-v1',
      regionId: 'bohai',
      purpose: 'read-conditions',
      dateRole: 'OBSERVATION',
      window: { start: '2023-04', end: '2023-04' },
    },
    sources: [source],
    records,
    series: [],
    correspondences: [],
    useChecks: [
      {
        id: 'use-check',
        purpose: 'read-conditions',
        computation,
        state: 'CHECKS_PASSED',
        recordIds: records.map(readinessRecordKey),
        reasons: [],
        evidence,
      },
    ],
  };
}

function changed(
  change: (
    record: ProjectReadinessRecord,
    index: number,
  ) => ProjectReadinessRecord,
  computation: 'FLUX' | 'CONCENTRATION_DIFFERENCE' = 'FLUX',
): ProjectReadinessInput {
  const input = fixture(computation);
  return { ...input, records: input.records.map(change) };
}

// Exercise the existing rule with native facts, rather than enumerating dictionary keys.
function ruleExamples(): ProjectReadinessInput[] {
  const original = fixture();
  const thirdRecords = [
    ...original.records,
    { ...original.records[1]!, id: 'second-flow' },
  ];
  const third = {
    ...original,
    records: thirdRecords,
    useChecks: original.useChecks!.map((check) => ({
      ...check,
      recordIds: thirdRecords.map(readinessRecordKey),
    })),
  };
  const noEvidence = {
    ...original,
    useChecks: original.useChecks!.map((check) => ({ ...check, evidence: [] })),
  };
  const noWindow = {
    ...original,
    requirement: { ...original.requirement, window: null },
  };
  return [
    noEvidence,
    third,
    noWindow,
    changed((record, index) =>
      index === 0
        ? {
            ...record,
            rawValue: 'Ⅲ',
            metric: { ...record.metric!, kind: 'CATEGORY' },
          }
        : record,
    ),
    changed((record, index) =>
      index === 0 ? { ...record, rawValue: '-1' } : record,
    ),
    changed((record, index) =>
      index === 1 ? { ...record, rawValue: '-1' } : record,
    ),
    changed((record) => ({ ...record, parsing: 'PARTIAL' })),
    changed((record) => ({ ...record, object: null })),
    changed((record, index) =>
      index === 1
        ? { ...record, object: { ...record.object!, key: 'another-object' } }
        : record,
    ),
    changed((record) => ({
      ...record,
      metric: { ...record.metric!, unit: null },
    })),
    changed((record, index) =>
      index === 1
        ? { ...record, metric: { ...record.metric!, unit: 'mg/L' } }
        : record,
    ),
    changed((record) => ({
      ...record,
      metric: { ...record.metric!, method: 'unregistered-method' },
    })),
    changed((record) => ({
      ...record,
      time: { ...record.time, value: '2023-04', precision: 'MONTH' },
    })),
    changed((record) => ({
      ...record,
      time: { ...record.time, value: '2023-04-31' },
    })),
    changed((record, index) =>
      index === 1
        ? { ...record, time: { ...record.time, value: '2023-04-02' } }
        : record,
    ),
    changed((record) => ({
      ...record,
      time: { ...record.time, value: '2023-05-01' },
    })),
    changed(
      (record, index) =>
        index === 1
          ? { ...record, metric: { ...record.metric!, kind: 'FLOW' } }
          : record,
      'CONCENTRATION_DIFFERENCE',
    ),
    changed(
      (record, index) =>
        index === 1
          ? {
              ...record,
              metric: { ...record.metric!, method: 'different-method' },
            }
          : record,
      'CONCENTRATION_DIFFERENCE',
    ),
  ];
}

function packFor(input: ProjectReadinessInput): WorkspacePack {
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-04',
    processingVersion: 'synthetic-v1',
    sources: [
      {
        id: input.sources[0]!.workId,
        workId: input.sources[0]!.workId,
        versionId: 'fixed-v1',
        track: input.track,
        title: 'Synthetic fixed source',
        provider: 'Synthetic provider',
        kind: 'report',
        originalSha256: 'a'.repeat(64),
        evidenceUrl: null,
        rights: {
          public: false,
          displayAllowed: true,
          redistributionAllowed: false,
          note: 'Synthetic only',
        },
        regionIds: ['bohai'],
        needIds: ['K5-001'],
        processingVersion: 'synthetic-v1',
        duplicateOf: null,
        status: {
          original: 'obtained',
          parsed: 'ready',
          checked: 'unknown',
          professionalReview: input.track === 'REAL' ? 'pending' : 'approved',
          space: 'text-only',
          use: 'local-inspection',
        },
      },
    ],
    records: input.records.map((record) => ({
      id: record.id,
      sourceId: record.source.workId,
      versionId: record.source.versionId,
      track: input.track,
      objectId: record.object!.key,
      objectLabel: record.object!.originalName,
      kind: 'observation',
      regionIds: ['bohai'],
      needIds: ['K5-001'],
      time: {
        start: record.time.value,
        end: record.time.value,
        role: 'observation',
        precision: record.time.precision === 'MONTH' ? 'month' : 'day',
      },
      metric: record.metric!.code,
      value: String(record.rawValue),
      unit: record.metric!.unit,
      evidence: record.evidence.map((item) => ({
        locator: item.locator,
        text: item.excerpt,
        url: null,
      })),
      positions: [],
      processingVersion: 'synthetic-v1',
      reviewStatus: input.track === 'REAL' ? 'pending' : 'synthetic-reviewed',
      missingReasons: [],
    })),
    regions: [],
    topicPackages: [],
    rasterReports: [],
  };
}

function mount(input: ProjectReadinessInput, locale: 'zh-CN' | 'en') {
  const copy = getDictionary(locale).dataFoundation.spatialReadiness;
  const pack = packFor(input);
  const selection = {
    track: input.track,
    needId: 'K5-001',
    window: input.requirement.window,
    dateRole: input.requirement.dateRole,
  };
  const result = buildReadiness(pack, 'bohai', [], input, selection);
  render(
    <SpatialReadinessPanel
      pack={pack}
      regionId="bohai"
      facts={input}
      selection={selection}
      copy={copy}
    />,
  );
  const usesSection = screen.getByText(copy.usesHeading).closest('details')!;
  fireEvent.click(within(usesSection).getByText(copy.usesHeading));
  const useId =
    input.useChecks![0]!.computation === 'FLUX'
      ? 'pollution-load'
      : 'concentration-trend';
  const item = within(usesSection)
    .getByText(copy.useLabels[useId])
    .closest('li')!;
  return { copy, result, item, useId };
}

describe.each(['zh-CN', 'en'] as const)('use reason reading (%s)', (locale) => {
  it('has readable labels for every reason produced by actual rule examples', () => {
    const reasons = new Set(
      ruleExamples().flatMap((input) =>
        calculateProjectReadiness(input).useChecks.flatMap(
          (check) => check.reasons,
        ),
      ),
    );
    expect(reasons.size).toBe(20);
    const labels: Record<string, string> =
      getDictionary(locale).dataFoundation.spatialReadiness.detailLabels;
    for (const code of reasons) {
      expect(Object.hasOwn(labels, code), `Unmapped core reason: ${code}`).toBe(
        true,
      );
      expect(labels[code]?.trim()).toBeTruthy();
    }
  });

  it('reads blocked core reasons individually in both the use summary and its drilldown', () => {
    const { copy, item, result } = mount(
      changed((record, index) =>
        index === 0
          ? {
              ...record,
              rawValue: 'Ⅲ',
              metric: { ...record.metric!, kind: 'CATEGORY' },
            }
          : record,
      ),
      locale,
    );
    const use = result.uses.find((value) => value.id === 'pollution-load')!;
    expect(use.state).toBe('BLOCKED');
    const reasons = within(item).getByRole('list');
    expect(
      within(reasons)
        .getAllByRole('listitem')
        .map((entry) => entry.textContent),
    ).toEqual(
      use.reasons.map(
        (code) => copy.detailLabels[code as keyof typeof copy.detailLabels],
      ),
    );
    const computations = screen
      .getByText(copy.questionLabels.computations)
      .closest('article')!;
    fireEvent.click(
      within(computations).getByRole('button', { name: copy.inspect }),
    );
    const inspector = screen.getByRole('region', {
      name: copy.questionLabels.computations,
    });
    fireEvent.click(
      within(inspector).getByText(`${copy.grains.USE_CHECK} (1)`),
    );
    expect(within(inspector).getByRole('list').textContent).toContain(
      copy.detailLabels['NON_NUMERIC_INPUT' as keyof typeof copy.detailLabels],
    );
    expect(
      within(inspector).getByText('NON_NUMERIC_INPUT').closest('details')!.open,
    ).toBe(false);
  });

  it('keeps uncertain conditions distinct from failure and preserves exact codes in a closed disclosure', () => {
    const { copy, item, result } = mount(
      changed((record) => ({
        ...record,
        metric: { ...record.metric!, unit: null },
        time: { ...record.time, value: '2023-04', precision: 'MONTH' },
      })),
      locale,
    );
    const use = result.uses.find((value) => value.id === 'pollution-load')!;
    expect(use.state).toBe('UNKNOWN');
    expect(use.eligible).toBe(false);
    expect(within(item).getByText(copy.factStates.UNKNOWN)).toBeTruthy();
    const list = within(item).getByRole('list');
    expect(list.textContent).not.toMatch(
      /不合格|条件不满足|failed|incompatible/i,
    );
    for (const code of use.reasons) {
      const element = within(item).getByText(code);
      expect(element.closest('details')!.open).toBe(false);
    }
    const disclosure = within(item)
      .getByText(copy.technicalDetails)
      .closest('details')!;
    fireEvent.click(within(disclosure).getByText(copy.technicalDetails));
    expect(disclosure.open).toBe(true);
    expect(disclosure.textContent).toContain(result.project.ruleVersion);
  });

  it('does not describe a passed technical check with pending real approval as rejected', () => {
    const original = fixture('CONCENTRATION_DIFFERENCE');
    const input: ProjectReadinessInput = {
      ...original,
      track: 'REAL',
      sources: original.sources.map((source) => ({ ...source, track: 'REAL' })),
      records: original.records.map((record) => ({
        ...record,
        professionalState: 'PENDING_REVIEW',
      })),
    };
    const { copy, item, result } = mount(input, locale);
    const use = result.uses.find(
      (value) => value.id === 'concentration-trend',
    )!;
    expect(use.state).toBe('CHECKS_PASSED');
    expect(use.eligible).toBe(false);
    expect(within(item).getByText(copy.usePendingReview)).toBeTruthy();
    expect(item.textContent).not.toMatch(/未通过|驳回|rejected|failed/i);
  });

  it('uses a safe visible explanation for unknown codes, including inherited property names', () => {
    const original = fixture();
    const input: ProjectReadinessInput = {
      ...original,
      useChecks: original.useChecks!.map((check) => ({
        ...check,
        state: 'UNKNOWN',
        reasons: ['FUTURE_RULE_REASON', 'constructor'],
      })),
    };
    const { item, result } = mount(input, locale);
    const use = result.uses.find((value) => value.id === 'pollution-load')!;
    expect(use.state).toBe('UNKNOWN');
    expect(use.eligible).toBe(false);
    const reasons = within(item).getByRole('list');
    expect(within(reasons).getAllByRole('listitem')).toHaveLength(2);
    expect(reasons.textContent).not.toMatch(
      /FUTURE_RULE_REASON|constructor|native code/,
    );
    expect(reasons.textContent).toContain(
      locale === 'zh-CN' ? '说明尚未登记' : 'Explanation not recorded',
    );
    for (const code of use.reasons)
      expect(within(item).getByText(code).closest('details')!.open).toBe(false);
  });
});
