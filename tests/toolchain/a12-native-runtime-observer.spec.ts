import { test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { dirname, join } from 'node:path';
import { createA12NativeRuntimeObserver } from '../../apps/web/e2e-live/support/a12-native-runtime-observer.ts';
import type {
  A12NativeFileIdentity,
  A12NativeFilePin,
  A12NativeRootPin,
  A12NativeRuntimePolicy,
  A12NativeRuntimeSelectors,
  A12NativeService,
} from '../../apps/web/e2e-live/support/a12-native-runtime-observer.ts';
import { createA12RuntimeObservationWindows } from '../../apps/web/e2e-live/support/a12-normal-runtime-window.ts';
import type { RuntimeObservationBinding } from '../../apps/web/e2e-live/support/a12-normal-runtime-window.ts';

// Real temporary fs + a task-owned AF_UNIX inode + an explicit synthetic CLI.
// No TCP, socket connection, Docker daemon, Auth, SQL, scan, launch or authority.
// The AF_UNIX listener only creates a socket inode. The CLI never connects to it.
const fixturePrefix = '/private/tmp/g101-af-';
const digest = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const jsonDigest = (value: unknown) => digest(JSON.stringify(value));
const fakeId = (n: number) => n.toString(16).padStart(64, '0');
const signaturePath = '/var/lib/clamav/main.cvd';
const ownerLabelKey = 'com.docker.compose.project' as const;
const syntheticOwner = 'g101-synthetic-cli-not-docker';
const testTimeoutMs = 20_000;

type SyntheticPortMap = Record<
  string,
  { HostIp: string; HostPort: string }[]
> | null;
interface SyntheticInspection {
  id: string;
  image: string;
  startedAt: string;
  restarts: number;
  running: boolean;
  owner: string;
  mounts: {
    Type: 'volume';
    Name: string;
    Source: string;
    Destination: string;
    RW: boolean;
  }[];
  hostPorts: SyntheticPortMap;
  networkPorts: SyntheticPortMap;
}
interface SyntheticState {
  marker: 'synthetic-cli-not-docker';
  inspections: Record<string, SyntheticInspection>;
  ready: boolean;
  inspectDelayMs?: number;
  inspectDelayForId?: string;
}
interface SyntheticCall {
  marker: 'synthetic-cli-not-docker';
  kind: 'inspect' | 'signature-hash' | 'readiness';
  argv: string[];
  pid: number;
}
interface SyntheticFixture {
  base: string;
  workspace: string;
  runtime: string;
  sourcePath: string;
  signatureBytesPath: string;
  socketPath: string;
  state: SyntheticState;
  selectors: A12NativeRuntimeSelectors;
  policy: A12NativeRuntimePolicy;
  expected: RuntimeObservationBinding;
  persistState(): Promise<void>;
  calls(): Promise<SyntheticCall[]>;
}

function identity(metadata: Stats): A12NativeFileIdentity {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  };
}
async function filePin(path: string): Promise<A12NativeFilePin> {
  const bytes = await readFile(path);
  const metadata = await lstat(path);
  expect(metadata.isFile()).toBe(true);
  return {
    path,
    realPath: await realpath(path),
    sha256: digest(bytes),
    identity: identity(metadata),
  };
}
async function rootPin(path: string): Promise<A12NativeRootPin> {
  const metadata = await lstat(path);
  expect(metadata.isDirectory()).toBe(true);
  return {
    path,
    realPath: await realpath(path),
    dev: metadata.dev,
    ino: metadata.ino,
  };
}
function canonicalPorts(value: SyntheticPortMap) {
  return Object.entries(value ?? {})
    .flatMap(([port, bindings]) =>
      bindings.map((binding) => [port, binding.HostIp, binding.HostPort]),
    )
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function expectedInspectTemplate() {
  return (
    '{"id":{{json .Id}},"image":{{json .Image}},"startedAt":{{json .State.StartedAt}},' +
    '"restarts":{{json .RestartCount}},"running":{{json .State.Running}},' +
    '"owner":{{json (index .Config.Labels "' +
    ownerLabelKey +
    '")}},' +
    '"mounts":[{{range $i,$m := .Mounts}}{{if $i}},{{end}}' +
    '{"Type":{{json $m.Type}},"Name":{{json $m.Name}},"Source":{{json $m.Source}},' +
    '"Destination":{{json $m.Destination}},"RW":{{json $m.RW}}}{{end}}],' +
    '"hostPorts":{{json .HostConfig.PortBindings}},"networkPorts":{{json .NetworkSettings.Ports}}}'
  );
}
function syntheticCliSource(
  nodeExecutable: string,
  fixed: {
    configPath: string;
    daemonSocket: string;
    statePath: string;
    callPath: string;
    signatureBytesPath: string;
    signatureContainerId: string;
    signaturePath: string;
    inspectTemplate: string;
  },
) {
  // Literal script: no inherited configuration, dynamic module loading or shell.
  // All fs paths below belong to this one fixture. There is no net import/connect.
  return (
    '#!' +
    nodeExecutable +
    '\n' +
    String.raw`
// SYNTHETIC CLI FIXTURE ONLY: not Docker, clamd, a scanner or launch evidence.
import { appendFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const fixed = ${JSON.stringify(fixed)};
const args = process.argv.slice(2);
function refuse() { process.stderr.write('synthetic fixture argv refused\n'); process.exitCode = 2; }
async function record(kind) {
  await appendFile(fixed.callPath, JSON.stringify({ marker: 'synthetic-cli-not-docker', kind, argv: args, pid: process.pid }) + '\n');
}
async function main() {
  const state = JSON.parse(await readFile(fixed.statePath, 'utf8'));
  if (state.marker !== 'synthetic-cli-not-docker' || args[0] !== '--config' || args[1] !== fixed.configPath ||
      args[2] !== '--host' || args[3] !== fixed.daemonSocket) return refuse();
  const tail = args.slice(4);
  if (tail.length === 6 && tail[0] === 'inspect' && tail[1] === '--type' && tail[2] === 'container' &&
      tail[3] === '--format' && tail[4] === fixed.inspectTemplate && Object.hasOwn(state.inspections, tail[5])) {
    await record('inspect');
    if (tail[5] === state.inspectDelayForId) {
      if (!Number.isSafeInteger(state.inspectDelayMs) || state.inspectDelayMs < 1 || state.inspectDelayMs > 5000) return refuse();
      await new Promise((resolve) => setTimeout(resolve, state.inspectDelayMs));
    }
    process.stdout.write(JSON.stringify(state.inspections[tail[5]]) + '\n');
    return;
  }
  if (tail.length === 5 && tail[0] === 'exec' && tail[1] === fixed.signatureContainerId &&
      tail[2] === 'sha256sum' && tail[3] === '--' && tail[4] === fixed.signaturePath) {
    await record('signature-hash');
    const bytes = await readFile(fixed.signatureBytesPath);
    process.stdout.write(createHash('sha256').update(bytes).digest('hex') + '  ' + fixed.signaturePath + '\n');
    return;
  }
  if (tail.length === 3 && tail[0] === 'exec' && tail[1] === fixed.signatureContainerId && tail[2] === 'clamdcheck.sh') {
    await record('readiness');
    process.stdout.write('synthetic clamdcheck fixture\n');
    process.exitCode = state.ready ? 0 : 1;
    return;
  }
  refuse();
}
main().catch(() => { process.stderr.write('synthetic fixture failed\n'); process.exitCode = 2; });
`
  );
}
async function closeUnixFixture(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
async function withFixture(
  run: (fixture: SyntheticFixture) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(fixturePrefix);
  let server: Server | undefined;
  let connections = 0;
  try {
    expect(dirname(base)).toBe('/private/tmp');
    const workspace = join(base, 'w');
    const runtime = join(base, 'r');
    const configPath = join(runtime, 'docker-observer-empty-config');
    await mkdir(workspace);
    await mkdir(runtime);
    await mkdir(configPath);
    const sourcePath = join(workspace, 'source.ts');
    const configurationPath = join(workspace, 'task-configuration.json');
    const migrationPath = join(runtime, 'applied-migration-receipt.json');
    const signatureSourcePath = join(runtime, 'signature-source-receipt.json');
    const signatureBytesPath = join(runtime, 'synthetic-signature.bin');
    const statePath = join(runtime, 'synthetic-state.json');
    const callPath = join(runtime, 'synthetic-calls.jsonl');
    const executablePath = join(workspace, 'synthetic-cli.mjs');
    const socketPath = join(base, 'ipc.sock');
    expect(Buffer.byteLength(socketPath)).toBeLessThan(90);
    await writeFile(sourcePath, '// synthetic selected source\n');
    await writeFile(configurationPath, '{"synthetic":true}\n');
    await writeFile(migrationPath, '{"synthetic":"applied-migrations-only"}\n');
    await writeFile(
      signatureSourcePath,
      '{"synthetic":"signature-source-only"}\n',
    );
    await writeFile(
      signatureBytesPath,
      'synthetic signature bytes, no virus database\n',
    );
    await writeFile(callPath, '');
    const signatureContainerId = fakeId(3);
    const nodeExecutable = await realpath(process.execPath);
    expect(/\s/.test(nodeExecutable)).toBe(false);
    await writeFile(
      executablePath,
      syntheticCliSource(nodeExecutable, {
        configPath,
        daemonSocket: 'unix://' + socketPath,
        statePath,
        callPath,
        signatureBytesPath,
        signatureContainerId,
        signaturePath,
        inspectTemplate: expectedInspectTemplate(),
      }),
    );
    await chmod(executablePath, 0o700);
    const inspections: Record<string, SyntheticInspection> = {};
    const services: A12NativeService[] = ['api', 'data-worker', 'clamav'].map(
      (service, i) => {
        const id = fakeId(i + 1);
        const portMap: SyntheticPortMap =
          service === 'api'
            ? {
                '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '43123' }],
              }
            : null;
        const raw: SyntheticInspection = {
          id,
          image: 'sha256:' + fakeId(i + 11),
          startedAt: '2026-10-06T08:20:00Z',
          restarts: 0,
          running: true,
          owner: syntheticOwner,
          mounts: [
            {
              Type: 'volume',
              Name: 'synthetic-' + service,
              Source: '/synthetic/' + service,
              Destination: '/data',
              RW: true,
            },
          ],
          hostPorts: portMap,
          networkPorts: portMap,
        };
        inspections[id] = raw;
        return {
          service,
          containerId: id,
          imageId: raw.image,
          startedAt: raw.startedAt,
          restartGeneration: raw.restarts,
          ownerLabelKey,
          ownerLabelValue: raw.owner,
          mountsSha256: jsonDigest(
            raw.mounts.map((mount) => [
              mount.Type,
              mount.Name,
              mount.Source,
              mount.Destination,
              mount.RW,
            ]),
          ),
          portsSha256: jsonDigest([
            canonicalPorts(raw.hostPorts),
            canonicalPorts(raw.networkPorts),
          ]),
        };
      },
    );
    const state: SyntheticState = {
      marker: 'synthetic-cli-not-docker',
      inspections,
      ready: true,
    };
    const persistState = async () => {
      await writeFile(statePath, JSON.stringify(state));
    };
    await persistState();
    server = createServer((socket) => {
      // No test/CLI connects. Refuse and close any unexpected local connection.
      connections++;
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen({ path: socketPath }, resolve);
    });
    await chmod(socketPath, 0o600);
    const socketMetadata = await lstat(socketPath);
    expect(socketMetadata.isSocket()).toBe(true);
    expect(socketMetadata.isSymbolicLink()).toBe(false);
    const executableMetadata = await lstat(executablePath);
    expect(executableMetadata.isFile()).toBe(true);
    const sourceBuildFiles = [await filePin(sourcePath)];
    const configurationFiles = [await filePin(configurationPath)];
    const appliedMigrationReceipt = await filePin(migrationPath);
    const signatureSourceReceipt = await filePin(signatureSourcePath);
    const signatureBytes = await readFile(signatureBytesPath);
    const signatureFiles = [
      {
        path: signaturePath,
        sha256: digest(signatureBytes),
        sizeBytes: signatureBytes.length,
      },
    ];
    const rootPins = [await rootPin(workspace), await rootPin(runtime)];
    const selectors: A12NativeRuntimeSelectors = {
      dockerExecutable: executablePath,
      daemonSocket: 'unix://' + socketPath,
      services,
      sourceBuildFiles,
      configurationFiles,
      appliedMigrationReceipt,
      signatureSourceReceipt,
      signatureContainerId,
      signatureFiles,
      rootPins,
      executablePin: {
        path: executablePath,
        realPath: await realpath(executablePath),
        identity: identity(executableMetadata),
      },
      socketPin: {
        path: socketPath,
        realPath: await realpath(socketPath),
        identity: identity(socketMetadata),
      },
      observerDockerConfigRoot: {
        ...(await rootPin(configPath)),
        identity: identity(await lstat(configPath)),
      },
    };
    const policy: A12NativeRuntimePolicy = {
      workspaceRoot: workspace,
      runtimeRoots: [runtime],
      dockerExecutablePaths: [executablePath],
      daemonSocketPaths: [socketPath],
    };
    const expected: RuntimeObservationBinding = {
      generations: services.map((service) => ({
        service: service.service,
        actualId: service.containerId,
        startedAt: service.startedAt,
        restartGeneration: service.restartGeneration,
        immutableImageId: service.imageId,
      })),
      sourceBuildSha256: jsonDigest(sourceBuildFiles.map((pin) => pin.sha256)),
      configurationSha256: jsonDigest(
        configurationFiles.map((pin) => pin.sha256),
      ),
      mountsSha256: jsonDigest(services.map((service) => service.mountsSha256)),
      migrationSha256: jsonDigest([appliedMigrationReceipt.sha256]),
      signatureSourceSha256: jsonDigest([signatureSourceReceipt.sha256]),
      signatureBytesSha256: jsonDigest(signatureFiles.map((pin) => pin.sha256)),
      signatureReadinessSha256: jsonDigest([
        signatureContainerId,
        'clamdcheck.sh',
        0,
      ]),
      ownershipLoopbackSha256: jsonDigest(
        services.map((service) =>
          jsonDigest([
            service.containerId,
            service.ownerLabelValue,
            service.portsSha256,
          ]),
        ),
      ),
    };
    const calls = async (): Promise<SyntheticCall[]> => {
      const text = await readFile(callPath, 'utf8');
      return text.trim()
        ? text
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as SyntheticCall)
        : [];
    };
    await run({
      base,
      workspace,
      runtime,
      sourcePath,
      signatureBytesPath,
      socketPath,
      state,
      selectors,
      policy,
      expected,
      persistState,
      calls,
    });
    expect(connections).toBe(0);
  } finally {
    try {
      await closeUnixFixture(server);
    } finally {
      // Remove only the mkdtemp directory created by this exact invocation.
      if (base.startsWith(fixturePrefix) && dirname(base) === '/private/tmp') {
        await rm(base, { recursive: true, force: true });
      }
    }
  }
}
const readFixture = (fixture: SyntheticFixture) =>
  createA12NativeRuntimeObserver(fixture.selectors, fixture.policy);
const observedFixture = async (fixture: SyntheticFixture) => {
  const read = readFixture(fixture);
  expect(await read(new AbortController().signal)).toEqual({
    status: 'observed',
    binding: fixture.expected,
  });
  return read;
};

// Only inspect fixture-owned PID records. Signal 0 is a read-only existence probe;
// there is no manual termination signal or enumeration of unrelated processes.
function syntheticPidExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid)
    throw new Error('Invalid task-owned synthetic subprocess PID');
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function bounded<T>(
  pending: Promise<T>,
  maximumMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(label + ' did not settle within fixture bound')),
          maximumMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
