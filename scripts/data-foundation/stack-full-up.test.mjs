import assert from 'node:assert/strict';
import test from 'node:test';

import { startFullWiserStack } from './stack-full-up.mjs';

test('complete local startup passes the same isolated environment to every child', async () => {
  const environment = {
    WISER_LOCAL_SUPABASE_WORKDIR: '/tmp/wiser-isolated-control',
    COMPOSE_PROJECT_NAME: 'wiser-isolated',
    DATA_API_ORIGIN: 'http://127.0.0.1:3641',
    DATA_WEB_ORIGIN: 'http://127.0.0.1:3640',
    DATA_MCP_ORIGIN: 'http://127.0.0.1:14004',
  };
  const calls = [];
  const startedEnvironment = {
    ...environment,
    DATA_API_BEARER_TOKEN: 'synthetic-local-access-token-not-for-real-service',
  };
  await startFullWiserStack(environment, {
    readTarget: async () => ({
      workdir: environment.WISER_LOCAL_SUPABASE_WORKDIR,
      projectId: 'wiser-isolated',
      apiPort: 57321,
      databasePort: 57322,
    }),
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
    },
    startDataFoundation: async (selectedEnvironment) => {
      assert.equal(selectedEnvironment, environment);
      return { environment: startedEnvironment };
    },
  });
  assert.ok(calls[0].args.includes('--workdir'));
  assert.ok(calls[0].args.includes(environment.WISER_LOCAL_SUPABASE_WORKDIR));
  assert.equal(calls[0].options.environment, environment);
  assert.equal(calls[0].options.capture, true);
  assert.deepEqual(
    calls.slice(1).map((call) => call.args[0]),
    [
      'scripts/data-foundation/migrate.mjs',
      'scripts/data-foundation/seed.mjs',
      'scripts/data-foundation/smoke.mjs',
    ],
  );
  for (const call of calls.slice(1)) {
    assert.equal(call.options.environment, startedEnvironment);
  }
});

test('complete startup rejects an inconsistent target before starting Supabase', async () => {
  const calls = [];
  await assert.rejects(
    startFullWiserStack(
      { COMPOSE_PROJECT_NAME: 'wiser' },
      {
        readTarget: async () => ({
          workdir: '/tmp/isolated',
          projectId: 'wiser-isolated',
        }),
        runCommand: async (...args) => {
          calls.push(args);
        },
        startDataFoundation: async () => {
          calls.push(['unexpected-data-start']);
        },
      },
    ),
    /local.*project|local.*target/i,
  );
  assert.deepEqual(calls, []);
});
