import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CreateIngestionCandidateTopicInput } from '@wiser/data-contracts';
import {
  createCandidateTopicHost,
  CANDIDATE_TOPIC_ENGINEERING_ADOPTION,
  loadCandidateTopicHostConfig,
} from '../src/data-foundation/ingestion-candidate-topic-host.js';
import { assertCandidateTopicPinProviders } from '../src/data-foundation/ingestion-candidate-topic-pins.js';
import type { DataCapabilityExecutionContext } from '../src/data-foundation/capability-handler.js';
import type { QueryAdapterPgClient } from '../src/data-foundation/query-adapters.js';

const uuid = (n: number) =>
  `6abcdef0-0000-4000-8000-${String(n).padStart(12, '0')}`;
const config = {
  profile: 'goal101-engineering-inspection/1' as const,
  tenantId: uuid(20),
  projectId: uuid(21),
  purpose: 'candidate-review',
};
const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId: uuid(1),
  processingBatchId: uuid(2),
  reviewHash: 'a'.repeat(64),
};
const selection = {
  question: 'Engineering source inspection',
  regionIds: ['bth'],
  needIds: ['K5-001'],
  recordPins: [],
};
type Spec = CreateIngestionCandidateTopicInput['viewSpec'];
const pins = (version = 'beijing-monthly-docx-c3/1.0.0'): Spec['rulePins'] => [
  { kind: 'projection', ruleId: 'beijing-monthly-docx-c3', version },
  {
    kind: 'readiness',
    ruleId: 'wiser.project-readiness',
    version: 'wiser.project-readiness.v3',
  },
  {
    kind: 'requirement',
    ruleId: 'wiser.candidate-topic.requirement-inspection',
    version:
      'sha256:40d10fc1a5b1d27a7c617d0939c4334e70451eee1f7fd0081856815a2763612d',
  },
  {
    kind: 'impact',
    ruleId: 'wiser.candidate-topic.version-impact',
    version:
      'sha256:f1337694aa082608e313a62e063fda3ee0d93a0284f34a28ad84ad2bc1de9ba3',
  },
];
const context = (): DataCapabilityExecutionContext => ({
  principal: {
    actorId: uuid(10),
    actorType: 'human',
    authenticationMethod: 'supabase_jwt',
    authUserId: uuid(10),
    sessionId: uuid(11),
  },
  authorization: {
    tenantId: config.tenantId,
    projectId: config.projectId,
    purpose: config.purpose,
    roles: ['data-steward'],
    scopes: ['data.operation.read', 'data.ingestion.write'],
    maxSecurityLevel: 'L0_PUBLIC',
    authzVersion: 1,
  },
  effectiveMaxSecurityLevel: 'L0_PUBLIC',
  traceId: 'c'.repeat(32),
  auditLevel: 'STANDARD',
  timeoutMs: 30_000,
  signal: new AbortController().signal,
});
class Source {
  statements: string[] = [];
  rows: Record<string, unknown>[] = [];
  client: QueryAdapterPgClient = {
    release() {},
    query: (sql) => {
      this.statements.push(sql);
      return Promise.resolve({
        rows: sql.includes('candidate.relations.fixed-pins') ? this.rows : [],
      });
    },
  };
}