async function startedInspect(
  fixture: SyntheticFixture,
  previousCalls: number,
): Promise<SyntheticCall> {
  const deadline = performance.now() + 1_500;
  while (performance.now() < deadline) {
    const started = (await fixture.calls()).slice(previousCalls);
    if (started.length > 0) {
      expect(started).toHaveLength(1);
      const call = started[0]!;
      expect(call.marker).toBe('synthetic-cli-not-docker');
      expect(call.kind).toBe('inspect');
      expect(call.argv[9]).toBe(fakeId(1));
      expect(syntheticPidExists(call.pid)).toBe(true);
      return call;
    }
    await pause(15);
  }
  throw new Error(
    'Synthetic inspect did not record a running PID before the fixture bound',
  );
}
async function waitSyntheticPidGone(
  pid: number,
  maximumMs = 1_000,
): Promise<void> {
  const deadline = performance.now() + maximumMs;
  while (performance.now() < deadline) {
    if (!syntheticPidExists(pid)) return;
    await pause(15);
  }
  expect(
    syntheticPidExists(pid),
    'task-owned CLI must exit before its natural 5-second fixture delay',
  ).toBe(false);
}

test(
  'full reader hashes real selected fs and runs only synthetic narrow inspect/hash/clamdcheck argv',
  async () => {
    await withFixture(async (fixture) => {
      await observedFixture(fixture);
      const calls = await fixture.calls();
      expect(calls.map((call) => call.kind)).toEqual([
        'inspect',
        'inspect',
        'inspect',
        'signature-hash',
        'readiness',
      ]);
      expect(
        calls.every((call) => call.marker === 'synthetic-cli-not-docker'),
      ).toBe(true);
      for (const call of calls) {
        expect(call.argv.slice(0, 4)).toEqual([
          '--config',
          fixture.selectors.observerDockerConfigRoot.path,
          '--host',
          'unix://' + fixture.socketPath,
        ]);
        if (call.kind === 'inspect') {
          expect(call.argv.slice(4, 9)).toEqual([
            'inspect',
            '--type',
            'container',
            '--format',
            expectedInspectTemplate(),
          ]);
          expect(call.argv).toHaveLength(10);
        }
      }
      expect(calls[3]!.argv.slice(4)).toEqual([
        'exec',
        fixture.selectors.signatureContainerId,
        'sha256sum',
        '--',
        signaturePath,
      ]);
      expect(calls[4]!.argv.slice(4)).toEqual([
        'exec',
        fixture.selectors.signatureContainerId,
        'clamdcheck.sh',
      ]);
    });
  },
  testTimeoutMs,
);

