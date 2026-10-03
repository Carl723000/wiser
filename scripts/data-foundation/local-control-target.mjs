import { Buffer } from 'node:buffer';
import { readFile, stat } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

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
  const selected = environment['WISER_LOCAL_SUPABASE_WORKDIR'] || rootDirectory;
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
  const selected = environment['COMPOSE_PROJECT_NAME'] || 'wiser';
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
    database.pathname !== '/postgres'
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
  if (
    document?.name !== `/supabase_db_${target.projectId}` ||
    document?.running !== true ||
    !Array.isArray(bindings) ||
    bindings.length === 0 ||
    bindings.some(
      (binding) => binding?.HostPort !== String(target.databasePort),
    )
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
  for (const volume of Object.values(document.volumes ?? {})) {
    if (
      volume?.external === true ||
      typeof volume?.name !== 'string' ||
      !volume.name.startsWith(`${target.projectId}_`)
    )
      throw targetError('shared or mismatched volume');
  }
  return document;
}

export function assertLocalComposeTarget(output, target, environment) {
  const document = assertLocalComposeProject(output, target);
  for (const [service, key, fallback] of [
    ['api', 'DATA_API_ORIGIN', 'http://127.0.0.1:3101'],
    ['web', 'DATA_WEB_ORIGIN', 'http://127.0.0.1:3100'],
    ['mcp-http', 'DATA_MCP_ORIGIN', 'http://127.0.0.1:13004'],
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
      bindings.some((binding) => String(binding?.published) !== expected)
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
}
