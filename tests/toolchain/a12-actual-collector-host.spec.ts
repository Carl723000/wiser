import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  constructActualCollectorOptions,
  type ActualCollectorConfiguration,
} from '../../apps/web/e2e-live/support/a12-actual-collector-host.ts';
import { CandidateLoadTransportError } from '../../apps/web/e2e-live/support/a12-candidate-load-driver.ts';
import { createA12StandardIntakeCollector } from '../../apps/web/e2e-live/support/a12-standard-intake-collector.ts';
import { traversalContentDigest } from '../../apps/web/e2e-live/support/a12-candidate-load-traversal.ts';
import {
  assetIds,
  idempotencyKeys,
  ingestionId,
  operationId,
  reference,
  sha,
  startSyntheticLoopbackFixture,
  uploadSessionId,
  type FixtureMode,
} from './support/a12-actual-collector-fixture.ts';

// Synthetic behavioral integration only. No test certifies real Auth/RLS/SQL,
// normal Worker scanning, resource admission, registered S10/A12 scale or 15/3 acceptance.
const finiteKind =
  (expected: CandidateLoadTransportError['kind']) => (error: unknown) =>
    error instanceof CandidateLoadTransportError && error.kind === expected;
const body = (value: Uint8Array): Record<string, unknown> =>
  JSON.parse(Buffer.from(value).toString('utf8')) as Record<string, unknown>;

