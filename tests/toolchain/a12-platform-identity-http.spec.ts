import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CandidateLoadTransportError } from '../../apps/web/e2e-live/support/a12-candidate-load-driver.ts';
import {
  createA12PlatformIdentityHttp,
  type A12PlatformIdentityHttp,
  type A12PlatformIdentityHttpOptions,
} from '../../apps/web/e2e-live/support/a12-platform-identity-http.ts';
import type { CandidateLoadMeInput } from '../../apps/web/e2e-live/support/a12-candidate-load-auth.ts';

// Owned wire fixture only. No real account, login, service, RLS or runtime admission.
const tenantId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const token = 'synthetic-identity-http-only';
const identity = {
  actorType: 'human',
  actorId: tenantId,
  tenantId,
  projectId,
  roles: ['member'],
  scopes: ['data.operation.read', 'data.ingestion.write'],
  purpose: 'web-console',
  maxSecurityLevel: 'L1_INTERNAL',
  authzVersion: 1,
};
const input = (): CandidateLoadMeInput => ({
  accessToken: token,
  tenantId,
  projectId,
  purpose: 'web-console',
});
let server: ReturnType<typeof createServer>;
let port = 0;
let hits = 0;
let handle: (request: IncomingMessage, response: ServerResponse) => void;
const adapters: A12PlatformIdentityHttp[] = [];
function json(response: ServerResponse, body: unknown = identity) {
  response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}
