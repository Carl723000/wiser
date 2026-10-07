import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CandidateWordStructureSchema } from '@wiser/data-contracts/candidate-conversion';
import { compareCandidateConversionStructure } from '@wiser/data-core/candidate-conversion';
import {
  candidateStructureFailure,
  type CandidateConversionRunner,
} from '../handlers/candidate-conversion.js';

export interface CandidateConversionHostConfig {
  readonly converter: {
    readonly executablePath: string;
    readonly sha256: string;
    readonly version: string;
    readonly platform: NodeJS.Platform;
  };
  readonly structure: {
    readonly pythonPath: string;
    readonly scriptPath: string;
    readonly scriptSha256: string;
    readonly pythonImportPath?: string;
  };
  readonly maximumMilliseconds?: number;
  readonly authorityIntervalMilliseconds?: number;
  readonly temporaryRoot?: string;
}

type Reason =
  | 'TOOL_UNAVAILABLE'
  | 'CONVERSION_FAILED'
  | 'INVALID_STRUCTURE'
  | 'BUDGET_EXCEEDED';
const failure = (reason: Reason) => ({ kind: 'UNVERIFIABLE' as const, reason });
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const maximumInputBytes = 64 * 1024 * 1024;
const maximumStructureBytes = 16 * 1024 * 1024;
const unavailableCodes = new Set(['ENOENT', 'EACCES', 'ENOEXEC', 'ENOTDIR']);
function unavailable(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    unavailableCodes.has(error.code)
  );
}
function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error('Invalid trusted conversion host budget');
  return value;
}
function pinnedPath(path: string, sha: string): void {
  if (!isAbsolute(path) || !/^[a-f0-9]{64}$/.test(sha))
    throw new Error('Conversion host requires absolute paths and exact hashes');
}
async function pinnedFile(path: string, sha: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 256 * 1024 * 1024) return false;
    return digest(await readFile(path)) === sha;
  } catch (error) {
    if (unavailable(error)) return false;
    throw error;
  }
}

type ProcessResult =
  | {
      readonly kind: 'EXIT';
      readonly code: number | null;
      readonly stdout: Buffer;
    }
  | ReturnType<typeof failure>;