test(
  'real SDK and actual collector compose exact seven capabilities, originals and inventory',
  { timeout: 10_000 },
  async () => {
    assert(globalThis.crypto?.subtle); // Exercise the installed SDK's JWKS signature path, without /user fallback.
    const fixture = await startSyntheticLoopbackFixture();
    let host:
      Awaited<ReturnType<typeof constructActualCollectorOptions>> | undefined;
    let collector:
      ReturnType<typeof createA12StandardIntakeCollector> | undefined;
    try {
      const configuration = fixture.configuration();
      const expectedPrepared = fixture.originalBytes.map((bytes) =>
        Buffer.from(bytes),
      );
      host = await constructActualCollectorOptions(configuration);
      // Caller mutation after construction cannot rewrite owned prepared bytes.
      configuration.prepared[0]!.bytes.fill(0);
      assert.deepEqual(host.options.prepared[0]!.bytes, expectedPrepared[0]);
      assert.deepEqual(fixture.originalBytes[0], expectedPrepared[0]);
      collector = createA12StandardIntakeCollector(host.options);
      const result = await collector.collect();
      if (result.status !== 'collected')
        return assert.fail(`Synthetic collector failed: ${result.reason}`);
      assert.equal(result.standardAuthority, 'unknown');
      assert.deepEqual(
        result.prepared.map((asset) => asset.assetId),
        assetIds,
      );
      assert.equal(
        fixture.createdInput()?.sourceRegistration?.manifestAssetId,
        assetIds[1],
      );
      assert.equal(
        fixture.createdInput()?.sourceRegistration?.manifestSha256,
        sha(fixture.originalBytes[1]!),
      );
      const inventory = body(result.inventoryBytes) as {
        batch: {
          assets: {
            assetId: string;
            sourceHash: string;
            recordCount: number;
            featureCount: number;
          }[];
        };
        materials: {
          assetId: string;
          columns: unknown[];
          recordsDigest: string;
          geometryDigest: string;
        }[];
      };
      assert.equal(inventory.batch.assets[0]?.assetId, assetIds[0]);
      assert.equal(
        inventory.batch.assets[0]?.sourceHash,
        sha(expectedPrepared[0]!),
      );
      assert.equal(inventory.batch.assets[0]?.recordCount, 1);
      assert.equal(inventory.batch.assets[0]?.featureCount, 1);
      assert.equal(inventory.batch.assets[1]?.recordCount, 0);
      assert.equal(inventory.materials[0]?.assetId, assetIds[0]);
      assert.deepEqual(inventory.materials[0]?.columns, fixture.columns);
      const fingerprint = (value: unknown) => sha(JSON.stringify(value));
      assert.equal(
        inventory.materials[0]?.recordsDigest,
        traversalContentDigest(
          'records',
          fixture.columns,
          fixture.records,
          fingerprint,
        ),
      );
      assert.equal(
        inventory.materials[0]?.geometryDigest,
        traversalContentDigest('geometry', [], fixture.features, fingerprint),
      );
      const authHits = fixture.hits.filter((hit) => hit.service === 'auth');
      assert.deepEqual(
        authHits.map((hit) => [hit.method, hit.path]),
        [
          ['POST', '/auth/v1/token'],
          ['GET', '/auth/v1/.well-known/jwks.json'],
        ],
      );
      assert.deepEqual(authHits[0]?.query, { grant_type: 'password' });
      assert.equal(
        fixture.hits.filter((hit) => hit.path === '/api/platform/v1/me').length,
        2,
      );
      const expected = [
        ['POST', '/api/data/v1/upload-sessions'],
        ['POST', `/api/data/v1/upload-sessions/${uploadSessionId}/complete`],
        ['POST', '/api/data/v1/ingestions'],
        ['POST', `/api/data/v1/ingestions/${ingestionId}/submit`],
        ['GET', `/api/data/v1/ingestions/${ingestionId}`],
        ['GET', `/api/data/v1/operations/${operationId}`],
        ['GET', `/api/data/v1/operations/${operationId}/events`],
      ];
      for (const [method, path] of expected)
        assert(
          fixture.hits.some(
            (hit) => hit.method === method && hit.path === path,
          ),
        );
      const commandKeys = fixture.hits
        .filter((hit) => hit.service === 'api' && hit.method === 'POST')
        .map((hit) => hit.headers['idempotency-key']);
      assert.deepEqual(commandKeys, Object.values(idempotencyKeys));
      for (const assetId of assetIds) {
        const originals = fixture.hits.filter(
          (hit) => hit.path === `${fixture.contentBase}/${assetId}/content`,
        );
        assert.equal(originals.length, 1);
        assert.equal(originals[0]?.method, 'GET');
        assert.deepEqual(originals[0]?.query, {
          reviewHash: reference.reviewHash,
        });
        for (const action of ['records', 'geometry'])
          for (const first of ['50', '200'])
            assert(
              fixture.hits.some(
                (hit) =>
                  hit.path ===
                    `${fixture.candidateBase}/${assetId}/${action}` &&
                  hit.query.first === first,
              ),
            );
      }
      for (const first of ['50', '200'])
        assert(
          fixture.hits.some(
            (hit) =>
              hit.path === fixture.candidateBase && hit.query.first === first,
          ),
        );
      const outputs = [
        result.receiptBytes,
        result.inventoryBytes,
        result.captureBytes,
      ]
        .map((bytes) => Buffer.from(bytes).toString('utf8'))
        .join('\n');
      for (const secret of [
        fixture.token,
        fixture.credentialSentinel,
        fixture.storageSignature,
      ])
        assert.equal(outputs.includes(secret), false);
      assert.equal(body(result.captureBytes).standardAuthority, 'unknown');
      assert.deepEqual(host.options.api.diagnostics(), {
        activeRequests: 0,
        closed: true,
      });
      assert.deepEqual(host.options.original.diagnostics(), {
        activeRequests: 0,
        closed: true,
      });
      host.close();
      host.close();
      for (const asset of host.options.prepared)
        assert(asset.bytes.every((byte) => byte === 0));
      assert.deepEqual(fixture.fixtureErrors, []);
    } finally {
      collector?.close();
      host?.close();
      await fixture.close();
    }
  },
);

