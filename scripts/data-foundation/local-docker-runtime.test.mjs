import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveLocalDockerEnvironment } from './local-docker-runtime.mjs';

for (const [label, environment, resolved] of [
  ['SSH host', { DOCKER_HOST: 'ssh://remote.invalid' }],
  ['TCP host', { DOCKER_HOST: 'tcp://127.0.0.1:2375' }],
  [
    'ambiguous context and host',
    { DOCKER_CONTEXT: 'fixture', DOCKER_HOST: 'unix:///tmp/fixture.sock' },
  ],
  [
    'remote context endpoint',
    { DOCKER_CONTEXT: 'fixture' },
    'ssh://remote.invalid',
  ],
  ['relative socket', { DOCKER_HOST: 'unix://relative.sock' }],
  [
    'socket with options',
    { DOCKER_HOST: 'unix:///tmp/fixture.sock?host=remote.invalid' },
  ],
]) {
  test(`rejects ${label} before any service operation`, async () => {
    await assert.rejects(
      resolveLocalDockerEnvironment(environment, async () =>
        JSON.stringify(resolved),
      ),
      /local.*Docker|local.*endpoint/i,
    );
  });
}

test('resolves context metadata once and pins a single local Unix endpoint', async () => {
  const calls = [];
  const environment = {
    DOCKER_CONTEXT: 'fixture',
    DATA_API_ORIGIN: 'http://127.0.0.1:3641',
  };
  const result = await resolveLocalDockerEnvironment(
    environment,
    async (command, args, options) => {
      calls.push({ command, args, options });
      return JSON.stringify('unix:///tmp/wiser-fixture.sock');
    },
  );
  assert.equal(result.DOCKER_HOST, 'unix:///tmp/wiser-fixture.sock');
  assert.equal(result.DOCKER_CONTEXT, undefined);
  assert.equal(result.DATA_API_ORIGIN, environment.DATA_API_ORIGIN);
  assert.equal(environment.DOCKER_CONTEXT, 'fixture');
  assert.deepEqual(
    calls.map(({ command, args }) => [command, ...args]),
    [
      [
        'docker',
        'context',
        'inspect',
        'fixture',
        '--format',
        '{{json .Endpoints.docker.Host}}',
      ],
    ],
  );
});

test('never exposes invalid context metadata in the error', async () => {
  const marker = 'SYNTHETIC_PRIVATE_CONTEXT_TAG';
  await assert.rejects(
    resolveLocalDockerEnvironment({}, async () => marker),
    (error) => {
      assert.doesNotMatch(String(error), new RegExp(marker));
      return true;
    },
  );
});
