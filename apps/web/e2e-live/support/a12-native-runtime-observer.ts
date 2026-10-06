/** Task-host native reader. Reads selected values only; never issues launch or scan authority. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open, realpath, opendir, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, normalize, relative, sep } from 'node:path';
import type {
  RuntimeObservationBinding,
  RuntimeGeneration,
  RuntimeWindowReason,
} from './a12-normal-runtime-window.ts';
const sha = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');
export interface A12NativeFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}
export interface A12NativeRootPin {
  readonly path: string;
  readonly realPath: string;
  readonly dev: number;
  readonly ino: number;
  readonly identity?: A12NativeFileIdentity;
}
export interface A12NativePathPin {
  readonly path: string;
  readonly realPath: string;
  readonly identity: A12NativeFileIdentity;
}
// Pins/selectors are read inputs only. The factory does not attest a launch or issue authority.
export interface A12NativeFilePin {
  readonly path: string;
  readonly sha256: string;
  readonly realPath: string;
  readonly identity: A12NativeFileIdentity;
}
export interface A12NativeService {
  readonly service: string;
  readonly containerId: string;
  readonly imageId: string;
  readonly startedAt: string;
  readonly restartGeneration: number;
  readonly ownerLabelKey:
    'com.docker.compose.project' | 'com.supabase.cli.project';
  readonly ownerLabelValue: string;
  readonly mountsSha256: string;
  readonly portsSha256: string;
}
/** Inputs selected by the task-private launcher. These ordinary values cannot attest that it ran. */
export interface A12NativeRuntimeSelectors {
  readonly dockerExecutable: string;
  readonly daemonSocket: string;
  readonly services: readonly A12NativeService[];
  readonly sourceBuildFiles: readonly A12NativeFilePin[];
  readonly configurationFiles: readonly A12NativeFilePin[];
  readonly appliedMigrationReceipt: A12NativeFilePin;
  readonly signatureSourceReceipt: A12NativeFilePin;
  readonly signatureContainerId: string;
  readonly signatureFiles: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly sizeBytes: number;
  }[];
  readonly rootPins: readonly A12NativeRootPin[];
  readonly executablePin: A12NativePathPin;
  readonly socketPin: A12NativePathPin;
  readonly observerDockerConfigRoot: A12NativeRootPin & {
    readonly identity: A12NativeFileIdentity;
  };
}
/** Canonical local roots selected by the trusted task host; ordinary inputs grant no runtime authority. */
export interface A12NativeRuntimePolicy {
  readonly workspaceRoot: string;
  readonly runtimeRoots: readonly string[];
  readonly dockerExecutablePaths: readonly string[];
  readonly daemonSocketPaths: readonly string[];
}
type NativeFileIdentity = A12NativeFileIdentity;
type NativeRootPin = A12NativeRootPin;
type NativePathPin = A12NativePathPin;
type FilePin = A12NativeFilePin;
type NativeService = A12NativeService;
type SelectedNativeInputs = A12NativeRuntimeSelectors;
type OwnerReason = RuntimeWindowReason;
type Generation = RuntimeGeneration;
type Observation = A12NativeRuntimeObservation;
export type A12NativeRuntimeObservation =
  | { readonly status: 'observed'; readonly binding: RuntimeObservationBinding }
  | {
      readonly status: 'unknown' | 'rejected';
      readonly reason: RuntimeWindowReason;
    };
