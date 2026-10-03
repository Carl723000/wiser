import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DATA_SERVICES,
  REQUIRED_CAPABILITY_IDS,
  assertComposeServicesHealthy,
  assertDataHealth,
  buildSeedSql,
  parseComposePsOutput,
  requireResetConfirmation,
  validateCapabilities,
  verifyFixtureBundle,
  runPostgresSql,
  runCompose,
} from './operations.mjs';

test('parses Docker Compose JSON arrays and line-delimited records', () => {
  const services = [
    { Service: 'data-postgres', State: 'running', Health: 'healthy' },
    { Service: 'seaweedfs', State: 'running', Health: 'healthy' },
  ];

  assert.deepEqual(parseComposePsOutput(JSON.stringify(services)), services);
  assert.deepEqual(
    parseComposePsOutput(
      services.map((entry) => JSON.stringify(entry)).join('\n'),
    ),
    services,
  );
});

for (const existing of [false, true]) {
  test(`compiled local Compose includes ${existing ? 'the unchanged manual override' : 'an empty override for a clean clone'}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wiser-compose-isolation-'));
    try {
      await mkdir(join(directory, 'supabase'));
      await writeFile(
        join(directory, 'supabase/config.toml'),
        'project_id = "wiser"\n[api]\nport = 56321\n[db]\nport = 56322\n',
      );
      await writeFile(
        join(directory, 'compose.yaml'),
        'name: wiser\nservices:\n  dummy:\n    image: test-only:never-started\n',
      );
      const override = 'services:\n  dummy:\n    labels:\n      manual: keep\n';
      if (existing)
        await writeFile(join(directory, 'compose.override.yaml'), override);
      const output = await runCompose(
        ['config', '--format', 'json'],
        {
          environment: {
            ...process.env,
            COMPOSE_PROJECT_NAME: 'wiser',
            WISER_LOCAL_SUPABASE_WORKDIR: directory,
          },
        },
        {
          rootDirectory: directory,
          runCommand: async (command, args, options) => {
            assert.equal(command, 'docker');
            return (
              await promisify(execFile)(command, args, {
                cwd: directory,
                env: options.environment,
              })
            ).stdout;
          },
        },
      );
      const configuration = JSON.parse(output);
      assert.equal(configuration.name, 'wiser');
      const after = await readFile(
        join(directory, 'compose.override.yaml'),
        'utf8',
      );
      if (existing) {
        assert.equal(after, override);
        assert.equal(configuration.services.dummy.labels.manual, 'keep');
      } else assert.equal(after, 'services: {}\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('requires every long-running Data Foundation service to be healthy', () => {
  const healthy = DATA_SERVICES.map((Service) => ({
    Service,
    State: 'running',
    Health: 'healthy',
  }));
  assert.doesNotThrow(() => assertComposeServicesHealthy(healthy));
  assert.throws(
    () =>
      assertComposeServicesHealthy(
        healthy.map((service) =>
          service.Service === 'opensearch'
            ? { ...service, Health: 'unhealthy' }
            : service,
        ),
      ),
    /opensearch/,
  );
});

test('validates truthful API health and the complete Capability registry', () => {
  assert.doesNotThrow(() =>
    assertDataHealth({
      status: 'ready',
      system: 'data-foundation',
      authority: { database: true, objectStore: true },
      worker: true,
      projections: 'rebuildable',
    }),
  );
  assert.throws(
    () =>
      assertDataHealth({
        status: 'degraded',
        system: 'data-foundation',
        authority: { database: true, objectStore: false },
        worker: true,
      }),
    /not ready/,
  );

  assert.doesNotThrow(() =>
    validateCapabilities({
      registryVersion: '2.0.0',
      capabilities: REQUIRED_CAPABILITY_IDS.map((id) => ({ id })),
    }),
  );
  for (const registryVersion of ['0.0.0', '2.0.0-beta.1', 'latest']) {
    assert.throws(
      () =>
        validateCapabilities({
          registryVersion,
          capabilities: REQUIRED_CAPABILITY_IDS.map((id) => ({ id })),
        }),
      /invalid envelope/,
    );
  }
  assert.throws(
    () =>
      validateCapabilities({
        registryVersion: '2.0.0',
        capabilities: [{ id: 'data.catalog.search' }],
      }),
    /missing required capability/,
  );
});

test('verifies immutable fixtures and builds an idempotent, drift-detecting seed', async () => {
  const fixture = await verifyFixtureBundle();
  assert.deepEqual(fixture, {
    geojsonSha256:
      '35361986ce6b364c99dbcefc56ac266c07dac5dbdff2a95dfe392c3eac9bc975',
    evidenceSha256:
      '123afced4bc8e32ced1065c9d3d28d3118387f0a36b84e146cbbbbee861db930',
    stationCount: 2,
  });
  const sql = buildSeedSql(fixture);
  assert.match(sql, /insert into catalog\.data_item/i);
  assert.match(sql, /on conflict \(data_item_id\) do nothing/i);
  assert.match(
    sql,
    /raise exception 'deterministic Data Foundation seed conflicts/i,
  );
  assert.match(sql, new RegExp(fixture.geojsonSha256));
  assert.match(sql, new RegExp(fixture.evidenceSha256));
});

test('requires an exact destructive reset confirmation', () => {
  assert.throws(() => requireResetConfirmation({}), /WISER_DATA_RESET_CONFIRM/);
  assert.doesNotThrow(() =>
    requireResetConfirmation({
      WISER_DATA_RESET_CONFIRM: 'reset-wiser-data-foundation',
    }),
  );
});

test('SQL adapter uses the explicitly selected control and Compose environment', async () => {
  const environment = {
    COMPOSE_PROJECT_NAME: 'wiser-isolated',
    WISER_LOCAL_SUPABASE_WORKDIR: '/tmp/isolated-control',
  };
  const calls = [];
  await runPostgresSql(
    'select 1;',
    { environment },
    {
      readTarget: async (selected) => {
        assert.ok(
          selected === environment,
          'explicit SQL environment was not propagated',
        );
        return {
          projectId: 'wiser-isolated',
          workdir: '/tmp/isolated-control',
        };
      },
      runCommand: async (command, args, options) => {
        calls.push({ command, args, options });
        if (args.includes('config'))
          return JSON.stringify({ name: 'wiser-isolated', volumes: {} });
        return '1';
      },
    },
  );
  assert.equal(calls.at(-1).options.environment, environment);
  assert.equal(calls.at(-1).options.input, 'select 1;');
});
