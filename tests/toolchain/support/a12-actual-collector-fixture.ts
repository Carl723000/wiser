import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import { afterEach } from 'vitest';
import {
  CompleteUploadSessionOutputSchema,
  CreateIngestionInputSchema,
  CreateIngestionOutputSchema,
  CreateUploadSessionOutputSchema,
  GetIngestionOutputSchema,
  IngestionCandidateAssetPageSchema,
  IngestionCandidateGeometryPageSchema,
  IngestionCandidateRecordPageSchema,
  OperationEventPageSchema,
  OperationOutputSchema,
  OperationSchema,
} from '../../../packages/data-contracts/src/index.ts';
import type { ActualCollectorConfiguration } from '../../../apps/web/e2e-live/support/a12-actual-collector-host.ts';

// Only private ephemeral HTTP fixtures. No real credentials, SQL, daemon or services.
// The host imports installed createClient itself; the fixture never supplies an SDK callback.
export type FixtureMode =
  | 'ok'
  | 'bad-signature'
  | 'token-denied'
  | 'token-stalled'
  | 'jwks-stalled'
  | 'token-body-stalled'
  | 'jwks-body-stalled'
  | 'token-denied-body-stalled'
  | 'token-invalid-json'
  | 'jwks-invalid-json'
  | 'me-stalled'
  | 'me-denied'
  | 'me-changed'
  | 'me-unavailable'
  | 'submit-denied'
  | 'original-drift';
export const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const sha = (value: Uint8Array | string) =>
  createHash('sha256').update(value).digest('hex');
export const scope = {
  tenantId: uuid(1),
  projectId: uuid(2),
  purpose: 'research',
};
export const assetIds = [uuid(4), uuid(3)]; // Prepared ordinals deliberately differ from UUID sorting.
export const ingestionId = uuid(5),
  operationId = uuid(6),
  uploadSessionId = uuid(7);
export const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId,
  processingBatchId: uuid(8),
  reviewHash: 'a'.repeat(64),
};
export const idempotencyKeys = {
  createUpload: uuid(10),
  completeUpload: uuid(11),
  createIngestion: uuid(12),
  submitIngestion: uuid(13),
};
const actorId = uuid(20),
  sessionId = uuid(21);