test(
  'full reader rejects real source digest mismatch when current fs identity matches the selected pin',
  async () => {
    await withFixture(async (fixture) => {
      await observedFixture(fixture);
      const original = fixture.selectors.sourceBuildFiles[0]!;
      await writeFile(
        fixture.sourcePath,
        '// changed synthetic selected source\n',
      );
      const current = await filePin(fixture.sourcePath);
      expect(current.sha256).not.toBe(original.sha256);
      (fixture.selectors.sourceBuildFiles as A12NativeFilePin[])[0] = {
        ...current,
        sha256: original.sha256,
      };
      expect(await readFixture(fixture)(new AbortController().signal)).toEqual({
        status: 'rejected',
        reason: 'build_changed',
      });
      expect(identity(await lstat(fixture.sourcePath))).toEqual(
        current.identity,
      );
    });
  },
  testTimeoutMs,
);

test(
  'full reader rejects a new source inode even when replacement bytes and path are unchanged',
  async () => {
    await withFixture(async (fixture) => {
      const read = await observedFixture(fixture);
      const original = fixture.selectors.sourceBuildFiles[0]!;
      const replacement = join(fixture.workspace, 'replacement.ts');
      await writeFile(replacement, await readFile(fixture.sourcePath));
      await rename(replacement, fixture.sourcePath);
      const current = await filePin(fixture.sourcePath);
      expect(current.sha256).toBe(original.sha256);
      expect(current.identity.ino).not.toBe(original.identity.ino);
      expect(await read(new AbortController().signal)).toEqual({
        status: 'rejected',
        reason: 'build_changed',
      });
    });
  },
  testTimeoutMs,
);

