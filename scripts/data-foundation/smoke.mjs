import {
  DATA_ALL_SERVICES,
  apiContractCheck,
  assertMigrationsApplied,
  assertPgStacMigrated,
  assertRuntimeRoles,
  runtimeRoleFailureDiagnostics,
  assertSeedFixture,
  composeHealthCheck,
  isDirectExecution,
  runCompose,
  verifyFixtureBundle,
} from './operations.mjs';
import {
  VerticalSmokeError,
  runDataFoundationVerticalSmoke,
} from './vertical-smoke.mjs';

const FAILURE_LOG_SERVICES = Object.freeze([
  ...new Set([...DATA_ALL_SERVICES, 'api', 'web']),
]);

const PREFLIGHT_PHASES = Object.freeze({
  fixture: 'fixture-bundle',
  migrations: 'authority-migrations',
  pgstac: 'pgstac-schema',
  roles: 'runtime-roles',
  services: 'compose-health',
  api: 'api-contract',
  seed: 'seed-fixture',
});
const SAFE_ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
]);

function safeErrorName(error) {
  try {
    const name = error instanceof Error ? error.name : 'unknown';
    return SAFE_ERROR_NAMES.has(name) ? name : 'unknown';
  } catch {
    return 'unknown';
  }
}

class PreflightSmokeError extends Error {
  constructor(phase, error) {
    super('Data Foundation preflight failed safely.', {
      cause: Object.freeze({
        phase,
        errorName: safeErrorName(error),
        ...(phase === PREFLIGHT_PHASES.roles
          ? runtimeRoleFailureDiagnostics(error)
          : undefined),
      }),
    });
  }
}

async function preflight(phase, check) {
  try {
    return await check();
  } catch (error) {
    throw new PreflightSmokeError(phase, error);
  }
}

export async function printDataFoundationSmokeFailureLogs() {
  try {
    await runCompose(
      ['logs', '--no-color', '--tail', '200', ...FAILURE_LOG_SERVICES],
      { capture: false },
    );
  } catch {
    process.stderr.write(
      'Data Foundation smoke logs could not be collected safely.\n',
    );
  }
}

export async function smokeDataFoundation(options = {}) {
  try {
    const fixture = await preflight(
      PREFLIGHT_PHASES.fixture,
      verifyFixtureBundle,
    );
    const [migrations, , roles, services, api, seed] = await Promise.all([
      preflight(PREFLIGHT_PHASES.migrations, assertMigrationsApplied),
      preflight(PREFLIGHT_PHASES.pgstac, assertPgStacMigrated),
      preflight(PREFLIGHT_PHASES.roles, assertRuntimeRoles),
      preflight(PREFLIGHT_PHASES.services, composeHealthCheck),
      preflight(PREFLIGHT_PHASES.api, apiContractCheck),
      preflight(PREFLIGHT_PHASES.seed, () => assertSeedFixture(fixture)),
    ]);
    const vertical = await runDataFoundationVerticalSmoke(
      options.vertical ?? {},
    );
    const report = {
      status: 'ok',
      migrationCount: migrations.length,
      healthyServiceCount: services.length,
      capabilityCount: api.capabilityCount,
      roles,
      fixture,
      seed,
      vertical,
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report;
  } catch (error) {
    const printFailureLogs =
      options.printFailureLogs ?? printDataFoundationSmokeFailureLogs;
    try {
      await printFailureLogs();
    } catch {
      try {
        process.stderr.write(
          'Data Foundation smoke logs could not be collected safely.\n',
        );
      } catch {
        // A failed diagnostic sink must not replace the original smoke cause.
      }
    }
    if (error instanceof VerticalSmokeError) throw error;
    const sanitized = new Error('Data Foundation smoke failed safely.', {
      cause:
        error instanceof PreflightSmokeError
          ? error.cause
          : safeErrorName(error),
    });
    throw sanitized;
  }
}

if (isDirectExecution(import.meta.url)) {
  await smokeDataFoundation();
}