const exact = (
  value: unknown,
  names: readonly string[],
): Record<string, unknown> | null => {
  try {
    if (
      value === null ||
      typeof value !== 'object' ||
      ![Object.prototype, null].includes(
        Object.getPrototypeOf(value) as object | null,
      )
    )
      return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).length !== names.length ||
      Reflect.ownKeys(descriptors).some(
        (key) => typeof key !== 'string' || !names.includes(key),
      ) ||
      Object.values(descriptors).some((d) => !Object.hasOwn(d, 'value'))
    )
      return null;
    return Object.fromEntries(
      Object.entries(descriptors).map(([key, d]) => [key, d.value]),
    );
  } catch {
    return null;
  }
};
function plainArray(value: unknown, maximum = 256): readonly unknown[] | null {
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    )
      return null;
    const length = Object.getOwnPropertyDescriptor(value, 'length')
      ?.value as unknown;
    if (
      !Number.isSafeInteger(length) ||
      (length as number) < 0 ||
      (length as number) > maximum
    )
      return null;
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor
    >;
    if (
      !Number.isSafeInteger(length) ||
      (length as number) < 0 ||
      Reflect.ownKeys(descriptors).length !== (length as number) + 1 ||
      Object.values(descriptors).some((d) => !Object.hasOwn(d, 'value'))
    )
      return null;
    return Array.from(
      { length: length as number },
      (_, i) => descriptors[String(i)]?.value as unknown,
    );
  } catch {
    return null;
  }
}
function snapshotIdentity(value: unknown): NativeFileIdentity | null {
  const fields = exact(value, ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']);
  if (
    !fields ||
    Object.values(fields).some(
      (n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0,
    ) ||
    !Number.isSafeInteger(fields.size)
  )
    return null;
  return Object.freeze({ ...fields }) as unknown as NativeFileIdentity;
}
function snapshotFile(value: unknown): FilePin | null {
  const fields = exact(value, ['path', 'sha256', 'realPath', 'identity']);
  const id = fields && snapshotIdentity(fields.identity);
  if (
    !fields ||
    !id ||
    typeof fields.path !== 'string' ||
    typeof fields.sha256 !== 'string' ||
    typeof fields.realPath !== 'string'
  )
    return null;
  return Object.freeze({
    path: fields.path,
    sha256: fields.sha256,
    realPath: fields.realPath,
    identity: id,
  });
}
function snapshotRoot(value: unknown): NativeRootPin | null {
  const fields =
    exact(value, ['path', 'realPath', 'dev', 'ino', 'identity']) ??
    exact(value, ['path', 'realPath', 'dev', 'ino']);
  if (
    !fields ||
    typeof fields.path !== 'string' ||
    typeof fields.realPath !== 'string' ||
    typeof fields.dev !== 'number' ||
    !Number.isFinite(fields.dev) ||
    fields.dev < 0 ||
    typeof fields.ino !== 'number' ||
    !Number.isFinite(fields.ino) ||
    fields.ino < 0
  )
    return null;
  const id = Object.hasOwn(fields, 'identity')
    ? snapshotIdentity(fields.identity)
    : undefined;
  if (id === null) return null;
  return Object.freeze({
    path: fields.path,
    realPath: fields.realPath,
    dev: fields.dev,
    ino: fields.ino,
    ...(id === undefined ? {} : { identity: id }),
  });
}
function snapshotPath(value: unknown): NativePathPin | null {
  const fields = exact(value, ['path', 'realPath', 'identity']);
  const id = fields && snapshotIdentity(fields.identity);
  if (
    !fields ||
    !id ||
    typeof fields.path !== 'string' ||
    typeof fields.realPath !== 'string'
  )
    return null;
  return Object.freeze({
    path: fields.path,
    realPath: fields.realPath,
    identity: id,
  });
}
function snapshotNativeSelectors(value: unknown): SelectedNativeInputs | null {
  const top = exact(value, [
    'dockerExecutable',
    'daemonSocket',
    'services',
    'sourceBuildFiles',
    'configurationFiles',
    'appliedMigrationReceipt',
    'signatureSourceReceipt',
    'signatureContainerId',
    'signatureFiles',
    'rootPins',
    'executablePin',
    'socketPin',
    'observerDockerConfigRoot',
  ]);
  if (
    !top ||
    typeof top.dockerExecutable !== 'string' ||
    typeof top.daemonSocket !== 'string' ||
    typeof top.signatureContainerId !== 'string'
  )
    return null;
  const services = plainArray(top.services, 32),
    source = plainArray(top.sourceBuildFiles),
    configuration = plainArray(top.configurationFiles),
    signatures = plainArray(top.signatureFiles, 8),
    roots = plainArray(top.rootPins, 3);
  if (!services || !source || !configuration || !signatures || !roots)
    return null;
  const serviceCopies = services.map((item) => {
    const fields = exact(item, [
      'service',
      'containerId',
      'imageId',
      'startedAt',
      'restartGeneration',
      'ownerLabelKey',
      'ownerLabelValue',
      'mountsSha256',
      'portsSha256',
    ]);
    if (
      !fields ||
      [
        'service',
        'containerId',
        'imageId',
        'startedAt',
        'ownerLabelKey',
        'ownerLabelValue',
        'mountsSha256',
        'portsSha256',
      ].some((key) => typeof fields[key] !== 'string') ||
      !Number.isSafeInteger(fields.restartGeneration) ||
      (fields.restartGeneration as number) < 0 ||
      !['com.docker.compose.project', 'com.supabase.cli.project'].includes(
        fields.ownerLabelKey as string,
      )
    )
      return null;
    // All copied fields are primitives; no caller toString/valueOf or mutable object survives.
    return Object.freeze({ ...fields }) as unknown as NativeService;
  });
  const sourceCopies = source.map(snapshotFile),
    configurationCopies = configuration.map(snapshotFile),
    rootCopies = roots.map(snapshotRoot);
  const signatureCopies = signatures.map((item) => {
    const fields = exact(item, ['path', 'sha256', 'sizeBytes']);
    if (
      !fields ||
      typeof fields.path !== 'string' ||
      typeof fields.sha256 !== 'string' ||
      !Number.isSafeInteger(fields.sizeBytes) ||
      (fields.sizeBytes as number) < 0
    )
      return null;
    return Object.freeze({
      path: fields.path,
      sha256: fields.sha256,
      sizeBytes: fields.sizeBytes as number,
    });
  });
  const migration = snapshotFile(top.appliedMigrationReceipt),
    signatureSource = snapshotFile(top.signatureSourceReceipt),
    executable = snapshotPath(top.executablePin),
    socket = snapshotPath(top.socketPin),
    config = snapshotRoot(top.observerDockerConfigRoot);
  if (
    [
      ...serviceCopies,
      ...sourceCopies,
      ...configurationCopies,
      ...rootCopies,
      ...signatureCopies,
    ].some((item) => item === null) ||
    !migration ||
    !signatureSource ||
    !executable ||
    !socket ||
    !config?.identity
  )
    return null;
  return Object.freeze({
    dockerExecutable: top.dockerExecutable,
    daemonSocket: top.daemonSocket,
    signatureContainerId: top.signatureContainerId,
    services: Object.freeze(serviceCopies as NativeService[]),
    sourceBuildFiles: Object.freeze(sourceCopies as FilePin[]),
    configurationFiles: Object.freeze(configurationCopies as FilePin[]),
    signatureFiles: Object.freeze(
      signatureCopies as { path: string; sha256: string; sizeBytes: number }[],
    ),
    rootPins: Object.freeze(rootCopies as NativeRootPin[]),
    appliedMigrationReceipt: migration,
    signatureSourceReceipt: signatureSource,
    executablePin: executable,
    socketPin: socket,
    observerDockerConfigRoot: config as NativeRootPin & {
      readonly identity: NativeFileIdentity;
    },
  });
}
// This host utility executes no I/O on import. Actual launch admission remains task-private.
function snapshotNativePolicy(value: unknown): A12NativeRuntimePolicy | null {
  const fields = exact(value, [
    'workspaceRoot',
    'runtimeRoots',
    'dockerExecutablePaths',
    'daemonSocketPaths',
  ]);
  if (!fields || typeof fields.workspaceRoot !== 'string') return null;
  const runtime = plainArray(fields.runtimeRoots, 2);
  const executables = plainArray(fields.dockerExecutablePaths, 8);
  const sockets = plainArray(fields.daemonSocketPaths, 4);
  if (!runtime?.length || !executables?.length || !sockets?.length) return null;
  const lists = [runtime, executables, sockets];
  if (
    lists.some(
      (list) =>
        list.some(
          (path) =>
            typeof path !== 'string' ||
            path === '/' ||
            !nonCredentialPath(path),
        ) || new Set(list).size !== list.length,
    ) ||
    fields.workspaceRoot === '/' ||
    !nonCredentialPath(fields.workspaceRoot) ||
    runtime.includes(fields.workspaceRoot)
  )
    return null;
  return Object.freeze({
    workspaceRoot: fields.workspaceRoot,
    runtimeRoots: Object.freeze([...runtime]) as readonly string[],
    dockerExecutablePaths: Object.freeze([...executables]) as readonly string[],
    daemonSocketPaths: Object.freeze([...sockets]) as readonly string[],
  });
}
const nativeObservationLimits = Object.freeze({
  deadlineMs: 30_000,
  bytes: 512 * 1024 * 1024,
  files: 256,
  services: 32,
  fileBytes: 8 * 1024 * 1024,
  commandBytes: 256 * 1024,
});
interface ObservationLimits {
  readonly deadlineMs: number;
  readonly bytes: number;
  readonly files: number;
  readonly services: number;
  readonly fileBytes: number;
  readonly commandBytes: number;
}
class NativeRefusal extends Error {
  readonly status: 'unknown' | 'rejected';
  readonly reason: OwnerReason;
  constructor(status: 'unknown' | 'rejected', reason: OwnerReason) {
    super('Native observation unavailable');
    this.status = status;
    this.reason = reason;
  }
}
function captureNative(prototype: object, name: string, kind: 'value' | 'get') {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
  const method: unknown = descriptor
    ? Reflect.get(descriptor, kind)
    : undefined;
  return typeof method === 'function' ? method : null;
}
const trustedAddListener = captureNative(
  EventTarget.prototype,
  'addEventListener',
  'value',
);
const trustedRemoveListener = captureNative(
  EventTarget.prototype,
  'removeEventListener',
  'value',
);
const trustedAborted = captureNative(AbortSignal.prototype, 'aborted', 'get');
const trustedAbort = captureNative(AbortController.prototype, 'abort', 'value');
function nativeSignalAborted(signal: AbortSignal): boolean {
  try {
    return trustedAborted
      ? Reflect.apply(trustedAborted, signal, []) === true
      : true;
  } catch {
    return true;
  }
}
function nativeAddListener(signal: AbortSignal, listener: () => void): void {
  if (!trustedAddListener)
    throw new NativeRefusal('unknown', 'observation_unavailable');
  Reflect.apply(trustedAddListener, signal, [
    'abort',
    listener,
    { once: true },
  ]);
}
function nativeRemoveListener(signal: AbortSignal, listener: () => void): void {
  try {
    if (trustedRemoveListener)
      Reflect.apply(trustedRemoveListener, signal, ['abort', listener]);
  } catch {
    /* Cleanup cannot suppress result settlement or the owned abort. */
  }
}
function abortOwned(controller: AbortController, reason: string): void {
  if (trustedAbort) Reflect.apply(trustedAbort, controller, [reason]);
}
/** One controller/deadline/accounting ledger for one whole observation, including every command. */
class ObservationBudget {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  readonly deadline: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly parent: AbortSignal;
  private readonly parentAbort: () => void;
  private disposed = false;
  private bytes = 0;
  private files = 0;
  private services = 0;
  readonly limits: ObservationLimits;
  constructor(
    parent: AbortSignal,
    limits: ObservationLimits = nativeObservationLimits,
  ) {
    this.limits = limits;
    this.parent = parent;
    this.deadline = performance.now() + limits.deadlineMs;
    this.parentAbort = () =>
      abortOwned(this.controller, 'native_observation_cancelled');
    nativeAddListener(parent, this.parentAbort);
    this.timer = setTimeout(
      () => abortOwned(this.controller, 'native_observation_deadline'),
      limits.deadlineMs,
    );
    if (nativeSignalAborted(parent)) this.parentAbort();
  }
  check(): void {
    if (
      this.disposed ||
      nativeSignalAborted(this.signal) ||
      performance.now() >= this.deadline
    ) {
      abortOwned(this.controller, 'native_observation_unavailable');
      throw new NativeRefusal('unknown', 'observation_unavailable');
    }
  }
  remainingMs(): number {
    this.check();
    return Math.max(1, Math.ceil(this.deadline - performance.now()));
  }
  remainingBytes(): number {
    this.check();
    return this.limits.bytes - this.bytes;
  }
  consumeBytes(count: number): void {
    this.check();
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > this.limits.bytes - this.bytes
    ) {
      abortOwned(this.controller, 'native_observation_byte_limit');
      throw new NativeRefusal('unknown', 'observation_unavailable');
    }
    this.bytes += count;
  }
  claimFiles(count: number): void {
    this.check();
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > this.limits.files - this.files
    )
      throw new NativeRefusal('unknown', 'observation_unavailable');
    this.files += count;
  }
  claimServices(count: number): void {
    this.check();
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > this.limits.services - this.services
    )
      throw new NativeRefusal('unknown', 'observation_unavailable');
    this.services += count;
  }
  // Node stat/realpath/open cannot be cancelled. Race them against the owned signal, discard late
  // results and close a late-opened descriptor. No following operation may run after cancellation.
  async wait<T>(
    pending: Promise<T>,
    releaseLate?: (value: T) => Promise<unknown>,
  ): Promise<T> {
    const release = (value: T) => {
      if (releaseLate)
        void Promise.resolve()
          .then(() => releaseLate(value))
          .catch(() => undefined);
    };
    try {
      this.check();
    } catch (error) {
      void pending.then(release, () => undefined).catch(() => undefined);
      throw error;
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const aborted = () => {
        if (settled) return;
        settled = true;
        nativeRemoveListener(this.signal, aborted);
        reject(new NativeRefusal('unknown', 'observation_unavailable'));
      };
      nativeAddListener(this.signal, aborted);
      pending
        .then(
          (value) => {
            if (settled) {
              release(value);
              return;
            }
            settled = true;
            nativeRemoveListener(this.signal, aborted);
            try {
              this.check();
              resolve(value);
            } catch (error) {
              release(value);
              reject(
                error instanceof NativeRefusal
                  ? error
                  : new NativeRefusal('unknown', 'observation_unavailable'),
              );
            }
          },
          () => {
            if (settled) return;
            settled = true;
            nativeRemoveListener(this.signal, aborted);
            reject(new NativeRefusal('unknown', 'observation_unavailable'));
          },
        )
        .catch(() => undefined);
      if (nativeSignalAborted(this.signal)) aborted();
    });
  }
  snapshot() {
    return {
      bytes: this.bytes,
      files: this.files,
      services: this.services,
      aborted: nativeSignalAborted(this.signal),
      disposed: this.disposed,
    };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    nativeRemoveListener(this.parent, this.parentAbort);
    abortOwned(this.controller, 'native_observation_complete');
  }
}
function identity(metadata: Stats): NativeFileIdentity {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  };
}
function sameIdentity(a: NativeFileIdentity, b: NativeFileIdentity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
function validIdentity(
  value: NativeFileIdentity | undefined,
): value is NativeFileIdentity {
  return (
    value !== undefined &&
    [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].every(
      (n) => Number.isFinite(n) && n >= 0,
    ) &&
    Number.isSafeInteger(value.size)
  );
}
function beneath(path: string, root: string): boolean {
  const part = relative(root, path);
  return (
    part !== '' &&
    part !== '..' &&
    !part.startsWith('..' + sep) &&
    !isAbsolute(part)
  );
}
function nonCredentialPath(path: string): boolean {
  if (!isAbsolute(path) || normalize(path) !== path) return false;
  return !path
    .split(sep)
    .some((part) =>
      /^(?:\.env.*|auth\.json|.*(?:token|secret|password|passwd|credential).*|compose\.override\.yaml|.*\.(?:pem|key|p12|pfx))$/i.test(
        part,
      ),
    );
}
async function observedRoot(
  root: NativeRootPin,
  budget: ObservationBudget,
): Promise<void> {
  const resolved = await budget.wait(realpath(root.path));
  const metadata = await budget.wait(stat(root.path));
  if (
    resolved !== root.realPath ||
    !metadata.isDirectory() ||
    metadata.dev !== root.dev ||
    metadata.ino !== root.ino
  )
    throw new NativeRefusal('rejected', 'configuration_changed');
}
async function pathIdentity(
  pin: NativePathPin,
  budget: ObservationBudget,
  kind: 'executable' | 'socket',
): Promise<void> {
  if (
    !isAbsolute(pin.path) ||
    !isAbsolute(pin.realPath) ||
    !validIdentity(pin.identity)
  )
    throw new NativeRefusal('unknown', 'observation_missing');
  const resolved = await budget.wait(realpath(pin.path));
  const metadata = await budget.wait(stat(pin.path));
  if (
    resolved !== pin.realPath ||
    !sameIdentity(identity(metadata), pin.identity)
  )
    throw new NativeRefusal(
      'rejected',
      kind === 'executable' ? 'build_changed' : 'ownership_changed',
    );
  if (kind === 'executable' ? !metadata.isFile() : !metadata.isSocket())
    throw new NativeRefusal('unknown', 'observation_missing');
}
async function pinnedFiles(
  pins: readonly FilePin[],
  drift: OwnerReason,
  roots: readonly NativeRootPin[],
  budget: ObservationBudget,
): Promise<string> {
  if (pins.length === 0 || roots.length === 0)
    throw new NativeRefusal('unknown', 'observation_missing');
  const digests: string[] = [];
  for (const pin of pins) {
    budget.check();
    if (
      !nonCredentialPath(pin.path) ||
      pin.realPath === undefined ||
      !nonCredentialPath(pin.realPath) ||
      !validIdentity(pin.identity) ||
      !/^[a-f0-9]{64}$/.test(pin.sha256)
    )
      throw new NativeRefusal('unknown', 'observation_missing');
    const root = roots.find(
      (candidate) =>
        beneath(pin.path, candidate.path) &&
        beneath(pin.realPath, candidate.realPath),
    );
    if (!root) throw new NativeRefusal('unknown', 'observation_missing');
    await observedRoot(root, budget);
    const resolved = await budget.wait(realpath(pin.path));
    const leaf = await budget.wait(lstat(pin.path));
    if (
      resolved !== pin.realPath ||
      leaf.isSymbolicLink() ||
      !leaf.isFile() ||
      !sameIdentity(identity(leaf), pin.identity)
    )
      throw new NativeRefusal('rejected', drift);
    if (
      leaf.size > budget.limits.fileBytes ||
      leaf.size > budget.remainingBytes()
    )
      throw new NativeRefusal('unknown', 'observation_unavailable');
    let fd: FileHandle | undefined;
    try {
      fd = await budget.wait(
        open(pin.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW),
        (handle) => handle.close(),
      );
      const before = await budget.wait(fd.stat());
      if (!before.isFile() || !sameIdentity(identity(before), pin.identity))
        throw new NativeRefusal('rejected', drift);
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(
        Math.min(64 * 1024, Math.max(1, before.size + 1)),
      );
      let position = 0;
      while (position < before.size) {
        budget.check();
        const take = Math.min(buffer.length, before.size - position);
        const chunk = await budget.wait(fd.read(buffer, 0, take, position));
        if (chunk.bytesRead === 0) throw new NativeRefusal('rejected', drift);
        budget.consumeBytes(chunk.bytesRead);
        hash.update(buffer.subarray(0, chunk.bytesRead));
        position += chunk.bytesRead;
      }
      const after = await budget.wait(fd.stat());
      const currentRealPath = await budget.wait(realpath(pin.path));
      const currentLeaf = await budget.wait(lstat(pin.path));
      await observedRoot(root, budget);
      if (
        !sameIdentity(identity(after), pin.identity) ||
        currentRealPath !== pin.realPath ||
        currentLeaf.isSymbolicLink() ||
        !sameIdentity(identity(currentLeaf), pin.identity)
      )
        throw new NativeRefusal('rejected', drift);
      const digest = hash.digest('hex');
      if (digest !== pin.sha256) throw new NativeRefusal('rejected', drift);
      digests.push(digest);
    } finally {
      // Cleanup is owned, but uncancellable OS completion must not extend the observation deadline.
      if (fd) await budget.wait(fd.close()).catch(() => undefined);
    }
  }
  budget.check();
  return sha(JSON.stringify(digests));
}
/** Narrow execFile transport. Calls below generate arguments; no shell, env inheritance or raw errors. */
async function boundedExec(
  file: string,
  args: readonly string[],
  budget: ObservationBudget,
  environment: Readonly<Record<string, string>>,
): Promise<string> {
  budget.check();
  const limit = Math.min(budget.limits.commandBytes, budget.remainingBytes());
  if (limit < 1) throw new NativeRefusal('unknown', 'observation_unavailable');
  return budget.wait(
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        file,
        [...args],
        {
          encoding: 'utf8',
          shell: false,
          maxBuffer: limit,
          timeout: budget.remainingMs(),
          signal: budget.signal,
          killSignal: 'SIGKILL',
          // Fixed CLI-only mode; no task or service environment is inherited.
          env: { ...environment, NODE_ENV: 'production' },
        },
        (error, stdout) => {
          if (
            error ||
            nativeSignalAborted(budget.signal) ||
            typeof stdout !== 'string'
          )
            reject(new NativeRefusal('unknown', 'observation_unavailable'));
          else resolve(stdout);
        },
      );
      const consume = (bytes: Buffer | string) => {
        try {
          budget.consumeBytes(
            Buffer.isBuffer(bytes) ? bytes.length : Buffer.byteLength(bytes),
          );
        } catch {
          child.kill('SIGKILL');
        }
      };
      child.stdout?.on('data', consume);
      child.stderr?.on('data', consume);
    }),
  );
}
function inspectTemplate(labelKey: NativeService['ownerLabelKey']): string {
  // Whitelist only. No Config.Env/raw Config/Args/health logs/credential content.
  return (
    '{"id":{{json .Id}},"image":{{json .Image}},"startedAt":{{json .State.StartedAt}},' +
    '"restarts":{{json .RestartCount}},"running":{{json .State.Running}},' +
    '"owner":{{json (index .Config.Labels "' +
    labelKey +
    '")}},' +
    '"mounts":[{{range $i,$m := .Mounts}}{{if $i}},{{end}}' +
    '{"Type":{{json $m.Type}},"Name":{{json $m.Name}},"Source":{{json $m.Source}},' +
    '"Destination":{{json $m.Destination}},"RW":{{json $m.RW}}}{{end}}],' +
    '"hostPorts":{{json .HostConfig.PortBindings}},"networkPorts":{{json .NetworkSettings.Ports}}}'
  );
}
function ports(value: unknown): unknown[] | null {
  if (value === null) return [];
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const result: unknown[] = [];
  for (const [port, bindings] of Object.entries(value)) {
    if (!/^\d{1,5}\/(?:tcp|udp|sctp)$/.test(port)) return null;
    if (bindings === null) continue;
    if (!Array.isArray(bindings)) return null;
    for (const raw of bindings) {
      const b = exact(raw, ['HostIp', 'HostPort']);
      if (
        !b ||
        !['127.0.0.1', '::1'].includes(b.HostIp as string) ||
        typeof b.HostPort !== 'string' ||
        !/^\d{1,5}$/.test(b.HostPort) ||
        Number(b.HostPort) < 1 ||
        Number(b.HostPort) > 65535
      )
        return null;
      result.push([port, b.HostIp, b.HostPort]);
    }
  }
  return result.sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}
