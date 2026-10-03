import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { ROOT_DIRECTORY } from './operations.mjs';
import { localRuntimeSecrets, startDataFoundation } from './up.mjs';
import { localComposeFixture } from './local-control-fixture.test-support.mjs';

const publishableKey = 'sb_publishable_1234567890abcdefghijklmnop';
const journalPassword = 'synthetic_local_password_1234567890';
const secrets = {
  version: 1,
  exconJournalPassword: journalPassword,
  exconLeaseHmacKeys: {
    activeKeyId: 'fixture',
    keys: { fixture: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
  },
  delegatedCredentialHmacKeys: {
    activeKeyId: 'fixture',
    keys: { fixture: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
  },
};

function harness(overrides = {}) {
  const target = {
    workdir: '/tmp/wiser-isolated-control',
    projectId: 'wiser-isolated',
    apiPort: 57321,
    databasePort: 57322,
    ...overrides.target,
  };
  const environment = {
    WISER_LOCAL_SUPABASE_WORKDIR: target.workdir,
    COMPOSE_PROJECT_NAME: target.projectId,
    DATA_API_ORIGIN: 'http://127.0.0.1:3641',
    DATA_WEB_ORIGIN: 'http://127.0.0.1:3640',
    DATA_MCP_ORIGIN: 'http://127.0.0.1:14004',
    ...overrides.environment,
  };
  const calls = [];
  const inspection = {
    name: `/supabase_db_${target.projectId}`,
    running: true,
    ports: {
      '5432/tcp': [
        { HostIp: '127.0.0.1', HostPort: String(target.databasePort) },
      ],
    },
    mounts: [
      {
        Type: 'volume',
        Name: `supabase_db_${target.projectId}`,
        Destination: '/var/lib/postgresql/data',
        RW: true,
      },
    ],
    ...overrides.inspection,
  };
  const status =
    overrides.status ??
    `API_URL="http://127.0.0.1:${target.apiPort}"\nDB_URL="postgresql://postgres:synthetic@127.0.0.1:${target.databasePort}/postgres"\nPUBLISHABLE_KEY="${publishableKey}"\n`;
  const dependencies = {
    readTarget: async (selectedEnvironment) => {
      calls.push({ kind: 'target', environment: selectedEnvironment });
      return target;
    },
    runCommand: async (command, args, options) => {
      calls.push({ kind: 'command', command, args, options });
      if (command === 'docker' && args[0] === 'context')
        return JSON.stringify('unix:///tmp/wiser-fixture.sock');
      if (command === 'pnpm') return status;
      if (command === 'docker' && args[0] === 'inspect') {
        return JSON.stringify(inspection);
      }
      return '';
    },
    readSecrets: async (workdir) => {
      calls.push({ kind: 'secrets', workdir });
      return secrets;
    },
    signIn: async (selectedStatus) => {
      calls.push({ kind: 'sign-in', status: selectedStatus });
      return 'synthetic-access-token-with-safe-minimum-length';
    },
    runCompose: async (args, options) => {
      calls.push({ kind: 'compose', args, options });
      if (args[0] === 'config')
        return JSON.stringify(localComposeFixture(target, environment));
    },
  };
  return { target, environment, dependencies, calls };
}

test('isolated bootstrap uses one control directory, database and journal port', async () => {
  const setup = harness();
  const started = await startDataFoundation(
    setup.environment,
    setup.dependencies,
  );
  const status = setup.calls.find((call) => call.command === 'pnpm');
  assert.ok(status.args.includes('--workdir'));
  assert.ok(status.args.includes(setup.target.workdir));
  const roleWrite = setup.calls.find(
    (call) => call.command === 'docker' && call.args?.[0] === 'exec',
  );
  assert.equal(roleWrite.args[2], 'supabase_db_wiser-isolated');
  assert.match(roleWrite.options.input, /alter role wiser_excon_api/);
  assert.equal(
    roleWrite.options.environment.DOCKER_HOST,
    'unix:///tmp/wiser-fixture.sock',
  );
  assert.equal(
    status.options.environment.DOCKER_HOST,
    roleWrite.options.environment.DOCKER_HOST,
  );
  const compose = setup.calls.find(
    (call) => call.kind === 'compose' && call.args[0] === 'up',
  );
  assert.equal(
    compose.options.environment.EXCON_JOURNAL_DATABASE_URL,
    `postgresql://wiser_excon_api:${journalPassword}@host.docker.internal:57322/postgres`,
  );
  assert.equal(
    compose.options.environment.DATABASE_URL,
    'postgresql://postgres:synthetic@host.docker.internal:57322/postgres',
  );
  assert.equal(
    compose.options.environment.NEXT_PUBLIC_SUPABASE_URL,
    'http://127.0.0.1:57321',
  );
  assert.equal(started.environment, compose.options.environment);
  assert.equal(
    started.environment.DOCKER_HOST,
    roleWrite.options.environment.DOCKER_HOST,
  );
  assert.equal(
    setup.calls.find((call) => call.kind === 'secrets').workdir,
    setup.target.workdir,
  );
});

for (const [label, changes] of [
  [
    'database port from another project',
    {
      status: `API_URL="http://127.0.0.1:57321"\nDB_URL="postgresql://postgres:synthetic@127.0.0.1:56322/postgres"\nPUBLISHABLE_KEY="${publishableKey}"\n`,
    },
  ],
  [
    'Auth port from another project',
    {
      status: `API_URL="http://127.0.0.1:56321"\nDB_URL="postgresql://postgres:synthetic@127.0.0.1:57322/postgres"\nPUBLISHABLE_KEY="${publishableKey}"\n`,
    },
  ],
  [
    'remote database address',
    {
      status: `API_URL="http://127.0.0.1:57321"\nDB_URL="postgresql://postgres:synthetic@remote.invalid:57322/postgres"\nPUBLISHABLE_KEY="${publishableKey}"\n`,
    },
  ],
  ['wrong Compose project', { environment: { COMPOSE_PROJECT_NAME: 'wiser' } }],
  ['stopped database container', { inspection: { running: false } }],
  ['wrong database container', { inspection: { name: '/supabase_db_wiser' } }],
  [
    'database binding on an old port',
    {
      inspection: {
        ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '56322' }] },
      },
    },
  ],
]) {
  test(`refuses ${label} before secrets, role writes or sign-in`, async () => {
    const setup = harness(changes);
    await assert.rejects(
      startDataFoundation(setup.environment, setup.dependencies),
      /local.*target|local.*project|local.*database/i,
    );
    assert.equal(
      setup.calls.filter((call) => call.kind === 'secrets').length,
      0,
    );
    assert.equal(
      setup.calls.filter(
        (call) => call.command === 'docker' && call.args?.[0] === 'exec',
      ).length,
      0,
    );
    assert.equal(
      setup.calls.filter((call) => call.kind === 'sign-in').length,
      0,
    );
    assert.equal(
      setup.calls.filter(
        (call) => call.kind === 'compose' && call.args[0] === 'up',
      ).length,
      0,
    );
  });
}

