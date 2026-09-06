import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function seedKeyInputs(appPackageRoot: string): string[] {
  return [
    join(appPackageRoot, '..', '..', 'pnpm-lock.yaml'),
    join(appPackageRoot, 'vite.config.ts'),
    join(appPackageRoot, 'vite.dedupe.ts'),
    join(appPackageRoot, 'vite.react-babel.ts'),
    join(appPackageRoot, 'package.json'),
  ];
}

export function computeSeedKey(appPackageRoot: string): string {
  const hash = createHash('sha256');
  for (const file of seedKeyInputs(appPackageRoot)) {
    hash.update(file);
    if (existsSync(file)) {
      hash.update(readFileSync(file));
    } else {
      console.warn(
        `[e2e warm-cache] seed key input does not resolve, so its leg is frozen and a persistent` +
          ` checkout can reuse a warm seed built against stale inputs: ${file}`,
      );
      hash.update('absent');
    }
  }
  return hash.digest('hex');
}
