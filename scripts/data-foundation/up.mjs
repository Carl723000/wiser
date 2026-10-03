import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  isDirectExecution,
  ROOT_DIRECTORY,
  runCommand,
  runCompose,
} from './operations.mjs';
import {
  buildSupabaseComposeEnvironment,
  parseSupabaseStatusEnvironment,
  signInLocalOperator,
} from './supabase-runtime.mjs';
import {
  assertLocalComposeTarget,
  assertLocalDatabaseContainer,
  assertLocalProject,
  assertLocalSupabaseStatus,
  localJournalDatabaseUrl,
  localBootstrapEnvironment,
  localSupabaseArguments,
  readLocalSupabaseTarget,
} from './local-control-target.mjs';

const LOCAL_OPERATOR_EMAIL = 'operator@agent-excon.test';
const LOCAL_OPERATOR_PASSWORD = 'WiserLocalOperator-2026!';

function ephemeralKeyRing() {
  return {
    activeKeyId: 'local-ephemeral',
    keys: { 'local-ephemeral': randomBytes(32).toString('base64url') },
  };
}

function validLocalSecrets(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    value.version === 1 &&
    typeof value.exconJournalPassword === 'string' &&
    /^[A-Za-z0-9_-]{32,128}$/.test(value.exconJournalPassword) &&
    value.exconLeaseHmacKeys !== null &&
    typeof value.exconLeaseHmacKeys === 'object' &&
    value.delegatedCredentialHmacKeys !== null &&
    typeof value.delegatedCredentialHmacKeys === 'object'
  );
}

export async function localRuntimeSecrets(workdir = ROOT_DIRECTORY) {
  const directory = join(workdir, '.wiser/local');
  const path = join(directory, 'runtime-secrets.json');
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (!validLocalSecrets(parsed)) throw new Error('invalid local state');
    return parsed;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error('Local WISER runtime secret state is invalid.');
    }
  }
  const created = {
    version: 1,
    exconJournalPassword: randomBytes(32).toString('base64url'),
    exconLeaseHmacKeys: ephemeralKeyRing(),
    delegatedCredentialHmacKeys: ephemeralKeyRing(),
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(created)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  }).catch(async (error) => {
    if (error?.code !== 'EEXIST') throw error;
  });
  let persisted;
  try {
    persisted = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('Local WISER runtime secret state is invalid.');
  }
  if (!validLocalSecrets(persisted)) {
    throw new Error('Local WISER runtime secret state is invalid.');
  }
  return persisted;
}

async function provisionExconRuntime(
  password,
  environment,
  target,
  execute = runCommand,
) {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(password)) {
    throw new Error('Local EXCON runtime password is invalid.');
  }
  await execute(
    'docker',
    [
      'exec',
      '-i',
      `supabase_db_${target.projectId}`,
      'psql',
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '--username',
      'postgres',
      '--dbname',
      'postgres',
    ],
    {
      environment,
      input: `alter role wiser_excon_api with login password '${password}';\n`,
    },
  );
}

export async function startDataFoundation(
  environment = process.env,
  dependencies = {},
) {
  const execute = dependencies.runCommand ?? runCommand;
  const compose = dependencies.runCompose ?? runCompose;
  const readSecrets = dependencies.readSecrets ?? localRuntimeSecrets;
  const signIn = dependencies.signIn ?? signInLocalOperator;
  const readTarget = dependencies.readTarget ?? readLocalSupabaseTarget;
  const target = await readTarget(environment, ROOT_DIRECTORY);
  assertLocalProject(target, environment);
  const composeConfiguration = await compose(['config', '--format', 'json'], {
    environment: localBootstrapEnvironment(environment, target),
  });
  assertLocalComposeTarget(composeConfiguration, target, environment);
  const statusOutput = await execute(
    'pnpm',
    localSupabaseArguments(target, 'status', ['-o', 'env']),
    { environment },
  );
  const status = parseSupabaseStatusEnvironment(statusOutput);
  assertLocalSupabaseStatus(status, target);
  const databaseInspection = await execute(
    'docker',
    [
      'inspect',
      '--format',
      '{"name":{{json .Name}},"running":{{json .State.Running}},"ports":{{json .NetworkSettings.Ports}},"mounts":{{json .Mounts}}}',
      `supabase_db_${target.projectId}`,
    ],
    { environment },
  );
  assertLocalDatabaseContainer(databaseInspection, target);
  const localSecrets = await readSecrets(target.workdir);
  const accessToken = await signIn(status, {
    email: environment['WISER_LOCAL_OPERATOR_EMAIL'] ?? LOCAL_OPERATOR_EMAIL,
    password:
      environment['WISER_LOCAL_OPERATOR_PASSWORD'] ?? LOCAL_OPERATOR_PASSWORD,
  });
  const auth = buildSupabaseComposeEnvironment(status, {
    accessToken,
    delegatedCredentialHmacKeyRing:
      environment['WISER_DELEGATED_CREDENTIAL_HMAC_KEYS'] ??
      JSON.stringify(localSecrets.delegatedCredentialHmacKeys),
  });
  const tenantId =
    environment['DATA_TENANT_ID'] ?? 'b1000000-0000-4000-8000-000000000001';
  const projectId =
    environment['DATA_PROJECT_ID'] ?? 'b2000000-0000-4000-8000-000000000001';
  const runtimeEnvironment = {
    ...environment,
    ...auth,
    DATA_FOUNDATION_MODE: 'enabled',
    DATA_TENANT_ID: tenantId,
    DATA_PROJECT_ID: projectId,
    WISER_DATA_TENANT_ID: tenantId,
    WISER_DATA_PROJECT_ID: projectId,
    WISER_DATA_API_INTERNAL_URL: 'http://api:3001',
    WISER_DATA_PURPOSE: 'data-steward-console',
    EXCON_V2_MODE: 'postgres',
    EXCON_JOURNAL_DATABASE_URL: localJournalDatabaseUrl(
      status,
      localSecrets.exconJournalPassword,
    ),
    EXCON_LEASE_HMAC_KEYS:
      environment['EXCON_LEASE_HMAC_KEYS'] ??
      JSON.stringify(localSecrets.exconLeaseHmacKeys),
    EXCON_TENANT_ID: tenantId,
    EXCON_PROJECT_ID: projectId,
    EXCON_PURPOSE: 'excon-api',
  };
  const finalConfiguration = await compose(['config', '--format', 'json'], {
    environment: runtimeEnvironment,
  });
  assertLocalComposeTarget(finalConfiguration, target, environment);
  await provisionExconRuntime(
    localSecrets.exconJournalPassword,
    environment,
    target,
    execute,
  );
  await compose(['up', '-d', '--build', '--wait'], {
    capture: false,
    environment: runtimeEnvironment,
  });
  return { environment: runtimeEnvironment };
}

if (isDirectExecution(import.meta.url)) {
  await startDataFoundation();
}
