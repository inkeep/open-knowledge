import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_VERSION_ENV_VAR = 'VITE_APP_VERSION';

export const APP_VERSION_UNKNOWN = '0.0.0-unknown';

const APP_PACKAGE_JSON = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'package.json',
);

export function resolveAppVersion(pkgPath: string = APP_PACKAGE_JSON): string {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {}
  return APP_VERSION_UNKNOWN;
}

export function injectAppVersionEnv(): string {
  const version = resolveAppVersion();
  process.env[APP_VERSION_ENV_VAR] = version;
  return version;
}