test('keeps the default local operator and existing runtime role', async () => {
  const setup = harness({
    target: {
      workdir: ROOT_DIRECTORY,
      projectId: 'wiser',
      apiPort: 56321,
      databasePort: 56322,
    },
  });
  await startDataFoundation(setup.environment, setup.dependencies);
  const compose = setup.calls.find(
    (call) => call.kind === 'compose' && call.args[0] === 'up',
  );
  assert.equal(compose.options.environment.WISER_AUTH_MODE, 'supabase');
  assert.equal(compose.options.environment.EXCON_V2_MODE, 'postgres');
  assert.match(
    compose.options.environment.EXCON_JOURNAL_DATABASE_URL,
    /:56322\/postgres$/,
  );
  assert.equal(
    setup.calls.find(
      (call) => call.command === 'docker' && call.args?.[0] === 'exec',
    ).args[2],
    'supabase_db_wiser',
  );
});

test('invalid local secret state never exposes its contents in an error cause', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wiser-secret-isolation-'));
  try {
    await mkdir(join(directory, '.wiser/local'), { recursive: true });
    const marker = 'SYNTHETIC';
    await writeFile(
      join(directory, '.wiser/local/runtime-secrets.json'),
      `{"token":${marker}}`,
    );
    await assert.rejects(localRuntimeSecrets(directory), (error) => {
      assert.doesNotMatch(inspect(error), new RegExp(marker));
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
