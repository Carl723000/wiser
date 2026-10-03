import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertLocalComposeTarget,
  assertLocalDatabaseContainer,
  assertLocalSupabaseStatus,
  localJournalDatabaseUrl,
} from './local-control-target.mjs';
import {
  isolatedEnvironment,
  isolatedTarget,
  localComposeFixture,
} from './local-control-fixture.test-support.mjs';

const status = {
  apiUrl: 'http://127.0.0.1:57321',
  databaseUrl: 'postgresql://postgres:synthetic@127.0.0.1:57322/postgres',
};

test('local control and compiled service targets agree without relying on caller environment', () => {
  assert.doesNotThrow(() => assertLocalSupabaseStatus(status, isolatedTarget));
  assert.doesNotThrow(() =>
    assertLocalComposeTarget(
      JSON.stringify(localComposeFixture()),
      isolatedTarget,
      isolatedEnvironment,
    ),
  );
});

for (const query of [
  'host=127.0.0.1&port=56322',
  'host=remote.invalid',
  'user=unexpected',
]) {
  test(`database routing options cannot override the isolated target: ${query}`, () => {
    const redirected = {
      ...status,
      databaseUrl: `${status.databaseUrl}?${query}`,
    };
    assert.throws(
      () => assertLocalSupabaseStatus(redirected, isolatedTarget),
      /local.*target/i,
    );
    assert.throws(
      () =>
        localJournalDatabaseUrl(
          redirected,
          'synthetic_local_password_1234567890',
        ),
      /local.*target/i,
    );
  });
}

for (const [label, change] of [
  [
    'old Auth address',
    (document) => {
      document.services.api.environment.SUPABASE_URL =
        'http://host.docker.internal:56321';
    },
  ],
  [
    'old control database',
    (document) => {
      document.services.api.environment.DATABASE_URL =
        'postgresql://postgres:synthetic@host.docker.internal:56322/postgres';
    },
  ],
  [
    'old journal database',
    (document) => {
      document.services.api.environment.EXCON_JOURNAL_DATABASE_URL =
        'postgresql://wiser_excon_api:synthetic@host.docker.internal:56322/postgres';
    },
  ],
  [
    'old browser Auth',
    (document) => {
      document.services.web.environment.NEXT_PUBLIC_SUPABASE_URL =
        'http://127.0.0.1:56321';
    },
  ],
  [
    'Data database outside project network',
    (document) => {
      document.services['data-worker'].environment.DATA_DATABASE_URL =
        'postgresql://wiser_data_worker:synthetic@remote.invalid:5432/wiser_data';
    },
  ],
  [
    'old public file endpoint',
    (document) => {
      document.services.api.environment.DATA_S3_PUBLIC_ENDPOINT =
        'http://127.0.0.1:18333';
    },
  ],
  [
    'non-loopback public binding',
    (document) => {
      document.services.api.ports[0].host_ip = '0.0.0.0';
    },
  ],
  [
    'incorrect internal API port',
    (document) => {
      document.services.api.ports[0].target = 9999;
    },
  ],
  [
    'missing declared volumes',
    (document) => {
      document.volumes = {};
    },
  ],
  [
    'Data database on old bind directory',
    (document) => {
      document.services['data-postgres'].volumes[0] = {
        type: 'bind',
        source: '/tmp/old-project-data',
        target: '/var/lib/postgresql',
      };
    },
  ],
  [
    'missing Data database mount',
    (document) => {
      document.services['data-postgres'].volumes = [];
    },
  ],
  [
    'named volume backed by old bind directory',
    (document) => {
      document.volumes['data-postgres-data'].driver_opts = {
        type: 'none',
        o: 'bind',
        device: '/tmp/old-project-data',
      };
    },
  ],
]) {
  test(`refuses compiled ${label}`, () => {
    const document = localComposeFixture();
    change(document);
    assert.throws(
      () =>
        assertLocalComposeTarget(
          JSON.stringify(document),
          isolatedTarget,
          isolatedEnvironment,
        ),
      /local.*target/i,
    );
  });
}

test('Supabase database mount must belong to the same local project', () => {
  const inspection = {
    name: '/supabase_db_wiser-isolated',
    running: true,
    ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '57322' }] },
    mounts: [
      {
        Type: 'volume',
        Name: 'supabase_db_wiser-isolated',
        Destination: '/var/lib/postgresql/data',
        RW: true,
      },
    ],
  };
  assert.doesNotThrow(() =>
    assertLocalDatabaseContainer(JSON.stringify(inspection), isolatedTarget),
  );
  inspection.mounts[0].Name = 'supabase_db_wiser';
  assert.throws(
    () =>
      assertLocalDatabaseContainer(JSON.stringify(inspection), isolatedTarget),
    /local.*target/i,
  );
});