test(
  'full reader rejects synthetic signature-byte drift before running readiness again',
  async () => {
    await withFixture(async (fixture) => {
      const read = await observedFixture(fixture);
      const before = (await fixture.calls()).length;
      await writeFile(
        fixture.signatureBytesPath,
        'changed synthetic signature bytes\n',
      );
      expect(await read(new AbortController().signal)).toEqual({
        status: 'rejected',
        reason: 'signature_changed',
      });
      expect(
        (await fixture.calls()).slice(before).map((call) => call.kind),
      ).toEqual(['inspect', 'inspect', 'inspect', 'signature-hash']);
    });
  },
  testTimeoutMs,
);

test(
  'full reader rejects a synthetic inspected ownership change',
  async () => {
    await withFixture(async (fixture) => {
      const read = await observedFixture(fixture);
      fixture.state.inspections[fakeId(1)]!.owner = 'other-synthetic-owner';
      await fixture.persistState();
      expect(await read(new AbortController().signal)).toEqual({
        status: 'rejected',
        reason: 'ownership_changed',
      });
    });
  },
  testTimeoutMs,
);

test(
  'full reader rejects synthetic 0.0.0.0 port exposure',
  async () => {
    await withFixture(async (fixture) => {
      const read = await observedFixture(fixture);
      const changed: SyntheticPortMap = {
        '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '43123' }],
      };
      fixture.state.inspections[fakeId(1)]!.hostPorts = changed;
      fixture.state.inspections[fakeId(1)]!.networkPorts = changed;
      await fixture.persistState();
      expect(await read(new AbortController().signal)).toEqual({
        status: 'rejected',
        reason: 'loopback_changed',
      });
    });
  },
  testTimeoutMs,
);

