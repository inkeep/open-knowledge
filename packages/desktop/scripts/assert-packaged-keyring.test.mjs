import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { validateProbe } from './assert-packaged-keyring.mjs';

const root = resolve('fixture');
const result = (data, extra = {}) => ({
  status: 0,
  signal: null,
  stdout: `OK_KEYRING_PROBE:${JSON.stringify(data)}\n`,
  ...extra,
});
const loaded = { stage: 'loaded', bindings: [resolve(root, 'keyring.test.node')] };

describe('packaged keyring probe verdict', () => {
  test('reports usage and labels an invalid artifact without starting Electron', () => {
    const script = fileURLToPath(new URL('./assert-packaged-keyring.mjs', import.meta.url));
    const missing = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('usage: assert-packaged-keyring.mjs');
    const invalid = spawnSync(
      process.execPath,
      [script, '/nonexistent-ok-artifact', 'test artifact'],
      { encoding: 'utf8' },
    );
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('::error::test artifact:');
  });
  test('accepts exactly one binding inside the artifact', () =>
    expect(() => validateProbe(result(loaded), root)).not.toThrow());
  test('rejects absent markers, timeouts and signals', () => {
    for (const value of [
      result(loaded, { stdout: '' }),
      result(loaded, { error: new Error('timeout') }),
      result(loaded, { signal: 'SIGTERM' }),
    ]) {
      expect(() => validateProbe(value, root)).toThrow();
    }
  });
  test('rejects missing, unrelated, multiple and outside bindings', () => {
    for (const bindings of [
      [],
      [resolve(root, 'other.node')],
      [resolve(root, 'keyring.test.node'), resolve(root, 'keyring.other.node')],
      [resolve(root, '..', 'keyring.test.node')],
    ]) {
      expect(() => validateProbe(result({ stage: 'loaded', bindings }), root)).toThrow();
    }
  });
  test('requires a marked load failure for the missing-binding control', () => {
    expect(() =>
      validateProbe(result({ stage: 'load-error' }, { status: 1 }), root, true),
    ).not.toThrow();
    for (const value of [
      result(loaded, { status: 1 }),
      result({ stage: 'load-error' }, { status: 2 }),
      result({ stage: 'load-error' }, { status: 1, stdout: '' }),
    ]) {
      expect(() => validateProbe(value, root, true)).toThrow();
    }
  });
});
