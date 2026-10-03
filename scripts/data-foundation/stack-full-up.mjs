import {
  isDirectExecution,
  ROOT_DIRECTORY,
  runCommand,
  runCompose,
} from './operations.mjs';
import { startDataFoundation } from './up.mjs';
import {
  assertLocalComposeTarget,
  assertLocalProject,
  localSupabaseArguments,
  readLocalSupabaseTarget,
} from './local-control-target.mjs';

export async function startFullWiserStack(
  environment = process.env,
  dependencies = {},
) {
  const execute = dependencies.runCommand ?? runCommand;
  const startData = dependencies.startDataFoundation ?? startDataFoundation;
  const compose = dependencies.runCompose ?? runCompose;
  const target = await (dependencies.readTarget ?? readLocalSupabaseTarget)(
    environment,
    ROOT_DIRECTORY,
  );
  assertLocalProject(target, environment);
  const configuration = await compose(['config', '--format', 'json'], {
    environment,
  });
  assertLocalComposeTarget(configuration, target, environment);
  await execute('pnpm', localSupabaseArguments(target, 'start'), {
    capture: true,
    environment,
  });
  const started = await startData(environment);
  const runtimeEnvironment = started.environment;
  await execute('node', ['scripts/data-foundation/migrate.mjs'], {
    capture: false,
    environment: runtimeEnvironment,
  });
  await execute('node', ['scripts/data-foundation/seed.mjs'], {
    capture: false,
    environment: runtimeEnvironment,
  });
  await execute('node', ['scripts/data-foundation/smoke.mjs'], {
    capture: false,
    environment: runtimeEnvironment,
  });
}

if (isDirectExecution(import.meta.url)) {
  await startFullWiserStack();
}
