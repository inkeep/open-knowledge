import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { APP_PACKAGE_ROOT } from './seed-key.ts';

export const PRODUCTION_SHELL_ENV = 'OK_TEST_PRODUCTION_SHELL';

const CLI_ENTRY = join(APP_PACKAGE_ROOT, '../cli/dist/cli.mjs');

export interface ProductionShellLaunch {
  mode: 'production';
  command: string;
  args: readonly string[];
}

export function productionShellLaunch(host: string, port: number): ProductionShellLaunch {
  return {
    mode: 'production',
    command: process.execPath,
    args: [
      CLI_ENTRY,
      'start',
      '--port',
      String(port),
      '--bind',
      host,
      '--no-open-browser',
      '--mode',
      'browser',
      '--react-shell-dist-dir',
      join(APP_PACKAGE_ROOT, 'dist'),
      '--idle-shutdown',
      'off',
    ],
  };
}

export function initProductionShellContent(contentDir: string): void {
  const initialized = spawnSync(
    process.execPath,
    [CLI_ENTRY, 'init', '--no-mcp', '--no-skills', '--content-dir', '.', '--json'],
    { cwd: contentDir, encoding: 'utf8' },
  );
  if (initialized.status !== 0) {
    throw new Error(`production-shell ok init failed: ${initialized.stderr}`);
  }
}
