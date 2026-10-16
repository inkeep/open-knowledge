import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIENT_RUNTIME_VERSION_FALLBACK } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import {
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  readRuntimeVersion,
  STATE_SCHEMA_VERSION,
} from './version-constants.ts';

describe('version-constants', () => {
  test('RUNTIME_VERSION is the version field of the neighbouring package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(RUNTIME_VERSION).toBe(pkg.version);
  });

  test('a source checkout carries the unknown placeholder, which clients read as indeterminate', () => {
    expect(RUNTIME_VERSION).toBe(CLIENT_RUNTIME_VERSION_FALLBACK);
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
