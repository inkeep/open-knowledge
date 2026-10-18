import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIENT_RUNTIME_VERSION_FALLBACK } from '@inkeep/open-knowledge-core';
import { describe, expect, test, vi } from 'vitest';

const stamped = vi.hoisted(() => ({ version: '9.8.7-stamped.1' }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { fileURLToPath: toPath } = await import('node:url');
  const serverPackageJson = toPath(new URL('../package.json', import.meta.url));
  const readFileSync = ((path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) =>
    String(path) === serverPackageJson
      ? JSON.stringify({ name: '@inkeep/open-knowledge-server', version: stamped.version })
      : Reflect.apply(actual.readFileSync, actual, [path, ...rest])) as typeof actual.readFileSync;
  return { ...actual, readFileSync };
});

import {
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  readRuntimeVersion,
  STATE_SCHEMA_VERSION,
} from './version-constants.ts';

describe('version-constants', () => {
  test('RUNTIME_VERSION and the default readRuntimeVersion read the package.json beside src', () => {
    expect(RUNTIME_VERSION).toBe(stamped.version);
    expect(readRuntimeVersion()).toBe(stamped.version);
  });

  test('a source checkout carries the unknown placeholder, which clients read as indeterminate', async () => {
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const committed = JSON.parse(
      actualFs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(committed.version).toBe(CLIENT_RUNTIME_VERSION_FALLBACK);
  });

  test('readRuntimeVersion reads a stamped version and falls back when the file is missing or unversioned', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runtime-version-'));
    try {
      const stamped = join(dir, 'stamped.json');
      writeFileSync(stamped, JSON.stringify({ version: '0.87.0' }));
      expect(readRuntimeVersion(stamped)).toBe('0.87.0');
      const unversioned = join(dir, 'unversioned.json');
      writeFileSync(unversioned, JSON.stringify({ name: 'x' }));
      expect(readRuntimeVersion(unversioned)).toBe(CLIENT_RUNTIME_VERSION_FALLBACK);
      expect(readRuntimeVersion(join(dir, 'missing.json'))).toBe(CLIENT_RUNTIME_VERSION_FALLBACK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('PROTOCOL_VERSION is a positive integer', () => {
    expect(typeof PROTOCOL_VERSION).toBe('number');
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  test('STATE_SCHEMA_VERSION is a positive integer (schema-0 reserved as adoption sentinel)', () => {
    expect(typeof STATE_SCHEMA_VERSION).toBe('number');
    expect(Number.isInteger(STATE_SCHEMA_VERSION)).toBe(true);
    expect(STATE_SCHEMA_VERSION).toBeGreaterThan(0);
  });
});