for (const [mode, kind] of [
  ['token-denied', 'denied'],
  ['bad-signature', 'denied'],
  ['me-denied', 'denied'],
  ['me-changed', 'stale'],
  ['me-unavailable', 'unavailable'],
] as const satisfies readonly (readonly [
  FixtureMode,
  CandidateLoadTransportError['kind'],
])[]) {
  test(
    `actual SDK/current identity ${mode} preserves ${kind}`,
    { timeout: 10_000 },
    async () => {
      const fixture = await startSyntheticLoopbackFixture(mode);
      try {
        await assert.rejects(
          constructActualCollectorOptions(fixture.configuration()),
          finiteKind(kind),
        );
        assert.equal(
          fixture.hits.some((hit) => hit.path.startsWith('/api/data/')),
          false,
        );
        if (mode === 'bad-signature') {
          assert(
            fixture.hits.some(
              (hit) => hit.path === '/auth/v1/.well-known/jwks.json',
            ),
          );
          assert.equal(
            fixture.hits.some((hit) => hit.path === '/api/platform/v1/me'),
            false,
          );
        }
        if (mode === 'me-changed')
          assert.equal(
            fixture.hits.filter((hit) => hit.path === '/api/platform/v1/me')
              .length,
            2,
          );
        assert.deepEqual(fixture.fixtureErrors, []);
      } finally {
        await fixture.close();
      }
    },
  );
}

test(
  'construction cleanup fault preserves current /me denial',
  { timeout: 10_000 },
  async () => {
    const original = Object.getOwnPropertyDescriptor(
      EventTarget.prototype,
      'removeEventListener',
    )!;
    let cleanupFaultCalls = 0;
    let fresh: typeof import('../../apps/web/e2e-live/support/a12-actual-collector-host.ts');
    // Capture one controlled cleanup fault in the actual host module. Restore the
    // global before constructing SDK/server objects. No factory/port/SDK is faked.
    try {
      Object.defineProperty(EventTarget.prototype, 'removeEventListener', {
        ...original,
        value: function () {
          cleanupFaultCalls++;
          throw new Error('SYNTHETIC_CLEANUP_FAULT');
        },
      });
      const moduleUrl = new URL(
        '../../apps/web/e2e-live/support/a12-actual-collector-host.ts?cleanup-fault-candidate=1',
        import.meta.url,
      ).href;
      fresh = (await import(
        moduleUrl
      )) as typeof import('../../apps/web/e2e-live/support/a12-actual-collector-host.ts');
    } finally {
      Object.defineProperty(
        EventTarget.prototype,
        'removeEventListener',
        original,
      );
    }
    const fixture = await startSyntheticLoopbackFixture('me-denied');
    const controller = new AbortController();
    try {
      await assert.rejects(
        fresh.constructActualCollectorOptions(
          fixture.configuration(),
          controller.signal,
        ),
        finiteKind('denied'),
      );
      assert.equal(
        cleanupFaultCalls,
        1,
        'The harness must actually capture one cleanup fault; a cached module is not a passing cleanup test',
      );
      assert.deepEqual(fixture.fixtureErrors, []);
    } finally {
      await fixture.close();
    }
  },
);

test(
  'native signal methods bypass caller subclass getters/listener overrides',
  { timeout: 10_000 },
  async () => {
    let traps = 0;
    class TrapSignal extends AbortSignal {
      override get aborted(): boolean {
        traps++;
        throw new Error('SYNTHETIC_GETTER_TRAP');
      }
      override addEventListener(): never {
        traps++;
        throw new Error('SYNTHETIC_ADD_TRAP');
      }
      override removeEventListener(): never {
        traps++;
        throw new Error('SYNTHETIC_REMOVE_TRAP');
      }
    }
    const controller = new AbortController();
    Object.setPrototypeOf(controller.signal, TrapSignal.prototype);
    const fixture = await startSyntheticLoopbackFixture();
    let host:
      Awaited<ReturnType<typeof constructActualCollectorOptions>> | undefined;
    try {
      host = await constructActualCollectorOptions(
        fixture.configuration(),
        controller.signal,
      );
      controller.abort();
      await assert.rejects(
        host.options.api.send({
          capabilityId: 'data.operation.get',
          input: { operationId },
        }),
        finiteKind('cancelled'),
      );
      assert.equal(traps, 0);
      for (const asset of host.options.prepared)
        assert(asset.bytes.every((byte) => byte === 0));
      assert.equal(
        fixture.hits.some((hit) => hit.path.startsWith('/api/data/')),
        false,
      );
    } finally {
      host?.close();
      await fixture.close();
    }
  },
);

