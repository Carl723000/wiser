import assert from 'node:assert/strict';
import test from 'node:test';

import { startFullWiserStack } from './stack-full-up.mjs';
import { localComposeFixture } from './local-control-fixture.test-support.mjs';

test('complete local startup passes the same isolated environment to every child', async () => {
  const environment = {
    WISER_LOCAL_SUPABASE_WORKDIR: '/tmp/wiser-isolated-control',
    COMPOSE_PROJECT_NAME: 'wiser-isolated',
    DATA_API_ORIGIN: 'http://127.0.0.1:3641',
    DATA_WEB_ORIGIN: 'http://127.0.0.1:3640',
    DATA_MCP_ORIGIN: 'http://127.0.0.1:14004',
  };
  const calls = [];
  let startedEnvironment;
  const target = {
    workdir: environment.WISER_LOCAL_SUPABASE_WORKDIR,
    projectId: 'wiser-isolated',
    apiPort: 57321,
    databasePort: 57322,
  };
  await startFullWiserStack(environment, {
    readTarget: async () => target,
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === 'docker' && args[0] === 'context')
        return JSON.stringify('unix:///tmp/wiser-fixture.sock');
    },
    runCompose: async () =>
      JSON.stringify(localComposeFixture(target, environment)),
    startDataFoundation: async (selectedEnvironment) => {
      for (const [key, value] of Object.entries(environment))
        assert.equal(selectedEnvironment[key], value);
      assert.equal(
        selectedEnvironment.DOCKER_HOST,
        'unix:///tmp/wiser-fixture.sock',
      );
      startedEnvironment = {
        ...selectedEnvironment,
        DATA_API_BEARER_TOKEN:
          'synthetic-local-access-token-not-for-real-service',
      };
      return { environment: startedEnvironment };
    },
  });
  const controlStart = calls.find((call) => call.command === 'pnpm');
  assert.ok(controlStart.args.includes('--workdir'));
  assert.ok(
    controlStart.args.includes(environment.WISER_LOCAL_SUPABASE_WORKDIR),
  );
  for (const [key, value] of Object.entries(environment))
    assert.equal(controlStart.options.environment[key], value);
  assert.equal(
    controlStart.options.environment.DOCKER_HOST,
    startedEnvironment.DOCKER_HOST,
  );
  assert.equal(controlStart.options.capture, true);
  const children = calls.filter((call) => call.command === 'node');
  assert.deepEqual(
    children.map((call) => call.args[0]),
    [
      'scripts/data-foundation/migrate.mjs',
      'scripts/data-foundation/seed.mjs',
      'scripts/data-foundation/smoke.mjs',
    ],
  );
  for (const call of children) {
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
