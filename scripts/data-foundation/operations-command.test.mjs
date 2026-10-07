import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import * as vm from 'node:vm';

const FLAG = '--experimental-vm-modules';
const SECRET = 'synthetic-private-command-diagnostic';
const roles = [
  'wiser_data_api|false|false|true',
  'wiser_data_gis|false|false|true',
  'wiser_data_runtime|false|false|false',
  'wiser_data_worker|false|false|true',
].join('\n');
const plain = (value) => JSON.parse(JSON.stringify(value));

if (!process.execArgv.includes(FLAG)) {
  test('command settlement regressions with real default adapters', () => {
    const result = spawnSync(
      process.execPath,
      [FLAG, '--test', fileURLToPath(import.meta.url)],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
} else {
  async function harness(t, mode = 'normal', environment = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'wiser-command-boundary-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await mkdir(join(directory, 'supabase'));
    await writeFile(
      join(directory, 'supabase/config.toml'),
      'project_id = "wiser"\n[api]\nport = 56321\n[db]\nport = 56322\n',
    );
    const calls = [];
    const childProcess = {
      spawn(command, args, options) {
        assert.equal(command, 'docker');
        assert.equal(options.shell, false);
        const stage =
          args[0] === 'context'
            ? 'docker-endpoint'
            : args.includes('config')
              ? 'compose-config'
              : 'postgres-exec';
        if (mode === `start-throw-${stage}`) throw new Error(SECRET);
        const child = new EventEmitter();
        child.stdout = options.stdio[1] === 'pipe' ? new EventEmitter() : null;
        if (child.stdout) child.stdout.setEncoding = () => undefined;
        child.stdin = new EventEmitter();
        const call = { command, args, stage, options, child, input: undefined };
        calls.push(call);
        child.stdin.end = (input) => {
          call.input = input;
          if (mode === 'manual') return;
          const output =
            stage === 'docker-endpoint'
              ? JSON.stringify('unix:///tmp/wiser-command-fixture.sock')
              : stage === 'compose-config'
                ? JSON.stringify({ name: 'wiser' })
                : input.includes('pg_catalog.pg_roles')
                  ? roles
                  : input.includes('11111111-1111-4111-8111-111111111111')
                    ? '0'
                    : '1';
          const late = mode === `late-${stage}`;
          queueMicrotask(() => {
            if (mode === `start-error-${stage}`) {
              child.emit('error', new Error(SECRET));
              child.emit('close', -1, null);
              return;
            }
            if (mode === `stdin-error-${stage}`) {
              try {
                child.stdin.emit('error', new Error(SECRET));
              } catch {
                // Simulate the process closing even when old code has no pipe-error handler.
              }
              child.emit('exit', 1, null);
              child.emit('close', 1, null);
              return;
            }
            if (mode === `stdout-error-${stage}`) {
              try {
                child.stdout.emit('error', new Error(SECRET));
              } catch {
                // Old code lacks a stdout error observer; the synthetic process still closes.
              }
              child.emit('exit', 1, null);
              child.emit('close', 1, null);
              return;
            }
            const failed = mode === `nonzero-${stage}`;
            if (!late) child.stdout?.emit('data', output);
            child.emit('exit', failed ? 1 : 0, null);
            if (late) {
              setImmediate(() => {
                child.stdout?.emit('data', output);
                child.stdout?.emit('end');
                child.emit('close', 0, null);
              });
            } else child.emit('close', failed ? 1 : 0, null);
          });
        };
        return child;
      },
    };
    const context = vm.createContext({
      Error,
      Buffer,
      URL,
      process: { env: Object.freeze({ ...environment }), argv: [] },
    });
    const sources = new Map();
    const native = new Map();
    async function load(file) {
      if (sources.has(file)) return sources.get(file);
      const module = new vm.SourceTextModule(await readFile(file, 'utf8'), {
        context,
        identifier: pathToFileURL(file).href,
        initializeImportMeta(meta) {
          meta.url = pathToFileURL(
            join(directory, 'scripts/data-foundation/operations.mjs'),
          ).href;
        },
      });
      sources.set(file, module);
      await module.link(async (specifier, importer) => {
        if (!specifier.startsWith('node:'))
          return load(
            resolve(dirname(fileURLToPath(importer.identifier)), specifier),
          );
        if (native.has(specifier)) return native.get(specifier);
        const namespace =
          specifier === 'node:child_process'
            ? childProcess
            : await import(specifier);
        const dependency = new vm.SyntheticModule(
          Object.keys(namespace),
          function () {
            for (const key of Object.keys(namespace))
              this.setExport(key, namespace[key]);
          },
          { context, identifier: specifier },
        );
        native.set(specifier, dependency);
        return dependency;
      });
      return module;
    }
    const source = await load(
      fileURLToPath(new URL('./operations.mjs', import.meta.url)),
    );
    await source.evaluate();
    return { operations: source.namespace, calls, directory };
  }

  test('captured command waits for close and includes data arriving after exit', async (t) => {
    const h = await harness(t, 'manual');
    let settled = false;
    const running = h.operations.runCommand('docker', ['context', 'inspect']);
    running.then(() => {
      settled = true;
    });
    const { child } = h.calls[0];
    child.emit('exit', 0, null);
    await new Promise(setImmediate);
    assert.equal(
      settled,
      false,
      'exit must not settle captured stdout before close',
    );
    child.stdout.emit('data', 'complete');
    child.stdout.emit('end');
    child.emit('close', 0, null);
    assert.equal(await running, 'complete');
  });

  for (const stage of ['docker-endpoint', 'compose-config', 'postgres-exec']) {
    test(`real default runtime-role bridge keeps complete late output from ${stage}`, async (t) => {
      const h = await harness(t, `late-${stage}`);
      assert.deepEqual(plain(await h.operations.assertRuntimeRoles()), {
        api: true,
        worker: true,
        rls: true,
      });
      assert.equal(
        h.calls.filter((call) => call.stage === 'postgres-exec').length,
        3,
      );
      for (const call of h.calls.filter(
        (entry) => entry.stage !== 'docker-endpoint',
      )) {
        assert.equal(
          call.options.env.DOCKER_HOST,
          'unix:///tmp/wiser-command-fixture.sock',
        );
        assert.equal(call.options.env.DOCKER_CONTEXT, undefined);
      }
    });
  }

  test('capture false keeps inherited stdout and resolves only on close', async (t) => {
    const h = await harness(t, 'manual');
    let settled = false;
    const running = h.operations.runCommand('docker', ['context', 'inspect'], {
      capture: false,
    });
    running.then(() => {
      settled = true;
    });
    const { child, options } = h.calls[0];
    assert.equal(options.stdio[1], 'inherit');
    assert.equal(child.stdout, null);
    child.emit('exit', 0, null);
    await new Promise(setImmediate);
    assert.equal(settled, false);
    child.emit('close', 0, null);
    assert.equal(await running, '');
  });

  for (const [mode, stage, reason] of [
    ['start-error-docker-endpoint', 'docker-endpoint', 'PROCESS_START_FAILED'],
    ['start-throw-docker-endpoint', 'docker-endpoint', 'PROCESS_START_FAILED'],
    ['nonzero-compose-config', 'compose-config', 'PROCESS_EXIT_FAILED'],
    ['nonzero-postgres-exec', 'postgres-exec', 'PROCESS_EXIT_FAILED'],
    ['stdin-error-postgres-exec', 'postgres-exec', 'PROCESS_INPUT_FAILED'],
    ['stdout-error-compose-config', 'compose-config', 'PROCESS_OUTPUT_FAILED'],
  ]) {
    test(`owned ${mode} reports only fixed execution fields`, async (t) => {
      const h = await harness(t, mode);
      await assert.rejects(h.operations.assertRuntimeRoles(), (error) => {
        assert.ok(!inspect(error).includes(SECRET));
        const diagnostic = h.operations.runtimeRoleFailureDiagnostics(error);
        assert.deepEqual(plain(diagnostic), {
          stage: 'role-flags',
          reasonCode: 'ROLE_CHECK_EXECUTION_FAILED',
          executionStage: stage,
          executionReason: reason,
        });
        assert.ok(Object.isFrozen(diagnostic));
        return true;
      });
    });
  }

  test('strict endpoint refusal is a bounded control diagnosis and does not run SQL', async (t) => {
    const h = await harness(t, 'normal', {
      DOCKER_HOST: 'tcp://remote.invalid:2375',
    });
    await assert.rejects(h.operations.assertRuntimeRoles(), (error) => {
      assert.deepEqual(
        plain(h.operations.runtimeRoleFailureDiagnostics(error)),
        {
          stage: 'role-flags',
          reasonCode: 'ROLE_CHECK_EXECUTION_FAILED',
          executionStage: 'docker-endpoint',
          executionReason: 'CONTROL_CHECK_FAILED',
        },
      );
      return true;
    });
    assert.equal(h.calls.length, 0);
  });

  test('caller exceptions and forged getters cannot create an execution diagnosis', async (t) => {
    const h = await harness(t);
    const fake = Object.assign(new Error(SECRET), {
      executionStage: 'postgres-exec',
      executionReason: 'PROCESS_EXIT_FAILED',
    });
    Object.defineProperty(fake, 'cause', {
      get() {
        throw new Error(SECRET);
      },
    });
    await assert.rejects(
      h.operations.assertRuntimeRoles({
        runPostgresSql: async () => {
          throw fake;
        },
      }),
      (error) => {
        assert.ok(!inspect(error).includes(SECRET));
        assert.deepEqual(
          plain(h.operations.runtimeRoleFailureDiagnostics(error)),
          {
            stage: 'role-flags',
            reasonCode: 'ROLE_CHECK_EXECUTION_FAILED',
          },
        );
        return true;
      },
    );
    assert.equal(h.operations.runtimeRoleFailureDiagnostics(fake), undefined);
  });
}