describe('bounded engineering topic host adoption', () => {
  it('keeps the monthly producer role consistent with the registered fixed bundle', async () => {
    const host = createCandidateTopicHost(config)!;
    const period: Spec['period'] = {
      windowMode: 'month',
      from: '2026-01',
      to: '2026-02',
      timeRole: 'PUBLICATION',
      displayUnit: 'month',
      includeUndated: false,
    };
    await expect(
      host.loadRules(
        new Source().client,
        context(),
        selection,
        pins('beijing-monthly-docx-c3/2.0.0'),
        period,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      host.loadRules(new Source().client, context(), selection, pins(), {
        ...period,
        timeRole: 'REPORT_PERIOD',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      host.loadRules(
        new Source().client,
        context(),
        selection,
        pins('beijing-monthly-docx-c3/2.0.0'),
        { ...period, timeRole: 'REPORT_PERIOD' },
      ),
    ).resolves.toEqual(pins('beijing-monthly-docx-c3/2.0.0'));
  });
  it('adopts the explicit 2.1.0 bundle without replacing the fixed 2.0.0 bundle', async () => {
    const host = createCandidateTopicHost(config)!;
    for (const version of [
      'beijing-monthly-docx-c3/2.0.0',
      'beijing-monthly-docx-c3/2.1.0',
    ]) {
      await expect(
        host.loadRules(
          new Source().client,
          context(),
          selection,
          pins(version),
          {
            windowMode: 'month',
            from: '2026-01',
            to: '2026-02',
            timeRole: 'REPORT_PERIOD',
            displayUnit: 'month',
            includeUndated: false,
          },
        ),
      ).resolves.toEqual(pins(version));
    }
    await expect(
      host.loadRules(
        new Source().client,
        context(),
        selection,
        pins('beijing-monthly-docx-c3/2.2.0'),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('loads only complete explicit startup binding and keeps absent configuration closed', () => {
    expect(createCandidateTopicHost()).toBeUndefined();
    expect(loadCandidateTopicHostConfig({})).toBeUndefined();
    expect(
      loadCandidateTopicHostConfig({
        DATA_CANDIDATE_TOPIC_PROFILE: config.profile,
        DATA_CANDIDATE_TOPIC_TENANT_ID: config.tenantId,
        DATA_CANDIDATE_TOPIC_PROJECT_ID: config.projectId,
        DATA_CANDIDATE_TOPIC_PURPOSE: config.purpose,
      }),
    ).toEqual(config);
    for (const value of [
      { DATA_CANDIDATE_TOPIC_PROFILE: config.profile },
      { DATA_CANDIDATE_TOPIC_PROFILE: '*' },
      { DATA_CANDIDATE_TOPIC_PURPOSE: '*' },
    ])
      expect(() => loadCandidateTopicHostConfig(value)).toThrow();
  });

  it('returns registered v1 and v2 complete sets rather than request objects', async () => {
    const host = createCandidateTopicHost(config)!;
    const source = new Source();
    for (const version of [
      'beijing-monthly-docx-c3/1.0.0',
      'beijing-monthly-docx-c3/2.0.0',
    ]) {
      const requested = pins(version).reverse();
      const result = await host.loadRules(
        source.client,
        context(),
        selection,
        requested,
      );
      expect(result).toEqual(pins(version));
      expect(result).not.toBe(requested);
      requested[0]!.version = 'client-mutated';
      expect(
        await host.loadRules(
          source.client,
          context(),
          selection,
          pins(version),
        ),
      ).toEqual(pins(version));
    }
    expect(source.statements).toEqual([]);
  });

  it('rejects cross tenant/project/purpose and cancelled authority without an existence hint', async () => {
    const host = createCandidateTopicHost(config)!;
    const source = new Source();
    for (const binding of [
      { tenantId: uuid(90) },
      { projectId: uuid(90) },
      { purpose: 'unregistered-purpose' },
    ]) {
      const current = context();
      Object.assign(current.authorization, binding);
      await expect(
        host.loadRules(source.client, current, selection, pins()),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    const aborted = context();
    const controller = new AbortController();
    controller.abort();
    await expect(
      host.loadRules(
        source.client,
        { ...aborted, signal: controller.signal },
        selection,
        pins(),
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_TIMEOUT' });
  });

  it('checks the finite selection catalog without granting materials or accepting forged bundles', async () => {
    const host = createCandidateTopicHost(config)!;
    const source = new Source();
    for (const region of [
      'bth',
      'yongding',
      'chaobai',
      'beiyun',
      'daqing-baiyangdian',
      'bohai',
    ])
      for (let n = 1; n <= 19; n++)
        await expect(
          host.loadRules(
            source.client,
            context(),
            {
              ...selection,
              regionIds: [region],
              needIds: [`K5-${String(n).padStart(3, '0')}`],
            },
            pins(),
          ),
        ).resolves.toEqual(pins());
    for (const selected of [
      { ...selection, regionIds: ['other-region'] },
      { ...selection, needIds: ['K5-020'] },
    ])
      await expect(
        host.loadRules(source.client, context(), selected, pins()),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    for (const requested of [
      pins().slice(1),
      [...pins(), pins()[0]!],
      pins().map((pin, i) => (i === 1 ? { ...pin, version: 'made-up' } : pin)),
    ])
      await expect(
        host.loadRules(source.client, context(), selection, requested),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('binds the newly adopted definition pins to actual producer bytes and not requirement input versions', async () => {
    const digest = (path: string) =>
      createHash('sha256')
        .update(readFileSync(new URL(path, import.meta.url)))
        .digest('hex');
    expect(pins()[2]!.version).toBe(
      `sha256:${digest('../../web/src/lib/spatial-readiness-facts.ts')}`,
    );
    expect(pins()[3]!.version).toBe(
      `sha256:${digest('../../web/src/lib/spatial-version-impact.ts')}`,
    );
    // Preserve the historical adoption; current bytes belong to the explicit 2.1.0 producer.
    expect(CANDIDATE_TOPIC_ENGINEERING_ADOPTION.projection).toEqual({
      sourceRevision: 'a32ad00c148bc1de08b18cfa168e0ee9952784e2',
      source: 'packages/data-core/src/candidate-monthly-projection.ts',
      sha256:
        '729b83e1fe6d3e34be916278bbaacf0ccc09566591485c72d8d5d1568ae6c220',
    });
    expect(
      CANDIDATE_TOPIC_ENGINEERING_ADOPTION.conversionProjection.version,
    ).toBe('beijing-monthly-docx-c3/2.1.0');
    expect(
      digest('../../../packages/data-core/src/candidate-monthly-projection.ts'),
    ).toBe(CANDIDATE_TOPIC_ENGINEERING_ADOPTION.conversionProjection.sha256);
    expect(digest('../../../packages/data-core/src/project-readiness.ts')).toBe(
      '3b1f8b28333514e06f8e2bc0864065ebbca36402658c9d3132b0bcaeabbd1757',
    );
    const rules = await createCandidateTopicHost(config)!.loadRules(
      new Source().client,
      context(),
      selection,
      pins(),
    );
    expect(rules[2]!.version).not.toMatch(/^local-inspection:/);
  });

  it('reads the fixed relation and latest decision on the caller client and rejects changed or withdrawn evidence', async () => {
    const host = createCandidateTopicHost(config)!;
    const source = new Source();
    const pin = { relationId: uuid(30), revision: 2, decisionVersion: 3 };
    const actual = {
      ...pin,
      dependencies: [
        { reference, assetId: uuid(3), sourceHash: 'b'.repeat(64) },
      ],
    };
    source.rows = [actual];
    expect(
      await host.loadRelations!(source.client, context(), [pin], [reference]),
    ).toEqual([actual]);
    expect(
      source.statements.some((sql) =>
        sql.includes('candidate.relations.scope'),
      ),
    ).toBe(true);
    expect(
      source.statements.some((sql) =>
        sql.includes('candidate.relations.fixed-pins'),
      ),
    ).toBe(true);
    expect(
      source.statements.some((sql) => /\bbegin\b|\bcommit\b/i.test(sql)),
    ).toBe(false);
    source.rows = [{ ...actual, decisionVersion: 4 }];
    await expect(
      host.loadRelations!(source.client, context(), [pin], [reference]),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    source.rows = [];
    await expect(
      host.loadRelations!(source.client, context(), [pin], [reference]),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('offers the whole-record provider set but refuses unproven sourceObjectKey', () => {
    const host = createCandidateTopicHost(config)!;
    expect('sourceObjectKey' in host).toBe(false);
    const spec: Spec = {
      schemaVersion: 2,
      page: { kind: 'assets', reference, first: 1 },
      period: {
        windowMode: 'month',
        from: '2026-01',
        to: '2026-02',
        timeRole: 'PUBLICATION',
        displayUnit: 'month',
        includeUndated: false,
      },
      rulePins: pins(),
      dependencyPins: [
        {
          kind: 'asset',
          reference,
          assetId: uuid(3),
          sourceHash: 'b'.repeat(64),
          parserVersion: 'fixture-parser/1.0.0',
        },
      ],
      relationPins: [{ relationId: uuid(30), revision: 1, decisionVersion: 0 }],
      topic: selection,
    };
    expect(() => assertCandidateTopicPinProviders(spec, host)).not.toThrow();
    expect(() =>
      assertCandidateTopicPinProviders(
        {
          ...spec,
          topic: {
            ...selection,
            recordPins: [
              {
                reference,
                assetId: uuid(3),
                recordId: uuid(4),
                sourceObjectKey: 'unproven',
              },
            ],
          },
        },
        host,
      ),
    ).toThrowError(expect.objectContaining({ code: 'EXECUTION_FAILED' }));
  });
});