test(
  'full reader honors preabort and dispatches no additional synthetic process',
  async () => {
    await withFixture(async (fixture) => {
      const read = await observedFixture(fixture);
      const calls = await fixture.calls();
      const controller = new AbortController();
      controller.abort();
      expect(await read(controller.signal)).toEqual({
        status: 'unknown',
        reason: 'observation_unavailable',
      });
      expect(await fixture.calls()).toEqual(calls);
    });
  },
  testTimeoutMs,
);

test(
  'full reader detaches the chosen services/files/host policy synchronously before the first await',
  async () => {
    await withFixture(async (fixture) => {
      await observedFixture(fixture);
      const read = readFixture(fixture);
      const pending = read(new AbortController().signal);
      (fixture.selectors.sourceBuildFiles as A12NativeFilePin[]).push({
        ...fixture.selectors.sourceBuildFiles[0]!,
        path: join(fixture.base, 'not-selected.ts'),
        realPath: join(fixture.base, 'not-selected.ts'),
      });
      (
        fixture.selectors.services[0] as { ownerLabelValue: string }
      ).ownerLabelValue = 'mutated-after-selection';
      (fixture.policy.runtimeRoots as string[]).splice(
        0,
        1,
        join(fixture.base, 'not-selected-runtime'),
      );
      (fixture.policy.dockerExecutablePaths as string[]).length = 0;
      (fixture.policy.daemonSocketPaths as string[]).length = 0;
      expect(await pending).toEqual({
        status: 'observed',
        binding: fixture.expected,
      });
    });
  },
  testTimeoutMs,
);

