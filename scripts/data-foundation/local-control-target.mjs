import { Buffer } from 'node:buffer';
import { readFile, stat } from 'node:fs/promises';
import { delimiter, join, posix, resolve } from 'node:path';

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
const MAX_CONFIG_BYTES = 64 * 1024;

function targetError(reason) {
  return new Error(`Local runtime target is invalid: ${reason}.`);
}

// Read only the three literal selectors used by local CLI bootstrap. This is not
// a TOML evaluator: unsupported or duplicate selectors fail before any mutation.
export function parseLocalSupabaseTarget(text, workdir) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_CONFIG_BYTES) {
    throw targetError('control configuration');
  }
  const fields = new Map();
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      section =
        /^\s*\[([a-z][a-z0-9_.]*)\]\s*(?:#.*)?$/.exec(line)?.[1] ?? 'other';
      continue;
    }
    const field = /^\s*([a-z][a-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (field === null) continue;
    const key = section === '' ? field[1] : `${section}.${field[1]}`;
    if (!['project_id', 'api.port', 'db.port'].includes(key)) continue;
    if (fields.has(key)) throw targetError('duplicate control selector');
    fields.set(key, field[2]);
  }
  const projectId = /^("|')([a-zA-Z0-9][a-zA-Z0-9_-]{0,62})\1\s*(?:#.*)?$/.exec(
    fields.get('project_id') ?? '',
  )?.[2];
  const port = (key) => {
    const raw = /^(\d{1,5})\s*(?:#.*)?$/.exec(fields.get(key) ?? '')?.[1];
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      throw targetError('control port');
    }
    return value;
  };
  if (projectId === undefined) throw targetError('control project');
  return Object.freeze({
    workdir,
    projectId,
    apiPort: port('api.port'),
    databasePort: port('db.port'),
  });
}

export async function readLocalSupabaseTarget(environment, rootDirectory) {
  const configured = environment['WISER_LOCAL_SUPABASE_WORKDIR'];
  const selected =
    configured === undefined || configured === '' ? rootDirectory : configured;
  if (
    typeof selected !== 'string' ||
    selected.trim().length === 0 ||
    selected.includes('\0')
  ) {
    throw targetError('control directory');
  }
  const workdir = resolve(rootDirectory, selected);
  const path = join(workdir, 'supabase/config.toml');
  try {
    if ((await stat(path)).size > MAX_CONFIG_BYTES)
      throw targetError('control configuration');
    return parseLocalSupabaseTarget(await readFile(path, 'utf8'), workdir);
  } catch {
    throw targetError('control configuration');
  }
}

export function assertLocalProject(target, environment) {
  const configured = environment['COMPOSE_PROJECT_NAME'];
  const selected =
    configured === undefined || configured === '' ? 'wiser' : configured;
  if (selected !== target.projectId)
    throw targetError('Compose and control project differ');
}

export function localSupabaseArguments(target, command, extra = []) {
  return ['exec', 'supabase', '--workdir', target.workdir, command, ...extra];
}

function localUrl(value, protocols, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw targetError(label);
  }
  if (
    !protocols.includes(url.protocol) ||
    !LOOPBACK_HOSTS.includes(url.hostname) ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw targetError(label);
  }
  return url;
}

export function assertLocalSupabaseStatus(status, target) {
  const api = localUrl(status?.apiUrl, ['http:', 'https:'], 'Auth address');
  const database = localUrl(
    status?.databaseUrl,
    ['postgres:', 'postgresql:'],
    'database address',
  );
  if (
    Number(api.port || (api.protocol === 'https:' ? 443 : 80)) !==
      target.apiPort ||
    Number(database.port || 5432) !== target.databasePort ||
    database.pathname !== '/postgres' ||
    database.username !== 'postgres'
  ) {
    throw targetError('Auth or database does not match control configuration');
  }
}

