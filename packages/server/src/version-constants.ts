import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export { PROTOCOL_VERSION } from '@inkeep/open-knowledge-core';

function readRuntimeVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {}
  return '0.0.0-unknown';
}

export const RUNTIME_VERSION: string = readRuntimeVersion();

export const STATE_SCHEMA_VERSION = 1 as const;
