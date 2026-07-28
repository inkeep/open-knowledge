import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { findLegacyRuntimeFiles } from './boot.ts';

describe('findLegacyRuntimeFiles', () => {
  let okDir: string;

  beforeEach(() => {
    okDir = `${mkdtempSync(resolve(tmpdir(), 'ok-legacy-test-'))}/.ok`;
    mkdirSync(okDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(resolve(okDir, '..'), { recursive: true, force: true });
  });

  test('fresh project: no legacy files, no .ok/local/ → empty result', () => {
    expect(findLegacyRuntimeFiles(okDir)).toEqual([]);
  });

  test('legacy files at .ok/ root, no .ok/local/ → enumerates them', () => {
    writeFileSync(resolve(okDir, 'server.lock'), '{}');
    writeFileSync(resolve(okDir, 'principal.json'), '{}');
    writeFileSync(resolve(okDir, 'sync-state.json'), '{}');

    const found = findLegacyRuntimeFiles(okDir);
    expect(found).toContain('server.lock');
    expect(found).toContain('principal.json');
    expect(found).toContain('sync-state.json');
    expect(found).toHaveLength(3);
  });

  test('legacy cache/ + tmp/ subdirs are reported with trailing slash', () => {
    mkdirSync(resolve(okDir, 'cache'));
    mkdirSync(resolve(okDir, 'tmp'));

    const found = findLegacyRuntimeFiles(okDir);
    expect(found).toEqual(['cache/', 'tmp/']);
  });

  test('mixed legacy files + dirs reported together', () => {
    writeFileSync(resolve(okDir, 'state.json'), '{}');
    writeFileSync(resolve(okDir, 'last-spawn-error.log'), '');
    mkdirSync(resolve(okDir, 'cache'));

    const found = findLegacyRuntimeFiles(okDir);
    expect(found).toContain('state.json');
    expect(found).toContain('last-spawn-error.log');
    expect(found).toContain('cache/');
  });

  test('populated .ok/local/ suppresses the warning even with legacy files present', () => {
    writeFileSync(resolve(okDir, 'server.lock'), '{}');
    mkdirSync(resolve(okDir, 'local'));
    writeFileSync(resolve(okDir, 'local', 'server.lock'), '{}');

    expect(findLegacyRuntimeFiles(okDir)).toEqual([]);
  });

  test('empty .ok/local/ does NOT suppress (warning still drives developer cleanup)', () => {
    writeFileSync(resolve(okDir, 'server.lock'), '{}');
    mkdirSync(resolve(okDir, 'local'));

    expect(findLegacyRuntimeFiles(okDir)).toEqual(['server.lock']);
  });

  test('config.yml at .ok/ root is NOT a legacy runtime file (committed config)', () => {
    writeFileSync(resolve(okDir, 'config.yml'), '');
    writeFileSync(resolve(okDir, 'frontmatter.yml'), '');
    mkdirSync(resolve(okDir, 'templates'));

    expect(findLegacyRuntimeFiles(okDir)).toEqual([]);
  });

  test('all 7 runtime filenames are detected', () => {
    const expected = [
      'server.lock',
      'ui.lock',
      'state.json',
      'principal.json',
      'sync-state.json',
      'conflicts.json',
      'last-spawn-error.log',
    ];
    for (const name of expected) {
      writeFileSync(resolve(okDir, name), '{}');
    }
    const found = findLegacyRuntimeFiles(okDir);
    expect(found.sort()).toEqual(expected.sort());
  });
});
