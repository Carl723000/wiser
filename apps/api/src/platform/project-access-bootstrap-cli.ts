import { runProjectAccessBootstrap } from './project-access-bootstrap-runtime.js';

const [file, mode] = process.argv.slice(2);
if (!file || (mode !== '--dry-run' && mode !== '--apply')) {
  process.stderr.write(
    'Usage: tsx project-access-bootstrap-cli.ts <private-config.json> --dry-run|--apply\n',
  );
  process.exitCode = 2;
} else {
  try {
    const result = await runProjectAccessBootstrap(file, mode === '--apply');
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(
      `Access bootstrap failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    process.exitCode = 1;
  }
}