const at = '2026-10-06T00:00:00Z';
const credential = {
  email: 'synthetic-fixture@example.test',
  password: 'SYNTHETIC_ONLY_NOT_A_REAL_PASSWORD',
};
const publishableKey = 'sb_publishable_SYNTHETIC_FIXTURE_ONLY';
const storageSignature = 'SYNTHETIC_STORAGE_SIGNATURE_ONLY';
const cleanup = new Set<() => Promise<void>>();
afterEach(async () => {
  for (const close of [...cleanup]) await close();
});
export interface FixtureHit {
  readonly service: 'auth' | 'api' | 'storage';
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: IncomingMessage['headers'];
  readonly body: Buffer;
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(value));
}
async function bytes(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (!(chunk instanceof Uint8Array)) throw new Error('Synthetic body type');
    chunks.push(Buffer.from(chunk));
    if (chunks.reduce((sum, item) => sum + item.length, 0) > 65_536)
      throw new Error('Synthetic body bound');
  }
  return Buffer.concat(chunks);
}
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  assert.equal(address.address, '127.0.0.1');
  return address.port;
}
export async function startSyntheticLoopbackFixture(mode: FixtureMode = 'ok') {
  const hits: FixtureHit[] = [],
    fixtureErrors: string[] = [];
  const servers: Server[] = [],
    sockets = new Set<Socket>();
  const originalBytes = [
    Buffer.from([0xff, 0x00, 0x61, 0x80, 0x62]),
    Buffer.from([0xfe, 0x10, 0x63, 0x81, 0x64, 0x00]),
  ];
  const tokenReceived = Promise.withResolvers<void>();
  const jwksReceived = Promise.withResolvers<void>();
  const identityReceived = Promise.withResolvers<void>();
  const authBodyClosed = Promise.withResolvers<void>();
  let heldAuthBody: ServerResponse | null = null;
  const holdAuthBody = (response: ServerResponse, status: number) => {
    heldAuthBody = response;
    response.once('close', () => authBodyClosed.resolve());
    response.writeHead(status, { 'content-type': 'application/json' });
    response.flushHeaders();
    response.write('{"');
  };
  let meReads = 0,
    ingestionReads = 0;
  let storagePort = 0,
    authPort = 0;
  let createdInput: ReturnType<typeof CreateIngestionInputSchema.parse> | null =
    null;
  const kid = randomUUID();
  const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...keyPair.publicKey.export({ format: 'jwk' }),
    kid,
    alg: 'RS256',
    use: 'sig',
  };
  const now = Math.floor(Date.now() / 1000),
    expires = now + 3600;
  const jwtHeader = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }),
  ).toString('base64url');
  const jwtPayload = Buffer.from(
    JSON.stringify({
      sub: actorId,
      session_id: sessionId,
      role: 'authenticated',
      aud: 'authenticated',
      iat: now,
      exp: expires,
    }),
  ).toString('base64url');
  const signatureBytes = sign(
    'RSA-SHA256',
    Buffer.from(`${jwtHeader}.${jwtPayload}`),
    keyPair.privateKey,
  );
  if (mode === 'bad-signature') signatureBytes[0] = signatureBytes[0]! ^ 1;
  const token = `${jwtHeader}.${jwtPayload}.${signatureBytes.toString('base64url')}`;
  const user = {
    id: actorId,
    aud: 'authenticated',
    role: 'authenticated',
    email: credential.email,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: at,
  };
  const operation = (status = 'WAITING_REVIEW', version = 3) =>
    OperationSchema.parse({
      operationId,
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      capabilityId: 'data.ingestion.create',
      status,
      resource: `operation://${operationId}`,
      progressPercent: 0,
      version,
      createdAt: at,
      updatedAt: at,
    });
  const session = (completed = false) => ({
    uploadSessionId,
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    status: completed ? 'COMPLETED' : 'OPEN',
    assetIds,
    version: completed ? 2 : 1,
    createdAt: at,
    expiresAt: '2030-01-01T00:00:00Z',
    ...(completed ? { completedAt: at } : {}),
  });
  const candidateBase = `/api/data/v1/ingestions/${ingestionId}/candidates/${reference.processingBatchId}`;
  const contentBase = `/api/data/v1/tenants/${scope.tenantId}/projects/${scope.projectId}/ingestions/${ingestionId}/candidates/${reference.processingBatchId}/assets`;
  const columns = [{ key: 'value', label: '合成原值' }];
  const records = [
    {
      recordId: uuid(31),
      assetId: assetIds[0]!,
      index: 1,
      sourceId: null,
      values: { value: 'SYNTHETIC_ROW_ONLY' },
      hasGeometry: true,
    },
  ];
  const features = [
    {
      recordId: records[0]!.recordId,
      assetId: assetIds[0]!,
      index: 1,
      sourceId: null,
      sourceCrs: null,
      geometry: { type: 'Point', coordinates: [116, 40] },
    },
  ];
  const assets = assetIds.map((assetId, ordinal) => ({
    assetId,
    sourceHash: sha(originalBytes[ordinal]!),
    status: ordinal === 0 ? 'READY' : 'EMPTY',
    reason: null,
    recordCount: ordinal === 0 ? 1 : 0,
    featureCount: ordinal === 0 ? 1 : 0,
  }));
  const getIngestion = (pending: boolean) =>
    GetIngestionOutputSchema.parse({
      ingestion: {
        ingestionId,
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        assetIds,
        intendedUses: createdInput?.intendedUses ?? ['analysis'],
        requestedSecurityLevel: 'L1_INTERNAL',
        state: pending ? 'RECEIVED' : 'REVIEW_REQUIRED',
        operationId,
        version: pending ? 2 : 3,
        createdAt: at,
        updatedAt: at,
        ...(createdInput?.sourceRegistration === undefined
          ? {}
          : { sourceRegistration: createdInput.sourceRegistration }),
      },
      candidateReference: pending ? null : reference,
    });
  const capture = async (
    service: FixtureHit['service'],
    request: IncomingMessage,
  ): Promise<FixtureHit> => {
    assert.equal(request.socket.remoteAddress, '127.0.0.1');
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const hit: FixtureHit = {
      service,
      method: request.method ?? '',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { ...request.headers },
      body: await bytes(request),
    };
    hits.push(hit);
    return hit;
  };
  const ownedServer = (
    handler: (
      request: IncomingMessage,
      response: ServerResponse,
    ) => Promise<void>,
  ) => {
    const server = createServer((request, response) => {
      void handler(request, response).catch(() => {
        fixtureErrors.push('Synthetic fixture handler failed');
        if (!response.headersSent)
          json(response, 500, { code: 'FIXTURE_ERROR' });
        else response.destroy();
      });
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    servers.push(server);
    return server;
  };
  const close = async () => {
    cleanup.delete(close);
    for (const socket of sockets) socket.destroy();
    for (const server of [...servers].reverse()) {
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    }
  };
  cleanup.add(close);
  try {
    const authServer = ownedServer(async (request, response) => {
      const hit = await capture('auth', request);
      if (hit.path === '/auth/v1/token') {
        assert.equal(hit.method, 'POST');
        assert.deepEqual(hit.query, { grant_type: 'password' });
        const body: unknown = JSON.parse(hit.body.toString('utf8'));
        assert(body && typeof body === 'object');
        assert.equal((body as Record<string, unknown>).email, credential.email);
        assert.equal(
          (body as Record<string, unknown>).password,
          credential.password,
        );
        tokenReceived.resolve();
        if (mode === 'token-stalled') return;
        if (mode === 'token-body-stalled') return holdAuthBody(response, 200);
        if (mode === 'token-denied-body-stalled')
          return holdAuthBody(response, 400);
        if (mode === 'token-invalid-json') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{');
          return;
        }
        if (mode === 'token-denied')
          return json(response, 400, {
            code: 'invalid_credentials',
            msg: 'Synthetic denied',
          });
        return json(response, 200, {
          access_token: token,
          token_type: 'bearer',
          refresh_token: 'SYNTHETIC_REFRESH_ONLY',
          expires_in: 3600,
          expires_at: expires,
          user,
        });
      }
      if (hit.path === '/auth/v1/.well-known/jwks.json') {
        assert.equal(hit.method, 'GET');
        assert.deepEqual(hit.query, {});
        jwksReceived.resolve();
        if (mode === 'jwks-stalled') return;
        if (mode === 'jwks-body-stalled') return holdAuthBody(response, 200);
        if (mode === 'jwks-invalid-json') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{');
          return;
        }
        return json(response, 200, { keys: [jwk] });
      }
      // A fallback /user, refresh grant, cookie route or arbitrary endpoint is a real fixture failure.
      throw new Error('Unexpected synthetic Auth endpoint');
    });
    authPort = await listen(authServer);
    const storageServer = ownedServer(async (request, response) => {
      const hit = await capture('storage', request);
      const ordinal = ['/synthetic-object-0', '/synthetic-object-1'].indexOf(
        hit.path,
      );
      assert(ordinal >= 0);
      assert.equal(hit.method, 'PUT');
      assert.deepEqual(hit.query, { 'X-Amz-Signature': storageSignature });
      assert.deepEqual(hit.body, originalBytes[ordinal]);
      assert.equal(hit.headers.authorization, undefined);
      response.writeHead(200, { ETag: '"synthetic-etag"' });
      response.end();
    });
    storagePort = await listen(storageServer);
    const apiServer = ownedServer(async (request, response) => {
      const hit = await capture('api', request);
      assert.equal(hit.headers.authorization, `Bearer ${token}`);
      assert.equal(hit.headers['x-wiser-tenant-id'], scope.tenantId);
      assert.equal(hit.headers['x-wiser-project-id'], scope.projectId);
      assert.equal(hit.headers['x-wiser-purpose'], scope.purpose);
      if (hit.path === '/api/platform/v1/me') {
        assert.equal(hit.method, 'GET');
        assert.deepEqual(hit.query, {});
        meReads++;
        identityReceived.resolve();
        if (mode === 'me-stalled') return;
        if (mode === 'me-denied')
          return json(response, 403, { code: 'FORBIDDEN' });
        if (mode === 'me-unavailable')
          return json(response, 503, { code: 'UNAVAILABLE' });
        return json(response, 200, {
          actorType: 'human',
          actorId,
          ...scope,
          roles: ['data-maintainer'],
          scopes: ['data.operation.read', 'data.ingestion.write'],
          maxSecurityLevel: 'L3_CONFIDENTIAL',
          authzVersion: mode === 'me-changed' && meReads > 1 ? 2 : 1,
        });
      }
      if (
        hit.path === '/api/data/v1/upload-sessions' &&
        hit.method === 'POST'
      ) {
        assert.equal(
          hit.headers['idempotency-key'],
          idempotencyKeys.createUpload,
        );
        return json(
          response,
          201,
          CreateUploadSessionOutputSchema.parse({
            uploadSession: session(),
            uploadTargets: assetIds.map((assetId, ordinal) => ({
              assetId,
              method: 'PRESIGNED_PUT',
              uploadUrl: `http://127.0.0.1:${storagePort}/synthetic-object-${ordinal}?X-Amz-Signature=${storageSignature}`,
              headers: {
                'content-length': String(originalBytes[ordinal]!.length),
                'content-type': 'application/octet-stream',
                'x-amz-meta-sha256': sha(originalBytes[ordinal]!),
              },
            })),
          }),
        );
      }
      if (
        hit.path ===
          `/api/data/v1/upload-sessions/${uploadSessionId}/complete` &&
        hit.method === 'POST'
      ) {
        assert.equal(
          hit.headers['idempotency-key'],
          idempotencyKeys.completeUpload,
        );
        assert.equal(hit.headers['if-match'], '"v1"');
        return json(
          response,
          200,
          CompleteUploadSessionOutputSchema.parse({
            uploadSession: session(true),
          }),
        );
      }
      if (hit.path === '/api/data/v1/ingestions' && hit.method === 'POST') {
        assert.equal(
          hit.headers['idempotency-key'],
          idempotencyKeys.createIngestion,
        );
        createdInput = CreateIngestionInputSchema.parse(
          JSON.parse(hit.body.toString('utf8')),
        );
        assert.deepEqual(createdInput.assetIds, assetIds);
        return json(
          response,
          202,
          CreateIngestionOutputSchema.parse({
            ingestionId,
            operation: operation('WAITING_INPUT', 1),
          }),
        );
      }
      if (
        hit.path === `/api/data/v1/ingestions/${ingestionId}/submit` &&
        hit.method === 'POST'
      ) {
        assert.equal(
          hit.headers['idempotency-key'],
          idempotencyKeys.submitIngestion,
        );
        assert.equal(hit.headers['if-match'], '"v2"');
        if (mode === 'submit-denied')
          return json(response, 403, { code: 'FORBIDDEN' });
        return json(
          response,
          202,
          OperationOutputSchema.parse({ operation: operation('RUNNING', 2) }),
        );
      }
      if (
        hit.path === `/api/data/v1/ingestions/${ingestionId}` &&
        hit.method === 'GET'
      )
        return json(response, 200, getIngestion(++ingestionReads === 1));
      if (
        hit.path === `/api/data/v1/operations/${operationId}` &&
        hit.method === 'GET'
      )
        return json(response, 200, operation());
      if (
        hit.path === `/api/data/v1/operations/${operationId}/events` &&
        hit.method === 'GET'
      ) {
        assert.deepEqual(hit.query, { first: '200' });
        const event = OperationEventPageSchema.parse({
          items: [
            {
              eventId: uuid(30),
              operationId,
              sequence: 1,
              eventType: 'WAITING_REVIEW',
              status: 'WAITING_REVIEW',
              progressPercent: 0,
              operationVersion: 3,
              occurredAt: at,
            },
          ],
        }).items[0]!;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          `id: ${event.eventId}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`,
        );
        return;
      }
      if (hit.path === candidateBase && hit.method === 'GET') {
        assert.deepEqual(hit.query, {
          kind: reference.kind,
          reviewHash: reference.reviewHash,
          first: hit.query.first,
        });
        assert(['50', '200'].includes(hit.query.first ?? ''));
        return json(
          response,
          200,
          IngestionCandidateAssetPageSchema.parse({
            reference,
            parserVersion: 'synthetic-real-sdk-host',
            status: 'READY',
            createdAt: at,
            totalAssetCount: 2,
            knownRecordCount: 1,
            knownFeatureCount: 1,
            unknownAssetCount: 0,
            assets,
            nextCursor: null,
          }),
        );
      }
      for (const [ordinal, assetId] of assetIds.entries()) {
        if (
          hit.path === `${contentBase}/${assetId}/content` &&
          hit.method === 'GET'
        ) {
          assert.deepEqual(hit.query, { reviewHash: reference.reviewHash });
          const content = Buffer.from(originalBytes[ordinal]!);
          if (mode === 'original-drift' && ordinal === 0)
            content[0] = content[0]! ^ 1;
          response.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': String(content.length),
          });
          response.write(content.subarray(0, 2));
          setImmediate(() => response.end(content.subarray(2)));
          return;
        }
        for (const action of ['records', 'geometry'] as const) {
          if (
            hit.path !== `${candidateBase}/${assetId}/${action}` ||
            hit.method !== 'GET'
          )
            continue;
          assert.deepEqual(hit.query, {
            kind: reference.kind,
            reviewHash: reference.reviewHash,
            first: hit.query.first,
          });
          assert(['50', '200'].includes(hit.query.first ?? ''));
          return json(
            response,
            200,
            action === 'records'
              ? IngestionCandidateRecordPageSchema.parse({
                  reference,
                  assetId,
                  columns: ordinal === 0 ? columns : [],
                  records: ordinal === 0 ? records : [],
                  nextCursor: null,
                })
              : IngestionCandidateGeometryPageSchema.parse({
                  reference,
                  assetId,
                  crs: 'EPSG:4326',
                  features: ordinal === 0 ? features : [],
                  nextCursor: null,
                }),
          );
        }
      }
      throw new Error('Unexpected synthetic API endpoint');
    });
    const apiPort = await listen(apiServer);
    const configuration = (): ActualCollectorConfiguration => ({
      apiOrigin: `http://127.0.0.1:${apiPort}`,
      taskApiPort: apiPort,
      storageOrigin: `http://127.0.0.1:${storagePort}`,
      taskStoragePort: storagePort,
      authOrigin: `http://127.0.0.1:${authPort}`,
      taskAuthPort: authPort,
      publishableKey,
      credentials: { ...credential },
      dataset: 'SYNTHETIC-S10',
      scope: { ...scope },
      prepared: originalBytes.map((original, ordinal) => {
        const content = Buffer.from(original); // configuration owns a separate copy of fixture source bytes
        return {
          object: {
            fileName: `a12-synthetic-${ordinal}.bin`,
            mediaType: 'application/octet-stream',
            sizeBytes: content.length,
            sha256: sha(content),
          },
          bytes: content,
          sha256: sha(content),
          sizeBytes: content.length,
        };
      }),
      idempotencyKeys: { ...idempotencyKeys },
      ingestion: {
        intendedUses: ['analysis'],
        requestedSecurityLevel: 'L1_INTERNAL',
        sourceRegistration: {
          sourceId: 'synthetic-only',
          kind: 'FILE_COLLECTION',
          name: 'Synthetic source only',
          bundleId: 'synthetic-only',
          providerName: 'Synthetic fixture',
          accessStatus: 'SYNTHETIC',
          completeness: 'EMPTY',
          limitations: ['Synthetic wiring fixture; no real acceptance'],
          manifestPreparedOrdinal: 1,
        },
      },
      maximumStatusReads: 3,
      maximumEventPages: 3,
      preparedMemoryBudgetBytes:
        3 * originalBytes.reduce((sum, content) => sum + content.length, 0) +
        Math.max(...originalBytes.map((content) => content.length)),
    });
    return {
      configuration,
      hits,
      fixtureErrors,
      close,
      tokenReceived: tokenReceived.promise,
      jwksReceived: jwksReceived.promise,
      identityReceived: identityReceived.promise,
      authBodyClosed: authBodyClosed.promise,
      dropHeldAuthBody: () => {
        assert(heldAuthBody, 'A real Auth response body must be pending');
        heldAuthBody.destroy();
        heldAuthBody = null;
      },
      token,
      credentialSentinel: credential.password,
      storageSignature,
      originalBytes,
      columns,
      records,
      features,
      candidateBase,
      contentBase,
      createdInput: () => createdInput,
      socketCount: () => sockets.size,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
