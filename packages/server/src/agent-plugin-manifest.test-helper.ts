/**
 * Shared agent-plugins.org v1.0.0 manifest assertions.
 *
 * Held in one module so that a suite asserting a manifest reuses this name
 * grammar rather than re-declaring one that could drift from it.
 *
 * Test-only module: the `.test-helper.ts` suffix keeps it out of `*.test.ts`
 * discovery and signals it must never be imported from production code (it
 * imports `vitest`).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';

/**
 * The spec's plugin-name grammar (mirrors the enumerator's).
 *
 * Module-local: every caller reaches it through `expectConformantManifest`, so
 * an `export` here is an unused one, which reds `check:drift:guards`.
 */
const NAME_RE = /^(?!.*[-.]{2})[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

export function readManifest(dir: string): { $schema?: unknown; name?: unknown } {
  return JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf-8')) as {
    $schema?: unknown;
    name?: unknown;
  };
}

export function expectConformantManifest(dir: string): void {
  const manifest = readManifest(dir);
  expect(manifest.$schema, `${dir} $schema`).toBe(
    'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  );
  expect(typeof manifest.name, `${dir} name type`).toBe('string');
  expect(manifest.name as string, `${dir} name grammar`).toMatch(NAME_RE);
}
