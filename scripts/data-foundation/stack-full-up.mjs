import { isDirectExecution, runCommand } from './operations.mjs';
import { startDataFoundation } from './up.mjs';

export async function startFullWiserStack(
  environment = process.env,
  dependencies = {},
) {
  const execute = dependencies.runCommand ?? runCommand;
  const startData = dependencies.startDataFoundation ?? startDataFoundation;
  await execute('pnpm', ['supabase:start'], { capture: false });
  await startData();
  await execute('node', ['scripts/data-foundation/migrate.mjs'], {
    capture: false,
  });
  await execute('node', ['scripts/data-foundation/seed.mjs'], {
    capture: false,
  });
  await execute('node', ['scripts/data-foundation/smoke.mjs'], {
    capture: false,
  });
}

if (isDirectExecution(import.meta.url)) {
  await startFullWiserStack();
}