test(
  'full factory refuses accessor policy and object service values without getters or coercion',
  async () => {
    await withFixture(async (fixture) => {
      await observedFixture(fixture);
      const before = await fixture.calls();
      let getterCalls = 0;
      const policy = { ...fixture.policy };
      Object.defineProperty(policy, 'runtimeRoots', {
        get() {
          getterCalls++;
          throw new Error('not data');
        },
      });
      expect(
        await createA12NativeRuntimeObserver(
          fixture.selectors,
          policy,
        )(new AbortController().signal),
      ).toEqual({ status: 'unknown', reason: 'observation_missing' });
      let coercions = 0;
      Object.defineProperty(fixture.selectors.services[0]!, 'containerId', {
        value: {
          toString() {
            coercions++;
            return fakeId(1);
          },
        },
      });
      expect(await readFixture(fixture)(new AbortController().signal)).toEqual({
        status: 'unknown',
        reason: 'observation_missing',
      });
      expect(getterCalls).toBe(0);
      expect(coercions).toBe(0);
      expect(await fixture.calls()).toEqual(before);
    });
  },
  testTimeoutMs,
);

test(
  'full reader and real lifecycle window open/unchanged then retain known ownership refusal',
  async () => {
    await withFixture(async (fixture) => {
      const windows = createA12RuntimeObservationWindows(readFixture(fixture), {
        maximumObservationMs: 10_000,
        sampleIntervalMs: 60_000,
        maximumWindows: 1,
      });
      try {
        const opened = await windows.openWindow();
        expect(opened.status).toBe('open');
        if (opened.status !== 'open')
          throw new Error('Missing synthetic observation window');
        expect(await windows.checkpoint(opened.window)).toEqual({
          status: 'unchanged',
        });
        fixture.state.inspections[fakeId(1)]!.owner =
          'changed-synthetic-window-owner';
        await fixture.persistState();
        const refused = { status: 'rejected', reason: 'ownership_changed' };
        expect(await windows.checkpoint(opened.window)).toEqual(refused);
        expect(windows.signal(opened.window).aborted).toBe(true);
        const afterRefusal = await fixture.calls();
        fixture.state.inspections[fakeId(1)]!.owner = syntheticOwner;
        await fixture.persistState();
        expect(await windows.checkpoint(opened.window)).toEqual(refused);
        expect(await fixture.calls()).toEqual(afterRefusal);
      } finally {
        windows.close();
      }
      expect(windows.diagnostics()).toEqual({
        activeWindows: 0,
        activeObservations: 0,
        activeWatchers: 0,
        closed: true,
      });
    });
  },
  testTimeoutMs,
);

