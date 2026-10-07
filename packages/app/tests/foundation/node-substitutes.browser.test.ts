import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const READABLE = join(FIXTURES, 'bridge-readable.txt');

describe('test-side node: imports in the browser tier', () => {
  test('a test reads a fixture beside it through node:fs, node:path and node:url', () => {
    expect(readFileSync(READABLE, 'utf8')).toBe('readable through the file bridge\n');
    expect(
      readFileSync(new URL('./fixtures/bridge-readable.txt', import.meta.url), {
        encoding: 'utf8',
      }),
    ).toBe('readable through the file bridge\n');
    expect(existsSync(READABLE)).toBe(true);
    expect(existsSync(join(FIXTURES, 'absent.txt'))).toBe(false);
    expect(readdirSync(FIXTURES)).toContain('bridge-readable.txt');
  });

  test('a read outside the declared test and source roots is refused', () => {
    expect(() =>
      readFileSync(resolve(HERE, '..', '..', '..', '..', 'package.json'), 'utf8'),
    ).toThrow(/EACCES: .* is outside the declared roots/);
    expect(() => readFileSync(`${HERE}/../../../../package.json`, 'utf8')).toThrow(
      /EACCES: .* path traversal is refused/,
    );
  });

  test('a missing file reads as ENOENT', () => {
    expect(() => readFileSync(join(FIXTURES, 'absent.txt'), 'utf8')).toThrow(/^ENOENT: /);
  });

  test('writes are refused, because the file bridge is read-only', () => {
    expect(() => writeFileSync(join(FIXTURES, 'written.txt'), 'x')).toThrow(
      'node:fs.writeFileSync is not available in the browser tier: the file bridge is read-only',
    );
    expect(() => mkdtempSync(join(tmpdir(), 'ok-'))).toThrow(
      'node:fs.mkdtempSync is not available in the browser tier: the file bridge is read-only',
    );
  });

  test('a read without a utf8 encoding fails instead of returning a different type', () => {
    expect(() => readFileSync(READABLE)).toThrow(
      'node:fs.readFileSync in the browser tier reads utf8 text only; pass "utf8"',
    );
  });

  test('node:crypto, node:os and node:process answer from the engine and the host', () => {
    expect(randomUUID()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(isAbsolute(tmpdir())).toBe(true);
    expect(process.cwd()).toBe(resolve(HERE, '..', '..'));
    expect(() => process.exit(1)).toThrow('process.exit(1) was called in the browser tier');
  });
});