export function assertLocalDatabaseContainer(output, target) {
  let document;
  try {
    if (
      typeof output !== 'string' ||
      Buffer.byteLength(output) > MAX_CONFIG_BYTES
    )
      throw new Error();
    document = JSON.parse(output);
  } catch {
    throw targetError('database container inspection');
  }
  const bindings = document?.ports?.['5432/tcp'];
  const mounts = document?.mounts;
  const databaseMounts = Array.isArray(mounts)
    ? mounts.filter(
        (mount) =>
          mount?.Destination === '/var/lib/postgresql' ||
          mount?.Destination?.startsWith('/var/lib/postgresql/'),
      )
    : [];
  if (
    document?.name !== `/supabase_db_${target.projectId}` ||
    document?.running !== true ||
    !Array.isArray(bindings) ||
    bindings.length === 0 ||
    bindings.some(
      (binding) => binding?.HostPort !== String(target.databasePort),
    ) ||
    databaseMounts.length !== 1 ||
    databaseMounts[0]?.Type !== 'volume' ||
    databaseMounts[0]?.Name !== `supabase_db_${target.projectId}` ||
    databaseMounts[0]?.RW !== true
  ) {
    throw targetError(
      'database container does not match control configuration',
    );
  }
}

export function localJournalDatabaseUrl(status, password) {
  if (typeof password !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(password))
    throw targetError('journal password');
  const url = localUrl(
    status.databaseUrl,
    ['postgres:', 'postgresql:'],
    'database address',
  );
  url.username = 'wiser_excon_api';
  url.password = password;
  url.hostname = 'host.docker.internal';
  return url.toString();
}

export function localComposeArguments(target, environment, rootDirectory) {
  assertLocalProject(target, environment);
  const base = resolve(rootDirectory, 'compose.yaml');
  const override = resolve(rootDirectory, 'compose.override.yaml');
  const separator = environment['COMPOSE_PATH_SEPARATOR'] ?? delimiter;
  if (typeof separator !== 'string' || separator.length !== 1)
    throw targetError('Compose file separator');
  const files =
    environment['COMPOSE_FILE'] === undefined
      ? [base, override]
      : environment['COMPOSE_FILE']
          .split(separator)
          .map((path) => resolve(rootDirectory, path));
  if (!files.includes(base) || !files.includes(override))
    throw targetError('Compose file list must include the local override');
  return [
    'compose',
    ...(environment['COMPOSE_PROJECT_NAME']
      ? ['--project-name', target.projectId]
      : []),
    ...files.flatMap((path) => ['--file', path]),
    '--profile',
    'data-foundation',
  ];
}

export function assertLocalComposeProject(output, target) {
  let document;
  try {
    if (
      typeof output !== 'string' ||
      Buffer.byteLength(output) > 8 * 1024 * 1024
    )
      throw new Error();
    document = JSON.parse(output);
  } catch {
    throw targetError('Compose inspection');
  }
  if (document?.name !== target.projectId) throw targetError('Compose project');
  for (const network of Object.values(document.networks ?? {})) {
    if (
      network?.external === true ||
      (network?.driver !== undefined && network.driver !== 'bridge') ||
      typeof network?.name !== 'string' ||
      !network.name.startsWith(`${target.projectId}_`)
    )
      throw targetError('shared or mismatched network');
  }
  for (const volume of Object.values(document.volumes ?? {})) {
    if (
      volume?.external === true ||
      volume?.driver_opts !== undefined ||
      (volume?.driver !== undefined && volume.driver !== 'local') ||
      typeof volume?.name !== 'string' ||
      !volume.name.startsWith(`${target.projectId}_`)
    )
      throw targetError('shared or mismatched volume');
  }
  for (const [service, [source, destination]] of Object.entries(
    PERSISTENT_MOUNTS,
  )) {
    const entry = document.services?.[service];
    if (entry === undefined) continue;
    const mounts = entry.volumes;
    if (!Array.isArray(mounts)) throw targetError('missing persistent mount');
    const storage = mounts.filter(
      (mount) =>
        mount?.target === destination ||
        mount?.target?.startsWith(`${destination}/`),
    );
    if (
      storage.length !== 1 ||
      storage[0]?.target !== destination ||
      storage[0]?.type !== 'volume' ||
      storage[0]?.source !== source ||
      storage[0]?.read_only === true ||
      document.volumes?.[source] === undefined
    )
      throw targetError('mismatched persistent mount');
    if (
      mounts.some((mount) => mount?.type === 'bind' && mount.read_only !== true)
    )
      throw targetError('unregistered writable storage path');
  }
  for (const entry of Object.values(document.services ?? {})) {
    if (
      entry.network_mode !== undefined ||
      entry.container_name !== undefined ||
      (entry.external_links?.length ?? 0) > 0
    )
      throw targetError('service bypasses project isolation');
    const hosts = entry.extra_hosts ?? [];
    const localGatewayOnly = Array.isArray(hosts)
      ? hosts.every((host) =>
          /^host\.docker\.internal[:=]host-gateway$/.test(host),
        )
      : Object.entries(hosts).every(
          ([host, address]) =>
            host === 'host.docker.internal' && address === 'host-gateway',
        );
    if (!localGatewayOnly) throw targetError('service hostname redirect');
    for (const mount of entry?.volumes ?? []) {
      if (
        mount?.type === 'volume' &&
        document.volumes?.[mount.source] === undefined
      )
        throw targetError('undeclared persistent volume');
    }
  }
  const pgdata = document.services?.['data-postgres']?.environment?.PGDATA;
  if (pgdata !== undefined) {
    if (
      typeof pgdata !== 'string' ||
      !posix.isAbsolute(pgdata) ||
      pgdata.includes('\0') ||
      !posix.normalize(pgdata).startsWith('/var/lib/postgresql/')
    )
      throw targetError('database directory escapes verified storage');
  }
  return document;
}