function selectedMounts(value: unknown): unknown[][] | null {
  if (!Array.isArray(value)) return null;
  const result: unknown[][] = [];
  for (const raw of value) {
    const m = exact(raw, ['Type', 'Name', 'Source', 'Destination', 'RW']);
    if (
      !m ||
      !['bind', 'volume', 'tmpfs'].includes(m.Type as string) ||
      !(m.Name === null || typeof m.Name === 'string') ||
      typeof m.Source !== 'string' ||
      typeof m.Destination !== 'string' ||
      !isAbsolute(m.Destination) ||
      typeof m.RW !== 'boolean'
    )
      return null;
    result.push([m.Type, m.Name, m.Source, m.Destination, m.RW]);
  }
  return result.sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}
function fixedSources(
  binding: SelectedNativeInputs,
  policy: A12NativeRuntimePolicy,
): {
  workspace: readonly NativeRootPin[];
  runtime: readonly NativeRootPin[];
} {
  const roots = binding.rootPins;
  if (
    !roots ||
    roots.length < 2 ||
    new Set(roots.map((root) => root.path)).size !== roots.length ||
    roots.some(
      (root) =>
        ![policy.workspaceRoot, ...policy.runtimeRoots].includes(root.path) ||
        root.path !== root.realPath ||
        !isAbsolute(root.realPath) ||
        !Number.isFinite(root.dev) ||
        !Number.isFinite(root.ino),
    )
  )
    throw new NativeRefusal('unknown', 'observation_missing');
  const workspace = roots.filter((root) => root.path === policy.workspaceRoot);
  const runtime = roots.filter((root) =>
    policy.runtimeRoots.includes(root.path),
  );
  if (workspace.length !== 1 || runtime.length === 0)
    throw new NativeRefusal('unknown', 'observation_missing');
  return { workspace, runtime };
}
async function emptyConfig(
  root: NativeRootPin,
  budget: ObservationBudget,
): Promise<void> {
  // Read at most one entry; do not materialize an unbounded directory or read any config body.
  if (!validIdentity(root.identity))
    throw new NativeRefusal('unknown', 'observation_missing');
  const before = await budget.wait(lstat(root.path));
  if (
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    !sameIdentity(identity(before), root.identity)
  )
    throw new NativeRefusal('rejected', 'configuration_changed');
  const directory = await budget.wait(
    opendir(root.path, { bufferSize: 1 }),
    (handle) => handle.close(),
  );
  try {
    if ((await budget.wait(directory.read())) !== null)
      throw new NativeRefusal('unknown', 'observation_missing');
    const after = await budget.wait(lstat(root.path));
    if (after.isSymbolicLink() || !sameIdentity(identity(after), root.identity))
      throw new NativeRefusal('rejected', 'configuration_changed');
  } finally {
    await budget.wait(directory.close()).catch(() => undefined);
  }
}
async function dockerCommand(
  binding: SelectedNativeInputs,
  policy: A12NativeRuntimePolicy,
  tail: readonly string[],
  budget: ObservationBudget,
): Promise<string> {
  const executable = binding.executablePin,
    socket = binding.socketPin,
    config = binding.observerDockerConfigRoot;
  if (
    !executable ||
    !socket ||
    !config ||
    binding.dockerExecutable !== executable.path ||
    !policy.dockerExecutablePaths.includes(executable.path) ||
    !policy.dockerExecutablePaths.includes(executable.realPath) ||
    !policy.daemonSocketPaths.includes(socket.path) ||
    !policy.daemonSocketPaths.includes(socket.realPath) ||
    binding.daemonSocket !== 'unix://' + socket.path ||
    !policy.runtimeRoots.some(
      (root) => config.path === root + '/docker-observer-empty-config',
    ) ||
    !binding.rootPins?.some(
      (root) =>
        policy.runtimeRoots.includes(root.path) &&
        beneath(config.path, root.path) &&
        beneath(config.realPath, root.realPath),
    )
  )
    throw new NativeRefusal('unknown', 'observation_missing');
  await pathIdentity(executable, budget, 'executable');
  await pathIdentity(socket, budget, 'socket');
  await observedRoot(config, budget);
  await emptyConfig(config, budget);
  const stdout = await boundedExec(
    executable.path,
    ['--config', config.path, '--host', binding.daemonSocket, ...tail],
    budget,
    { PATH: '/usr/bin:/bin', DOCKER_CONFIG: config.path },
  );
  await pathIdentity(executable, budget, 'executable');
  await pathIdentity(socket, budget, 'socket');
  await observedRoot(config, budget);
  await emptyConfig(config, budget);
  return stdout;
}
async function readNativeOwnedBinding(
  binding: SelectedNativeInputs,
  policy: A12NativeRuntimePolicy,
  parentSignal: AbortSignal,
): Promise<Observation> {
  let budget: ObservationBudget | undefined;
  try {
    budget = new ObservationBudget(parentSignal);
    const roots = fixedSources(binding, policy);
    budget.claimServices(binding.services.length);
    budget.claimFiles(
      binding.sourceBuildFiles.length +
        binding.configurationFiles.length +
        2 +
        binding.signatureFiles.length,
    );
    if (
      binding.services.length < 3 ||
      new Set(binding.services.map((s) => s.service)).size !==
        binding.services.length ||
      new Set(binding.services.map((s) => s.containerId)).size !==
        binding.services.length ||
      !['api', 'data-worker', 'clamav'].every((name) =>
        binding.services.some((s) => s.service === name),
      ) ||
      !binding.services.some(
        (s) =>
          s.service === 'clamav' &&
          s.containerId === binding.signatureContainerId,
      ) ||
      binding.signatureFiles.length === 0 ||
      binding.signatureFiles.length > 8 ||
      new Set(binding.signatureFiles.map((p) => p.path)).size !==
        binding.signatureFiles.length
    )
      throw new NativeRefusal('unknown', 'observation_missing');
    // Preflight every plan field before touching transport or filesystem.
    for (const service of binding.services) {
      if (
        !/^[a-z][a-z0-9-]{0,63}$/.test(service.service) ||
        !/^[a-f0-9]{64}$/.test(service.containerId) ||
        !/^sha256:[a-f0-9]{64}$/.test(service.imageId) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(
          service.startedAt,
        ) ||
        !Number.isSafeInteger(service.restartGeneration) ||
        service.restartGeneration < 0 ||
        !['com.docker.compose.project', 'com.supabase.cli.project'].includes(
          service.ownerLabelKey,
        ) ||
        typeof service.ownerLabelValue !== 'string' ||
        service.ownerLabelValue.length < 1 ||
        !/^[a-f0-9]{64}$/.test(service.mountsSha256) ||
        !/^[a-f0-9]{64}$/.test(service.portsSha256)
      )
        throw new NativeRefusal('unknown', 'observation_missing');
    }
    for (const pin of binding.signatureFiles) {
      if (
        !/^\/var\/lib\/clamav\/[a-z0-9_-]+\.(cvd|cld)$/.test(pin.path) ||
        !/^[a-f0-9]{64}$/.test(pin.sha256) ||
        !Number.isSafeInteger(pin.sizeBytes) ||
        (pin.sizeBytes ?? -1) < 0
      )
        throw new NativeRefusal('unknown', 'observation_missing');
      // This accounts for launch-observed signature inventory bytes. It is not a proof of bytes loaded
      // by clamd or a hard I/O quota inside the daemon; the single deadline still bounds each hash command.
      budget.consumeBytes(pin.sizeBytes);
    }
    const sourceBuildSha256 = await pinnedFiles(
      binding.sourceBuildFiles,
      'build_changed',
      roots.workspace,
      budget,
    );
    const configurationSha256 = await pinnedFiles(
      binding.configurationFiles,
      'configuration_changed',
      [...roots.workspace, ...roots.runtime],
      budget,
    );
    const migrationSha256 = await pinnedFiles(
      [binding.appliedMigrationReceipt],
      'migration_changed',
      roots.runtime,
      budget,
    );
    const signatureSourceSha256 = await pinnedFiles(
      [binding.signatureSourceReceipt],
      'signature_changed',
      roots.runtime,
      budget,
    );
    const generations: Generation[] = [],
      mounts: string[] = [],
      ownedPorts: string[] = [];
    for (const service of binding.services) {
      const bytes = await dockerCommand(
        binding,
        policy,
        [
          'inspect',
          '--type',
          'container',
          '--format',
          inspectTemplate(service.ownerLabelKey),
          service.containerId,
        ],
        budget,
      );
      const raw = exact(JSON.parse(bytes) as unknown, [
        'id',
        'image',
        'startedAt',
        'restarts',
        'running',
        'owner',
        'mounts',
        'hostPorts',
        'networkPorts',
      ]);
      if (!raw) throw new NativeRefusal('unknown', 'invalid_observation');
      if (
        raw.id !== service.containerId ||
        raw.startedAt !== service.startedAt ||
        raw.restarts !== service.restartGeneration
      )
        throw new NativeRefusal('rejected', 'generation_changed');
      if (raw.running !== true)
        throw new NativeRefusal('unknown', 'observation_unavailable');
      if (raw.image !== service.imageId)
        throw new NativeRefusal('rejected', 'build_changed');
      if (raw.owner !== service.ownerLabelValue)
        throw new NativeRefusal('rejected', 'ownership_changed');
      const selected = selectedMounts(raw.mounts);
      if (!selected) throw new NativeRefusal('unknown', 'invalid_observation');
      const mountHash = sha(JSON.stringify(selected));
      if (mountHash !== service.mountsSha256)
        throw new NativeRefusal('rejected', 'mount_changed');
      const host = ports(raw.hostPorts),
        network = ports(raw.networkPorts);
      if (!host || !network)
        throw new NativeRefusal('rejected', 'loopback_changed');
      const portHash = sha(JSON.stringify([host, network]));
      if (portHash !== service.portsSha256)
        throw new NativeRefusal('rejected', 'loopback_changed');
      generations.push({
        service: service.service,
        actualId: service.containerId,
        startedAt: service.startedAt,
        restartGeneration: service.restartGeneration,
        immutableImageId: service.imageId,
      });
      mounts.push(mountHash);
      ownedPorts.push(
        sha(JSON.stringify([service.containerId, raw.owner, portHash])),
      );
    }
    const signatureHashes: string[] = [];
    for (const pin of binding.signatureFiles) {
      const line = await dockerCommand(
        binding,
        policy,
        ['exec', binding.signatureContainerId, 'sha256sum', '--', pin.path],
        budget,
      );
      if (line.trim() !== pin.sha256 + '  ' + pin.path)
        throw new NativeRefusal('rejected', 'signature_changed');
      signatureHashes.push(pin.sha256);
    }
    // Readiness is only the existing health command. No VERSION/PING interface, freshclam or download.
    await dockerCommand(
      binding,
      policy,
      ['exec', binding.signatureContainerId, 'clamdcheck.sh'],
      budget,
    );
    budget.check();
    return Object.freeze({
      status: 'observed',
      binding: Object.freeze({
        generations: Object.freeze(generations),
        sourceBuildSha256,
        configurationSha256,
        mountsSha256: sha(JSON.stringify(mounts)),
        migrationSha256,
        signatureSourceSha256,
        signatureBytesSha256: sha(JSON.stringify(signatureHashes)),
        signatureReadinessSha256: sha(
          JSON.stringify([binding.signatureContainerId, 'clamdcheck.sh', 0]),
        ),
        ownershipLoopbackSha256: sha(JSON.stringify(ownedPorts)),
      }),
    });
  } catch (error) {
    if (error instanceof NativeRefusal)
      return { status: error.status, reason: error.reason };
    return { status: 'unknown', reason: 'observation_unavailable' };
  } finally {
    budget?.dispose();
  }
}

/** Creates a reader from immutable selected inputs. Ordinary pins/factory output do not prove a launch. */
export function createA12NativeRuntimeObserver(
  selectors: A12NativeRuntimeSelectors,
  policy: A12NativeRuntimePolicy,
): (signal: AbortSignal) => Promise<A12NativeRuntimeObservation> {
  const selected = snapshotNativeSelectors(selectors);
  const selectedPolicy = snapshotNativePolicy(policy);
  if (!selected || !selectedPolicy)
    return () =>
      Promise.resolve({ status: 'unknown', reason: 'observation_missing' });
  return (signal) => readNativeOwnedBinding(selected, selectedPolicy, signal);
}