test(
  'actual cumulative byte budget rejects before auth and accepts exact known-copy allocation',
  { timeout: 10_000 },
  async () => {
    const fixture = await startSyntheticLoopbackFixture();
    let host:
      Awaited<ReturnType<typeof constructActualCollectorOptions>> | undefined;
    try {
      const configuration = fixture.configuration();
      const total = configuration.prepared.reduce(
        (sum, asset) => sum + asset.bytes.byteLength,
        0,
      );
      const required =
        3 * total +
        Math.max(
          ...configuration.prepared.map((asset) => asset.bytes.byteLength),
        );
      assert.equal(configuration.preparedMemoryBudgetBytes, required);
      await assert.rejects(
        constructActualCollectorOptions({
          ...configuration,
          preparedMemoryBudgetBytes: required - 1,
        }),
        finiteKind('invalid'),
      );
      assert.equal(fixture.hits.length, 0);
      assert.deepEqual(
        configuration.prepared[0]!.bytes,
        fixture.originalBytes[0],
      );
      host = await constructActualCollectorOptions(configuration);
      assert.equal(
        fixture.hits.filter((hit) => hit.path === '/auth/v1/token').length,
        1,
      );
    } finally {
      host?.close();
      await fixture.close();
    }
  },
);

test(
  'shared bytes, missing resource budget and caller callback fail before actual SDK network',
  { timeout: 10_000 },
  async () => {
    const fixture = await startSyntheticLoopbackFixture();
    try {
      const configuration = fixture.configuration();
      const shared = new Uint8Array(
        new SharedArrayBuffer(configuration.prepared[0]!.sizeBytes),
      );
      shared.set(configuration.prepared[0]!.bytes);
      await assert.rejects(
        constructActualCollectorOptions({
          ...configuration,
          prepared: [
            { ...configuration.prepared[0]!, bytes: shared },
            configuration.prepared[1]!,
          ],
        }),
        finiteKind('invalid'),
      );
      const { preparedMemoryBudgetBytes: _budget, ...missing } = configuration;
      await assert.rejects(
        constructActualCollectorOptions(
          missing as ActualCollectorConfiguration,
        ),
        finiteKind('invalid'),
      );
      let callbacks = 0;
      const extra = {
        ...configuration,
        createClient: () => {
          callbacks++;
          throw new Error('SYNTHETIC_CALLER_CALLBACK');
        },
      };
      await assert.rejects(
        constructActualCollectorOptions(extra),
        finiteKind('invalid'),
      );
      assert.equal(callbacks, 0);
      assert.equal(fixture.hits.length, 0);
    } finally {
      await fixture.close();
    }
  },
);

for (const [mode, kind] of [
  ['submit-denied', 'denied'],
  ['original-drift', 'drift'],
] as const) {
  test(
    `actual current collector ${mode} retains ${kind} through cleanup`,
    { timeout: 10_000 },
    async () => {
      const fixture = await startSyntheticLoopbackFixture(mode);
      let host:
        Awaited<ReturnType<typeof constructActualCollectorOptions>> | undefined;
      let collector:
        ReturnType<typeof createA12StandardIntakeCollector> | undefined;
      try {
        host = await constructActualCollectorOptions(fixture.configuration());
        collector = createA12StandardIntakeCollector(host.options);
        const result = await collector.collect();
        assert.equal(result.status, 'failed');
        if (result.status !== 'failed')
          return assert.fail('Expected actual collector failure');
        assert.equal(result.reason, kind);
        assert.deepEqual(host.options.api.diagnostics(), {
          activeRequests: 0,
          closed: true,
        });
        assert.deepEqual(host.options.original.diagnostics(), {
          activeRequests: 0,
          closed: true,
        });
        assert.deepEqual(fixture.fixtureErrors, []);
      } finally {
        collector?.close();
        host?.close();
        await fixture.close();
      }
    },
  );
}