const PERSISTENT_MOUNTS = Object.freeze({
  'data-postgres': ['data-postgres-data', '/var/lib/postgresql'],
  seaweedfs: ['seaweedfs-data', '/data'],
  weaviate: ['weaviate-data', '/var/lib/weaviate'],
  opensearch: ['opensearch-data', '/usr/share/opensearch/data'],
  'opensearch-dashboards': [
    'opensearch-dashboards-data',
    '/usr/share/opensearch-dashboards/data',
  ],
  neo4j: ['neo4j-data', '/data'],
  geoserver: ['geoserver-data', '/opt/geoserver_data'],
  clamav: ['clamav-data', '/var/lib/clamav'],
});

function serviceUrl(value, host, port, path, username, protocols) {
  let address;
  try {
    address = new URL(value);
  } catch {
    throw targetError('service connection');
  }
  if (
    !protocols.includes(address.protocol) ||
    address.hostname !== host ||
    Number(
      address.port ||
        (address.protocol === 'https:'
          ? 443
          : address.protocol.startsWith('postgres')
            ? 5432
            : 80),
    ) !== port ||
    address.pathname !== path ||
    address.username !== username ||
    address.search !== '' ||
    address.hash !== ''
  )
    throw targetError('service connection differs from local target');
}

// Placeholders are used only to compile configuration. They never start a
// container, authenticate, or replace the persisted runtime secrets.
export function localBootstrapEnvironment(environment, target) {
  return {
    ...environment,
    WISER_AUTH_MODE: 'supabase',
    SUPABASE_URL: `http://host.docker.internal:${target.apiPort}`,
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${target.apiPort}`,
    DATABASE_URL: `postgresql://postgres:configuration-only@host.docker.internal:${target.databasePort}/postgres`,
    EXCON_V2_MODE: 'postgres',
    EXCON_JOURNAL_DATABASE_URL: `postgresql://wiser_excon_api:configuration-only@host.docker.internal:${target.databasePort}/postgres`,
  };
}

