import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';

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
