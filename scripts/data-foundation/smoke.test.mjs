import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as vm from 'node:vm';

import { DATA_ALL_SERVICES } from './operations.mjs';
import { VerticalSmokeError } from './vertical-smoke.mjs';

const MOCK_FLAG = '--experimental-vm-modules';

if (!process.execArgv.includes(MOCK_FLAG)) {
  test('offline smoke preflight regressions with native VM module mocks', () => {
    const result = spawnSync(
      process.execPath,
      [MOCK_FLAG, '--test', fileURLToPath(import.meta.url)],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
} else {
  const { createContext, SourceTextModule, SyntheticModule } = vm;
  const SECRET = 'synthetic-private-diagnostic-marker';
  const phases = [
    ['verifyFixtureBundle', 'fixture-bundle'],
    ['assertMigrationsApplied', 'authority-migrations'],
    ['assertPgStacMigrated', 'pgstac-schema'],
    ['assertRuntimeRoles', 'runtime-roles'],
    ['composeHealthCheck', 'compose-health'],
    ['apiContractCheck', 'api-contract'],
    ['assertSeedFixture', 'seed-fixture'],
  ];
  const sourceUrl = new URL('./smoke.mjs', import.meta.url);
  const source = await readFile(sourceUrl, 'utf8');
  const plain = (value) => JSON.parse(JSON.stringify(value));

  async function harness(overrides = {}) {
    const fixture = {
      geojsonSha256: 'a'.repeat(64),
      evidenceSha256: 'b'.repeat(64),
      stationCount: 2,
    };
    const migrations = [
      '0001_bootstrap.sql',
      '0043_candidate_conversion_trust.sql',
    ];
    const roles = { api: true, worker: true, rls: true };
    const services = [{ Service: 'data-postgres' }, { Service: 'data-worker' }];
    const seed = { dataItemId: 'synthetic-seed', stationCount: 2 };
    const vertical = { status: 'ok', steps: ['synthetic-vertical'] };
    const calls = [];
    const logCalls = [];
    const stdout = [];
    const stderr = [];
    const values = {
      verifyFixtureBundle: fixture,
      assertMigrationsApplied: migrations,
      assertPgStacMigrated: true,
      assertRuntimeRoles: roles,
      composeHealthCheck: services,
      apiContractCheck: { capabilityCount: 51 },
      assertSeedFixture: seed,
    };
    const checks = Object.fromEntries(
      phases.map(([name]) => [
        name,
        async (...args) => {
          calls.push(name);
          if (name === 'assertSeedFixture') assert.equal(args[0], fixture);
          return overrides[name] ? overrides[name](...args) : values[name];
        },
      ]),
    );
    const operations = {
      DATA_ALL_SERVICES,
      isDirectExecution: () => false,
      ...checks,
      runCompose: async (args, options) => {
        logCalls.push({ args, options });
        if (overrides.runCompose) return overrides.runCompose(args, options);
      },
    };
    const verticalModule = {
      VerticalSmokeError,
      runDataFoundationVerticalSmoke: async (options) => {
        calls.push('vertical');
        return overrides.vertical ? overrides.vertical(options) : vertical;
      },
    };
    const context = createContext({
      Error,
      process: {
        stdout: {
          write(chunk) {
            stdout.push(String(chunk));
            return true;
          },
        },
        stderr: {
          write(chunk) {
            stderr.push(String(chunk));
            return true;
          },
        },
      },
    });
    const module = new SourceTextModule(source, {
      context,
      identifier: sourceUrl.href,
    });
    await module.link((specifier) => {
      const exports = {
        './operations.mjs': operations,
        './vertical-smoke.mjs': verticalModule,
      }[specifier];
      assert.ok(
        exports,
        'only the fixed local operation adapters may be mocked',
      );
      return new SyntheticModule(
        Object.keys(exports),
        function () {
          for (const [name, value] of Object.entries(exports))
            this.setExport(name, value);
        },
        { context },
      );
    });
    await module.evaluate();
    const { smokeDataFoundation } = module.namespace;
    return {
      run: smokeDataFoundation,
      fixture,
      migrations,
      roles,
      services,
      seed,
      vertical,
      calls,
      logCalls,
      stdout,
      stderr,
    };
  }

  function assertSafe(h, error) {
    assert.equal(inspect(error).includes(SECRET), false);
    assert.equal([...h.stdout, ...h.stderr].join('').includes(SECRET), false);
    assert.equal(error.message, 'Data Foundation smoke failed safely.');
  }

  for (const [name, phase] of phases) {
    test(`identifies ${phase} failure without exposing the underlying error`, async () => {
      const h = await harness({
        [name]: async () => {
          throw new Error(SECRET, {
            cause: { sql: SECRET, response: SECRET, environment: SECRET },
          });
        },
      });
      await assert.rejects(h.run(), (error) => {
        assertSafe(h, error);
        assert.deepEqual(plain(error.cause), { phase, errorName: 'Error' });
        return true;
      });
      assert.deepEqual(
        h.calls,
        name === 'verifyFixtureBundle'
          ? ['verifyFixtureBundle']
          : phases.map(([check]) => check),
      );
      assert.equal(h.logCalls.length, 1);
      assert.deepEqual(plain(h.logCalls[0]), {
        args: [
          'logs',
          '--no-color',
          '--tail',
          '200',
          ...new Set([...DATA_ALL_SERVICES, 'api', 'web']),
        ],
        options: { capture: false },
      });
    });
  }

  test('successful preflight keeps the exact report and stdout shape', async () => {
    const verticalOptions = { synthetic: true };
    const h = await harness({
      vertical: async (options) => {
        assert.equal(options, verticalOptions);
        return { status: 'ok', steps: ['synthetic-vertical'] };
      },
    });
    const report = await h.run({ vertical: verticalOptions });
    const expected = {
      status: 'ok',
      migrationCount: 2,
      healthyServiceCount: 2,
      capabilityCount: 51,
      roles: h.roles,
      fixture: h.fixture,
      seed: h.seed,
      vertical: h.vertical,
    };
    assert.deepEqual(plain(report), expected);
    assert.deepEqual(h.stdout, [`${JSON.stringify(expected)}\n`]);
    assert.deepEqual(h.stderr, []);
    assert.deepEqual(h.calls, [...phases.map(([name]) => name), 'vertical']);
    assert.equal(h.logCalls.length, 0);
  });

  test('all six prechecks start together and vertical waits for every result', async () => {
    const pending = [];
    const overrides = Object.fromEntries(
      phases.slice(1).map(([name]) => [
        name,
        () =>
          new Promise((resolve) => {
            pending.push({ name, resolve });
          }),
      ]),
    );
    const h = await harness(overrides);
    const running = h.run();
    await new Promise(setImmediate);
    assert.deepEqual(
      h.calls,
      phases.map(([name]) => name),
    );
    assert.equal(pending.length, 6);
    for (const { name, resolve } of pending) {
      const value = {
        assertMigrationsApplied: h.migrations,
        assertPgStacMigrated: true,
        assertRuntimeRoles: h.roles,
        composeHealthCheck: h.services,
        apiContractCheck: { capabilityCount: 51 },
        assertSeedFixture: h.seed,
      }[name];
      resolve(value);
    }
    await running;
    assert.equal(h.calls.at(-1), 'vertical');
  });

  for (const [title, reason, errorName] of [
    ['built-in exception', new TypeError(SECRET), 'TypeError'],
    [
      'custom exception name',
      Object.assign(new Error(SECRET), { name: SECRET }),
      'unknown',
    ],
    ['non-Error rejection', { message: SECRET, name: SECRET }, 'unknown'],
    [
      'throwing name accessor',
      Object.defineProperty(new Error(SECRET), 'name', {
        get() {
          throw new Error(SECRET);
        },
      }),
      'unknown',
    ],
  ]) {
    test(`sanitizes ${title} while retaining the failed phase`, async () => {
      const h = await harness({
        apiContractCheck: async () => {
          throw reason;
        },
      });
      await assert.rejects(h.run(), (error) => {
        assertSafe(h, error);
        assert.deepEqual(plain(error.cause), {
          phase: 'api-contract',
          errorName,
        });
        return true;
      });
    });
  }

  test('failed default log collection cannot replace the preflight cause', async () => {
    const h = await harness({
      assertRuntimeRoles: async () => {
        throw new RangeError(SECRET);
      },
      runCompose: async () => {
        throw new Error(SECRET);
      },
    });
    await assert.rejects(h.run(), (error) => {
      assertSafe(h, error);
      assert.deepEqual(plain(error.cause), {
        phase: 'runtime-roles',
        errorName: 'RangeError',
      });
      return true;
    });
    assert.equal(h.logCalls.length, 1);
    assert.deepEqual(h.stderr, [
      'Data Foundation smoke logs could not be collected safely.\n',
    ]);
  });

  test('failed custom log collection cannot replace the preflight cause', async () => {
    const h = await harness({
      assertRuntimeRoles: async () => {
        throw new RangeError(SECRET);
      },
    });
    let collections = 0;
    await assert.rejects(
      h.run({
        printFailureLogs: async () => {
          collections++;
          throw new Error(SECRET);
        },
      }),
      (error) => {
        assertSafe(h, error);
        assert.deepEqual(plain(error.cause), {
          phase: 'runtime-roles',
          errorName: 'RangeError',
        });
        return true;
      },
    );
    assert.equal(collections, 1);
    assert.deepEqual(h.stderr, [
      'Data Foundation smoke logs could not be collected safely.\n',
    ]);
  });

  for (const logsFail of [false, true]) {
    test(`preserves the exact vertical exception when log collection ${logsFail ? 'fails' : 'succeeds'}`, async () => {
      const failure = new VerticalSmokeError(
        'fixtures-uploaded',
        'TEST_FAILURE',
        503,
      );
      const h = await harness({
        vertical: async () => {
          throw failure;
        },
      });
      let collections = 0;
      await assert.rejects(
        h.run({
          printFailureLogs: async () => {
            collections++;
            if (logsFail) throw new Error(SECRET);
          },
        }),
        (error) => {
          assert.equal(error === failure, true);
          return true;
        },
      );
      assert.equal(collections, 1);
      assert.equal([...h.stdout, ...h.stderr].join('').includes(SECRET), false);
      assert.deepEqual(h.calls, [...phases.map(([name]) => name), 'vertical']);
    });
  }
}