export function assertLocalComposeTarget(output, target, environment) {
  const document = assertLocalComposeProject(output, target);
  for (const service of Object.keys(PERSISTENT_MOUNTS)) {
    if (document.services?.[service] === undefined)
      throw targetError('missing persistent service');
  }
  if (target.projectId !== 'wiser') {
    for (const entry of Object.values(document.services ?? {})) {
      for (const binding of entry?.ports ?? []) {
        if (
          !LOOPBACK_HOSTS.includes(binding?.host_ip) ||
          !/^[1-9]\d{0,4}$/.test(String(binding?.published)) ||
          Number(binding.published) > 65_535
        )
          throw targetError('isolated service must bind a loopback port');
      }
    }
  }
  for (const [service, key, fallback, internalPort] of [
    ['api', 'DATA_API_ORIGIN', 'http://127.0.0.1:3101', 3001],
    ['web', 'DATA_WEB_ORIGIN', 'http://127.0.0.1:3100', 3000],
    ['mcp-http', 'DATA_MCP_ORIGIN', 'http://127.0.0.1:13004', 3004],
  ]) {
    const address = localUrl(
      environment[key] ?? fallback,
      ['http:', 'https:'],
      'service origin',
    );
    if (
      address.pathname !== '/' ||
      address.username.length > 0 ||
      address.password.length > 0 ||
      address.search.length > 0
    )
      throw targetError('service origin');
    const bindings = document.services?.[service]?.ports;
    const expected = String(
      address.port || (address.protocol === 'https:' ? 443 : 80),
    );
    if (
      !Array.isArray(bindings) ||
      bindings.length === 0 ||
      bindings.some(
        (binding) =>
          String(binding?.published) !== expected ||
          Number(binding?.target) !== internalPort,
      )
    )
      throw targetError('service port differs from smoke origin');
  }
  const apiOrigin = new URL(
    environment['DATA_API_ORIGIN'] ?? 'http://127.0.0.1:3101',
  ).origin;
  for (const [service, key] of [
    ['api', 'DATA_PUBLIC_API_ORIGIN'],
    ['data-worker', 'DATA_STAC_ASSET_BASE_URL'],
  ]) {
    if (document.services?.[service]?.environment?.[key] !== apiOrigin)
      throw targetError('asset origin differs from API origin');
  }
  const httpProtocols = ['http:', 'https:'];
  const postgresProtocols = ['postgres:', 'postgresql:'];
  for (const service of ['api', 'web']) {
    if (
      document.services?.[service]?.environment?.WISER_AUTH_MODE !== 'supabase'
    )
      throw targetError('Auth mode differs from local target');
  }
  if (document.services.api.environment?.EXCON_V2_MODE !== 'postgres')
    throw targetError('journal mode differs from local target');
  for (const service of ['api', 'web', 'data-worker', 'mcp-http']) {
    const values = document.services?.[service]?.environment;
    // Auth is consumed by API and web. Other services do not require this
    // field, but an explicit override must still address the selected control.
    if (!['api', 'web'].includes(service) && values?.SUPABASE_URL === undefined)
      continue;
    serviceUrl(
      values?.SUPABASE_URL,
      'host.docker.internal',
      target.apiPort,
      '/',
      '',
      httpProtocols,
    );
  }
  const browserAuth = localUrl(
    document.services.web.environment?.NEXT_PUBLIC_SUPABASE_URL,
    httpProtocols,
    'browser Auth',
  );
  if (
    Number(browserAuth.port || 80) !== target.apiPort ||
    browserAuth.pathname !== '/' ||
    browserAuth.username !== '' ||
    browserAuth.password !== ''
  )
    throw targetError('browser Auth differs from local target');
  for (const service of ['api', 'worker'])
    serviceUrl(
      document.services?.[service]?.environment?.DATABASE_URL,
      'host.docker.internal',
      target.databasePort,
      '/postgres',
      'postgres',
      postgresProtocols,
    );
  serviceUrl(
    document.services.api.environment?.EXCON_JOURNAL_DATABASE_URL,
    'host.docker.internal',
    target.databasePort,
    '/postgres',
    'wiser_excon_api',
    postgresProtocols,
  );
  for (const [service, role] of [
    ['api', 'wiser_data_api'],
    ['data-worker', 'wiser_data_worker'],
  ]) {
    const values = document.services?.[service]?.environment;
    serviceUrl(
      values?.DATA_DATABASE_URL,
      'data-postgres',
      5432,
      '/wiser_data',
      role,
      postgresProtocols,
    );
    serviceUrl(
      values?.DATA_S3_ENDPOINT,
      'seaweedfs',
      8333,
      '/',
      '',
      httpProtocols,
    );
    // The worker writes through the internal endpoint; only the API must sign
    // a public file address. Validate optional worker overrides when present.
    if (
      service === 'data-worker' &&
      values?.DATA_S3_PUBLIC_ENDPOINT === undefined
    )
      continue;
    const fileAddress = localUrl(
      values?.DATA_S3_PUBLIC_ENDPOINT,
      httpProtocols,
      'file origin',
    );
    const filePort = String(
      fileAddress.port || (fileAddress.protocol === 'https:' ? 443 : 80),
    );
    if (
      fileAddress.pathname !== '/' ||
      fileAddress.username !== '' ||
      fileAddress.password !== '' ||
      !(document.services.seaweedfs.ports ?? []).some(
        (binding) =>
          String(binding.published) === filePort &&
          Number(binding.target) === 8333,
      )
    )
      throw targetError('public file origin differs from storage binding');
  }
}