function options(): A12PlatformIdentityHttpOptions {
  return { apiOrigin: `http://127.0.0.1:${port}`, taskApiPort: port };
}
function adapter(change: Partial<A12PlatformIdentityHttpOptions> = {}) {
  const value = createA12PlatformIdentityHttp({ ...options(), ...change });
  adapters.push(value);
  return value;
}
async function rejected(read: Promise<unknown>, kind: string) {
  await expect(read).rejects.toBeInstanceOf(CandidateLoadTransportError);
  await expect(read).rejects.toMatchObject({ kind });
}
beforeEach(async () => {
  hits = 0;
  handle = (_request, response) => json(response);
  server = createServer((request, response) => {
    hits += 1;
    handle(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Owned synthetic listener unavailable');
  port = address.port;
});
afterEach(async () => {
  vi.useRealTimers();
  for (const value of adapters.splice(0)) value.close();
  server.closeAllConnections();
  if (server.listening)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

it('consumes the exact current identity GET with the selected scope and no request body', async () => {
  let seen: IncomingMessage | undefined;
  let body = '';
  handle = (request, response) => {
    seen = request;
    request.on('data', (chunk) => {
      body += String(chunk);
    });
    request.on('end', () => json(response));
  };
  const value = adapter();
  expect(await value.readMe(input())).toEqual({ status: 200, body: identity });
  expect(seen?.method).toBe('GET');
  expect(seen?.url).toBe('/api/platform/v1/me');
  expect(seen?.headers.authorization).toBe(`Bearer ${token}`);
  expect(seen?.headers['x-wiser-tenant-id']).toBe(tenantId);
  expect(seen?.headers['x-wiser-project-id']).toBe(projectId);
  expect(seen?.headers['x-wiser-purpose']).toBe('web-console');
  expect(body).toBe('');
  expect(hits).toBe(1);
  expect(value.diagnostics()).toEqual({ activeRequests: 0, closed: false });
});
it.each([401, 403, 429, 500, 302])(
  'preserves status %i without error bodies, redirect or retry',
  async (status) => {
    handle = (_request, response) => {
      response.writeHead(status, {
        Location: `http://127.0.0.1:${port}/must-not-follow`,
      });
      response.end('PRIVATE_UPSTREAM_ERROR');
    };
    expect(await adapter().readMe(input())).toEqual({ status, body: null });
    await nextTurn();
    expect(hits).toBe(1);
  },
);
it.each([
  { apiOrigin: 'https://127.0.0.1:3001', taskApiPort: 3001 },
  { apiOrigin: 'http://localhost:3001', taskApiPort: 3001 },
  { apiOrigin: 'http://127.0.0.1:3001/path', taskApiPort: 3001 },
  { apiOrigin: 'http://127.0.0.1:3001?x=1', taskApiPort: 3001 },
  { apiOrigin: 'http://user:password@127.0.0.1:3001', taskApiPort: 3001 },
  { taskApiPort: 0 },
])('refuses a nonexact owned API origin before dispatch (%j)', (change) => {
  expect(() => adapter(change)).toThrow(CandidateLoadTransportError);
  expect(hits).toBe(0);
});
it('rejects mutated selector accessors without evaluating them', () => {
  let reads = 0;
  const raw = Object.defineProperty(options(), 'apiOrigin', {
    get: () => {
      reads += 1;
      return `http://127.0.0.1:${port}`;
    },
  });
  expect(() => createA12PlatformIdentityHttp(raw)).toThrow(
    CandidateLoadTransportError,
  );
  expect(reads).toBe(0);
  expect(hits).toBe(0);
});
it.each([
  ['newline', { accessToken: 'bad\nheader' }],
  ['empty', { accessToken: '' }],
  ['oversized', { accessToken: 'x'.repeat(16385) }],
  ['tenant', { tenantId: 'invalid' }],
  ['project', { projectId: 'invalid' }],
  ['purpose', { purpose: 'invalid\npurpose' }],
] as const)(
  'refuses invalid credential/scope inputs without dispatch (%s)',
  async (_label, change) => {
    await rejected(adapter().readMe({ ...input(), ...change }), 'invalid');
    expect(hits).toBe(0);
  },
);
it('snapshots input descriptors without evaluating scope getters', async () => {
  let reads = 0;
  const raw = Object.defineProperty(input(), 'projectId', {
    get: () => {
      reads += 1;
      return projectId;
    },
  });
  await rejected(adapter().readMe(raw), 'invalid');
  expect(reads).toBe(0);
  expect(hits).toBe(0);
});
it('preserves selected origin and request scope after caller mutations', async () => {
  const selected = options();
  const value = createA12PlatformIdentityHttp(selected);
  adapters.push(value);
  let seenProject: string | string[] | undefined;
  handle = (request, response) => {
    seenProject = request.headers['x-wiser-project-id'];
    json(response);
  };
  const raw = input();
  const pending = value.readMe(raw);
  Object.assign(selected, {
    apiOrigin: 'http://outside.invalid',
    taskApiPort: 80,
  });
  Object.assign(raw, { projectId: tenantId, accessToken: 'CHANGED' });
  expect((await pending).body).toEqual(identity);
  expect(seenProject).toBe(projectId);
  expect(hits).toBe(1);
});
it.each([
  'content-type',
  'encoding',
  'length',
  'stream',
  'utf8',
  'json',
  'incomplete',
])(
  'refuses invalid successful response %s and cleans its request',
  async (mode) => {
    handle = (_request, response) => {
      if (mode === 'incomplete') {
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': 40,
        });
        response.write('{');
        setImmediate(() => response.destroy());
        return;
      }
      if (mode === 'utf8') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(Buffer.from([0xff]));
        return;
      }
      if (mode === 'json') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{');
        return;
      }
      if (mode === 'stream') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('x'.repeat(32769));
        return;
      }
      response.writeHead(200, {
        'Content-Type':
          mode === 'content-type' ? 'text/html' : 'application/json',
        ...(mode === 'encoding' ? { 'Content-Encoding': 'gzip' } : {}),
        ...(mode === 'length' ? { 'Content-Length': 32769 } : {}),
      });
      response.end('{}');
    };
    const value = adapter();
    await rejected(
      value.readMe(input()),
      mode === 'incomplete' ? 'unavailable' : 'invalid',
    );
    expect(hits).toBe(1);
    expect(value.diagnostics().activeRequests).toBe(0);
  },
);
it('accepts a complete response at the exact 32KiB bound', async () => {
  const raw = '"' + 'x'.repeat(32766) + '"';
  handle = (_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': 32768,
    });
    response.end(raw);
  };
  expect(await adapter().readMe(input())).toEqual({
    status: 200,
    body: 'x'.repeat(32766),
  });
});
it('cancels a pending read, removes its listener, and rejects later reads', async () => {
  const controller = new AbortController();
  let arrive: () => void = () => {};
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  handle = () => arrive();
  const value = adapter({ signal: controller.signal });
  const pending = value.readMe(input());
  const failure = rejected(pending, 'cancelled');
  await Promise.race([arrived, failure]);
  controller.abort();
  await failure;
  expect(value.diagnostics().activeRequests).toBe(0);
  await rejected(value.readMe(input()), 'cancelled');
  expect(hits).toBe(1);
});
it('closes only owned concurrent requests and is idempotent', async () => {
  let arrive: () => void = () => {};
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  handle = () => {
    if (hits === 2) arrive();
  };
  const value = adapter();
  const reads = [value.readMe(input()), value.readMe(input())];
  const failure = Promise.all(reads.map((read) => rejected(read, 'cancelled')));
  await Promise.race([arrived, failure]);
  value.close();
  value.close();
  await failure;
  expect(value.diagnostics()).toEqual({ activeRequests: 0, closed: true });
  await rejected(value.readMe(input()), 'cancelled');
  expect(hits).toBe(2);
});
it('bounds the entire pending response to the existing 30-second deadline', async () => {
  let arrive: () => void = () => {};
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  handle = () => arrive();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const value = adapter();
  const failure = rejected(value.readMe(input()), 'unavailable');
  await Promise.race([arrived, failure]);
  await vi.advanceTimersByTimeAsync(30000);
  await failure;
  expect(value.diagnostics().activeRequests).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(hits).toBe(1);
});