test(
  'full reader mid-inspect abort returns unknown, stops dispatch and terminates its recorded synthetic child',
  async () => {
    await withFixture(async (fixture) => {
      const read = await observedFixture(fixture);
      const before = (await fixture.calls()).length;
      fixture.state.inspectDelayForId = fakeId(1);
      fixture.state.inspectDelayMs = 5_000;
      await fixture.persistState();
      const controller = new AbortController();
      const pending = read(controller.signal);
      let started: SyntheticCall | undefined;
      try {
        started = await startedInspect(fixture, before);
        controller.abort();
        expect(
          await bounded(pending, 1_000, 'native observation cancellation'),
        ).toEqual({
          status: 'unknown',
          reason: 'observation_unavailable',
        });
        await waitSyntheticPidGone(started.pid);
        expect((await fixture.calls()).slice(before)).toEqual([started]);
        await pause(75);
        expect((await fixture.calls()).slice(before)).toEqual([started]);
      } finally {
        controller.abort();
        // On a failing cancellation regression the synthetic delay still ends
        // naturally. Drain only this observation/PID; never manually kill a PID.
        await bounded(pending, 7_000, 'synthetic observation cleanup');
        if (started) await waitSyntheticPidGone(started.pid, 6_000);
      }
    });
  },
  testTimeoutMs,
);

