import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_VERSION_ENV_VAR = 'VITE_APP_VERSION';

export function resolveAppVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
  }
  return '0.0.0-unknown';
}

export function injectAppVersionEnv(): string {
  const version = resolveAppVersion();
  process.env[APP_VERSION_ENV_VAR] = version;
  return version;
}
