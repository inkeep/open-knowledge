/* biome-ignore-all lint/suspicious/noUndeclaredEnvVars: GitHub Actions supplies the packaging context. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function packagingInvocation({ cwd, args, variant }) {
  const launcher = join(cwd, 'scripts', 'run-electron-builder.mjs');
  if (existsSync(launcher)) return [launcher, ...args];
  if (variant !== 'stable')
    throw new Error(
      'This source predates product variants; only its original Stable identity can be packaged',
    );
  const legacyArgs = args.includes('--linux')
    ? [...args, '--config', 'electron-builder.linux.yml']
    : args;
  return [join(cwd, 'node_modules', 'electron-builder', 'cli.js'), ...legacyArgs];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.npm_config_user_agent?.startsWith('pnpm/')) {
    throw new Error(
      'Run desktop packaging through pnpm exec node so dependency collection uses pnpm',
    );
  }
  const result = spawnSync(
    process.execPath,
    packagingInvocation({
      cwd: resolve(process.cwd()),
      args: process.argv.slice(2),
      variant: process.env.OK_DESKTOP_VARIANT,
    }),
    { stdio: 'inherit', env: process.env },
  );
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Desktop packaging terminated by ${result.signal}`);
  process.exit(result.status ?? 1);
}