test(
  'full reader obeys an outer window deadline, stops dispatch and terminates its recorded synthetic child',
  async () => {
    await withFixture(async (fixture) => {
      const windows = createA12RuntimeObservationWindows(readFixture(fixture), {
        maximumObservationMs: 2_500,
        sampleIntervalMs: 60_000,
        maximumWindows: 1,
      });
      let started: SyntheticCall | undefined;
      try {
        const opened = await windows.openWindow();
        expect(opened.status).toBe('open');
        if (opened.status !== 'open')
          throw new Error('Missing synthetic observation window');
        const before = (await fixture.calls()).length;
        fixture.state.inspectDelayForId = fakeId(1);
        fixture.state.inspectDelayMs = 5_000;
        await fixture.persistState();
        const pending = windows.checkpoint(opened.window);
        started = await startedInspect(fixture, before);
        const unavailable = {
          status: 'unknown',
          reason: 'observation_unavailable',
        };
        expect(
          await bounded(pending, 3_000, 'outer observation-window deadline'),
        ).toEqual(unavailable);
        expect(windows.signal(opened.window).aborted).toBe(true);
        await waitSyntheticPidGone(started.pid);
        expect((await fixture.calls()).slice(before)).toEqual([started]);
        await pause(75);
        expect(await windows.checkpoint(opened.window)).toEqual(unavailable);
        expect((await fixture.calls()).slice(before)).toEqual([started]);
      } finally {
        windows.close();
        if (started) await waitSyntheticPidGone(started.pid, 6_000);
      }
      expect(windows.diagnostics()).toEqual({
        activeWindows: 0,
        activeObservations: 0,
        activeWatchers: 0,
        closed: true,
      });
    });
  },
  testTimeoutMs,
);

test(
  'full reader refuses host-policy root/executable/socket path mismatch before process dispatch',
  async () => {
    await withFixture(async (fixture) => {
      await observedFixture(fixture);
      const before = await fixture.calls();
      const candidates: A12NativeRuntimePolicy[] = [
        {
          ...fixture.policy,
          workspaceRoot: join(fixture.base, 'unselected-workspace'),
        },
        {
          ...fixture.policy,
          runtimeRoots: [join(fixture.base, 'unselected-runtime')],
        },
        {
          ...fixture.policy,
          dockerExecutablePaths: [
            join(fixture.workspace, 'unselected-cli.mjs'),
          ],
        },
        {
          ...fixture.policy,
          daemonSocketPaths: [join(fixture.base, 'unselected.sock')],
        },
      ];
      for (const policy of candidates) {
        expect(
          await createA12NativeRuntimeObserver(
            fixture.selectors,
            policy,
          )(new AbortController().signal),
        ).toEqual({ status: 'unknown', reason: 'observation_missing' });
        expect(await fixture.calls()).toEqual(before);
      }
    });
  },
  testTimeoutMs,
);

test(
  'full reader refuses a selected root alias whose canonical target lies outside the host policy before reading or dispatch',
  async () => {
    await withFixture(async (fixture) => {
      await observedFixture(fixture);
      const before = await fixture.calls();
      const outside = join(fixture.base, 'outside-selected-workspace');
      await rename(fixture.workspace, outside);
      await symlink(outside, fixture.workspace, 'dir');
      expect((await lstat(fixture.workspace)).isSymbolicLink()).toBe(true);
      const metadata = await lstat(outside);
      (fixture.selectors.rootPins as A12NativeRootPin[])[0] = {
        path: fixture.workspace,
        realPath: outside,
        dev: metadata.dev,
        ino: metadata.ino,
      };
      (fixture.selectors.sourceBuildFiles as A12NativeFilePin[])[0] =
        await filePin(fixture.sourcePath);
      const configuration = fixture.selectors.configurationFiles[0]!;
      (fixture.selectors.configurationFiles as A12NativeFilePin[])[0] =
        await filePin(configuration.path);
      const executablePath = fixture.selectors.executablePin.path;
      const executableRealPath = await realpath(executablePath);
      (
        fixture.selectors as {
          executablePin: A12NativeRuntimeSelectors['executablePin'];
        }
      ).executablePin = {
        path: executablePath,
        realPath: executableRealPath,
        identity: identity(await lstat(executablePath)),
      };
      // Executable permission is explicit and separate; it cannot widen allowed source roots.
      (fixture.policy.dockerExecutablePaths as string[]).push(
        executableRealPath,
      );
      expect(await readFixture(fixture)(new AbortController().signal)).toEqual({
        status: 'unknown',
        reason: 'observation_missing',
      });
      expect(await fixture.calls()).toEqual(before);
    });
  },
  testTimeoutMs,
);