// Reproduced against the installed SDK and actual owned HTTP ports.
// Uses actual SDK password transport and native cancellation; no fake SDK/callback.
test(
  'owned cancellation during real SDK password HTTP remains cancelled',
  { timeout: 10_000 },
  async () => {
    const fixture = await startSyntheticLoopbackFixture('token-stalled');
    const controller = new AbortController();
    let host:
      Awaited<ReturnType<typeof constructActualCollectorOptions>> | undefined;
    try {
      // Observe either success/failure immediately; cancellation cannot cause an unhandled rejection.
      const outcome = constructActualCollectorOptions(
        fixture.configuration(),
        controller.signal,
      ).then(
        (value) => {
          host = value;
          return { status: 'constructed' as const };
        },
        (error: unknown) => ({ status: 'failed' as const, error }),
      );
      await Promise.race([
        fixture.tokenReceived,
        outcome.then(() => {
          throw new Error(
            'Construction settled before the synthetic password POST arrived',
          );
        }),
      ]); // An early SDK/config failure cannot hang waiting for an endpoint that was never called.
      controller.abort();
      const result = await outcome;
      assert.equal(result.status, 'failed');
      if (result.status !== 'failed')
        return assert.fail('Cancellation unexpectedly constructed a host');
      assert(result.error instanceof CandidateLoadTransportError);
      assert.equal(result.error.kind, 'cancelled');
      assert.equal(
        fixture.hits.filter((hit) => hit.service === 'auth').length,
        1,
      );
      assert.equal(fixture.hits[0]?.path, '/auth/v1/token');
      assert.deepEqual(fixture.fixtureErrors, []);
    } finally {
      host?.close();
      await fixture.close();
    }
  },
);

for (const mode of ['jwks-stalled', 'me-stalled'] as const) {
  test(
    `owned cancellation during ${mode} remains cancelled`,
    { timeout: 10_000 },
    async () => {
      const fixture = await startSyntheticLoopbackFixture(mode);
      const controller = new AbortController();
      let host:
        Awaited<ReturnType<typeof constructActualCollectorOptions>> | undefined;
      try {
        const outcome = constructActualCollectorOptions(
          fixture.configuration(),
          controller.signal,
        ).then(
          (value) => {
            host = value;
            return { status: 'constructed' as const };
          },
          (error: unknown) => ({ status: 'failed' as const, error }),
        );
        await Promise.race([
          mode === 'jwks-stalled'
            ? fixture.jwksReceived
            : fixture.identityReceived,
          outcome.then(() => {
            throw new Error(
              'Construction settled before the selected HTTP request arrived',
            );
          }),
        ]);
        controller.abort();
        const result = await outcome;
        assert.equal(result.status, 'failed');
        if (result.status !== 'failed')
          return assert.fail('Cancellation unexpectedly constructed a host');
        assert(result.error instanceof CandidateLoadTransportError);
        assert.equal(result.error.kind, 'cancelled');
        assert.equal(
          fixture.hits.filter((hit) => hit.path === '/auth/v1/token').length,
          1,
        );
        assert.equal(
          fixture.hits.filter(
            (hit) => hit.path === '/auth/v1/.well-known/jwks.json',
          ).length,
          1,
        );
        assert.equal(
          fixture.hits.filter((hit) => hit.path === '/api/platform/v1/me')
            .length,
          mode === 'me-stalled' ? 1 : 0,
        );
        assert.deepEqual(fixture.fixtureErrors, []);
      } finally {
        host?.close();
        await fixture.close();
      }
    },
  );
}