/** No shell or inherited host environment; kill the private process group on abort. */
async function runProcess(input: {
  executable: string;
  args: readonly string[];
  cwd: string;
  environment: Record<string, string>;
  milliseconds: number;
  interval: number;
  maximumOutputBytes: number;
  checkAuthority: () => Promise<void>;
}): Promise<ProcessResult> {
  await input.checkAuthority();
  const child = spawn(input.executable, [...input.args], {
    cwd: input.cwd,
    env: input.environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let ordinary: ReturnType<typeof failure> | undefined;
  let authorityError: unknown;
  let hasAuthorityError = false;
  let processError: unknown;
  let hasProcessError = false;
  let ended = false;
  let outputBytes = 0;
  const chunks: Buffer[] = [];
  let pending: Promise<void> | undefined;
  const terminate = () => {
    if (ended) return;
    try {
      if (child.pid !== undefined && process.platform !== 'win32')
        process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch (error) {
      if (!(
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ESRCH'
      )) {
        processError = error;
        hasProcessError = true;
      }
    }
  };
  const collect = (chunk: Buffer, keep: boolean) => {
    outputBytes += chunk.byteLength;
    if (outputBytes > input.maximumOutputBytes) {
      ordinary = failure('BUDGET_EXCEEDED');
      terminate();
    } else if (keep) chunks.push(chunk);
  };
  child.stdout.on('data', (chunk: Buffer) => collect(chunk, true));
  child.stderr.on('data', (chunk: Buffer) => collect(chunk, false));
  const timer = setTimeout(() => {
    ordinary = failure('BUDGET_EXCEEDED');
    terminate();
  }, input.milliseconds);
  const interval = setInterval(() => {
    if (ended || pending) return;
    pending = Promise.resolve()
      .then(input.checkAuthority)
      .catch((error: unknown) => {
        authorityError = error;
        hasAuthorityError = true;
        terminate();
      })
      .finally(() => {
        pending = undefined;
      });
  }, input.interval);
  const code = await new Promise<number | null>((resolve) => {
    child.once('error', (error: unknown) => {
      if (unavailable(error)) ordinary = failure('TOOL_UNAVAILABLE');
      else {
        processError = error;
        hasProcessError = true;
      }
    });
    child.once('close', (exitCode) => {
      ended = true;
      resolve(exitCode);
    });
  });
  clearTimeout(timer);
  clearInterval(interval);
  await pending;
  if (hasAuthorityError) throw authorityError;
  if (hasProcessError) throw processError;
  await input.checkAuthority();
  return ordinary ?? { kind: 'EXIT', code, stdout: Buffer.concat(chunks) };
}

/** Explicit host pins are admission prerequisites, not source/provenance certification. */
export function createCandidateConversionHostRunner(
  supplied: CandidateConversionHostConfig,
): CandidateConversionRunner {
  // Snapshot config: requests cannot mutate trusted identity or budgets mid-flight.
  const config = {
    ...supplied,
    converter: { ...supplied.converter },
    structure: { ...supplied.structure },
  };
  pinnedPath(config.converter.executablePath, config.converter.sha256);
  pinnedPath(config.structure.scriptPath, config.structure.scriptSha256);
  if (
    !isAbsolute(config.structure.pythonPath) ||
    (config.structure.pythonImportPath !== undefined &&
      !isAbsolute(config.structure.pythonImportPath)) ||
    (config.temporaryRoot !== undefined && !isAbsolute(config.temporaryRoot)) ||
    config.converter.version.length > 128 ||
    !/^LibreOffice [0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(?: [a-f0-9]{7,64})?$/.test(
      config.converter.version,
    ) ||
    config.converter.platform !== process.platform
  )
    throw new Error('Invalid trusted conversion host identity');
  const milliseconds = boundedInteger(
    config.maximumMilliseconds ?? 30_000,
    50,
    120_000,
  );
  const interval = boundedInteger(
    config.authorityIntervalMilliseconds ?? 1000,
    10,
    5000,
  );
  const temporary = config.temporaryRoot ?? tmpdir();
  const environment = (folder: string): Record<string, string> => ({
    HOME: folder,
    TMPDIR: folder,
    TEMP: folder,
    TMP: folder,
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    ...(config.structure.pythonImportPath === undefined
      ? {}
      : { PYTHONPATH: config.structure.pythonImportPath }),
  });
  const processInput = (
    folder: string,
    checkAuthority: () => Promise<void>,
  ) => ({
    cwd: folder,
    environment: environment(folder),
    milliseconds,
    interval,
    checkAuthority,
  });
  const bytesInBudget = (bytes: Uint8Array, maximum: number) =>
    bytes.byteLength > 0 &&
    bytes.byteLength <= boundedInteger(maximum, 1, maximumInputBytes);
  return {
    async reconvert(input) {
      await input.checkAuthority();
      if (!bytesInBudget(input.originalBytes, input.maximumBytes))
        return failure('BUDGET_EXCEEDED');
      if (
        !(await pinnedFile(
          config.converter.executablePath,
          config.converter.sha256,
        ))
      )
        return failure('TOOL_UNAVAILABLE');
      const folder = await mkdtemp(join(temporary, 'wiser-word-conversion-'));
      try {
        const version = await runProcess({
          ...processInput(folder, input.checkAuthority),
          executable: config.converter.executablePath,
          args: ['--version'],
          maximumOutputBytes: 4096,
        });
        if (version.kind === 'UNVERIFIABLE') return version;
        if (
          version.code !== 0 ||
          version.stdout.toString('utf8').trim() !== config.converter.version
        )
          return failure('TOOL_UNAVAILABLE');
        const source = join(folder, 'source.doc');
        await writeFile(source, input.originalBytes, { mode: 0o600 });
        const profile = pathToFileURL(join(folder, 'profile')).href;
        const conversion = await runProcess({
          ...processInput(folder, input.checkAuthority),
          executable: config.converter.executablePath,
          args: [
            '-env:UserInstallation=' + profile,
            '--headless',
            '--nologo',
            '--nodefault',
            '--nofirststartwizard',
            '--norestore',
            '--convert-to',
            'docx:Office Open XML Text',
            '--outdir',
            folder,
            source,
          ],
          maximumOutputBytes: 64 * 1024,
        });
        if (conversion.kind === 'UNVERIFIABLE') return conversion;
        if (conversion.code !== 0) return failure('CONVERSION_FAILED');
        await input.checkAuthority();
        // Recheck actual executable identity after the run, before admitting its output.
        if (
          !(await pinnedFile(
            config.converter.executablePath,
            config.converter.sha256,
          ))
        )
          return failure('TOOL_UNAVAILABLE');
        const output = join(folder, 'source.docx');
        let info;
        try {
          info = await lstat(output);
        } catch (error) {
          if (unavailable(error)) return failure('CONVERSION_FAILED');
          throw error;
        }
        if (!info.isFile() || info.size === 0)
          return failure('CONVERSION_FAILED');
        if (info.size > input.maximumBytes) return failure('BUDGET_EXCEEDED');
        const bytes = await readFile(output);
        if (!bytesInBudget(bytes, input.maximumBytes))
          return failure('BUDGET_EXCEEDED');
        await input.checkAuthority();
        return {
          kind: 'CONVERTED',
          bytes: Uint8Array.from(bytes),
          tool: {
            name: 'LibreOffice',
            version: version.stdout.toString('utf8').trim(),
            digest: config.converter.sha256,
          },
        };
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
    async extractStructure(input) {
      await input.checkAuthority();
      if (!bytesInBudget(input.bytes, input.maximumBytes))
        return failure('BUDGET_EXCEEDED');
      if (
        !(await pinnedFile(
          config.structure.scriptPath,
          config.structure.scriptSha256,
        ))
      )
        return failure('TOOL_UNAVAILABLE');
      const folder = await mkdtemp(join(temporary, 'wiser-word-structure-'));
      try {
        const source = join(folder, 'source.docx');
        await writeFile(source, input.bytes, { mode: 0o600 });
        const extracted = await runProcess({
          ...processInput(folder, input.checkAuthority),
          executable: config.structure.pythonPath,
          args: [
            config.structure.scriptPath,
            source,
            String(input.maximumBytes),
          ],
          maximumOutputBytes: maximumStructureBytes + 128,
        });
        if (extracted.kind === 'UNVERIFIABLE') return extracted;
        if (extracted.code !== 0) return failure('INVALID_STRUCTURE');
        if (
          !(await pinnedFile(
            config.structure.scriptPath,
            config.structure.scriptSha256,
          ))
        )
          return failure('TOOL_UNAVAILABLE');
        let response: unknown;
        try {
          response = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(extracted.stdout),
          );
        } catch {
          return failure('INVALID_STRUCTURE');
        }
        if (
          response === null ||
          typeof response !== 'object' ||
          Array.isArray(response)
        )
          return failure('INVALID_STRUCTURE');
        const value = response as Record<string, unknown>;
        if (value['kind'] === 'UNVERIFIABLE') {
          try {
            const reason = candidateStructureFailure(value);
            return reason ? failure(reason) : failure('INVALID_STRUCTURE');
          } catch {
            return failure('INVALID_STRUCTURE');
          }
        }
        if (
          value['kind'] !== 'STRUCTURE' ||
          Object.keys(value).length !== 2 ||
          !Object.hasOwn(value, 'structure')
        )
          return failure('INVALID_STRUCTURE');
        // Core's bounded precheck runs before recursive schema validation.
        if (
          compareCandidateConversionStructure(
            value['structure'],
            value['structure'],
          ).kind === 'UNVERIFIABLE'
        )
          return failure('INVALID_STRUCTURE');
        await input.checkAuthority();
        return CandidateWordStructureSchema.parse(value['structure']);
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
  };
}
