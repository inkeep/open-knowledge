/**
 * Unit tests for the native markdownlint write surface against a real temp dir:
 * create-on-first-edit (seeded with OK's tuned defaults, materialized),
 * format preservation, merge, key removal, `extends` preservation, and
 * prune-to-empty file deletion. Round-trips are asserted via the discovery read.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MARKDOWNLINT_CONFIG } from '@inkeep/open-knowledge-core';
import { parse as parseYaml } from 'yaml';
import { discoverMarkdownlintConfig, readOwnNativeRules } from './markdownlint-discovery.ts';
import { writeMarkdownlintRule } from './markdownlint-write.ts';

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-mdl-write-')));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeMarkdownlintRule', () => {
  test('creates .markdownlint.json on first edit, seeded with the tuned defaults', () => {
    const res = writeMarkdownlintRule(dir, 'MD010', false);
    expect(res).toEqual({ action: 'written', file: '.markdownlint.json' });
    expect(existsSync(join(dir, '.markdownlint.json'))).toBe(true);
    // The create materializes OK's defaults into the file — from now on the
    // file is the whole story for every native tool; OK layers nothing under.
    expect(discoverMarkdownlintConfig(dir)?.rules).toEqual({
      ...DEFAULT_MARKDOWNLINT_CONFIG,
      MD010: false,
    });
  });

  test('merges a second rule, preserving the first', () => {
    writeMarkdownlintRule(dir, 'MD010', false);
    writeMarkdownlintRule(dir, 'MD013', true);
    expect(discoverMarkdownlintConfig(dir)?.rules).toEqual({
      ...DEFAULT_MARKDOWNLINT_CONFIG,
      MD010: false,
      MD013: true,
    });
  });

  test('updates an existing rule value in place', () => {
    writeMarkdownlintRule(dir, 'MD010', false);
    writeMarkdownlintRule(dir, 'MD010', true);
    expect(discoverMarkdownlintConfig(dir)?.rules).toEqual({
      ...DEFAULT_MARKDOWNLINT_CONFIG,
      MD010: true,
    });
  });

  test('writes a params object', () => {
    writeMarkdownlintRule(dir, 'MD007', { indent: 4 });
    expect(discoverMarkdownlintConfig(dir)?.rules).toEqual({
      ...DEFAULT_MARKDOWNLINT_CONFIG,
      MD007: { indent: 4 },
    });
  });

  test('does NOT seed a hand-authored file (edits merge into what the user wrote)', () => {
    writeFileSync(join(dir, '.markdownlint.json'), JSON.stringify({ MD013: false }), 'utf-8');
    writeMarkdownlintRule(dir, 'MD010', false);
    expect(discoverMarkdownlintConfig(dir)?.rules).toEqual({ MD013: false, MD010: false });
  });

  test('removing the last rule of a hand-authored file deletes it', () => {
    writeFileSync(join(dir, '.markdownlint.json'), JSON.stringify({ MD010: false }), 'utf-8');
    const res = writeMarkdownlintRule(dir, 'MD010', null);
    expect(res.action).toBe('deleted');
    expect(existsSync(join(dir, '.markdownlint.json'))).toBe(false);
  });

  test('removing one of several rules keeps the file', () => {
    writeFileSync(
      join(dir, '.markdownlint.json'),
      JSON.stringify({ MD010: false, MD013: false }),
      'utf-8',
    );
    writeMarkdownlintRule(dir, 'MD010', null);
    expect(discoverMarkdownlintConfig(dir)?.rules).toEqual({ MD013: false });
  });

  test('removing a rule when no file exists is a no-op (never creates a seeded file)', () => {
    const res = writeMarkdownlintRule(dir, 'MD010', null);
    expect(res.action).toBe('noop');
    expect(existsSync(join(dir, '.markdownlint.json'))).toBe(false);
  });

  test('preserves an existing .yaml file (writes YAML, not JSON)', () => {
    writeFileSync(join(dir, '.markdownlint.yaml'), 'MD013: false\n', 'utf-8');
    const res = writeMarkdownlintRule(dir, 'MD010', false);
    expect(res.file).toBe('.markdownlint.yaml');
    expect(existsSync(join(dir, '.markdownlint.json'))).toBe(false);
    // The on-disk file is still parseable as YAML and carries both rules.
    const raw = readFileSync(join(dir, '.markdownlint.yaml'), 'utf-8');
    expect(parseYaml(raw)).toEqual({ MD013: false, MD010: false });
  });

  test('declines to rewrite an executable .cjs config (would corrupt the module)', () => {
    const original = 'module.exports = { MD013: false };';
    writeFileSync(join(dir, '.markdownlint.cjs'), original, 'utf-8');
    const res = writeMarkdownlintRule(dir, 'MD010', false);
    expect(res).toEqual({ action: 'declined-executable', file: '.markdownlint.cjs' });
    // The module body is untouched, byte for byte.
    expect(readFileSync(join(dir, '.markdownlint.cjs'), 'utf-8')).toBe(original);
    expect(existsSync(join(dir, '.markdownlint.json'))).toBe(false);
  });

  // Root reads any file regardless of mode, so the permission probe only
  // proves the abort when the process isn't privileged.
  test.if(process.getuid?.() !== 0)(
    'a transient read failure ABORTS the write — the hand-tuned file is untouched',
    () => {
      const original = JSON.stringify({ MD013: false, MD041: { level: 2 } });
      const file = join(dir, '.markdownlint.json');
      writeFileSync(file, original, 'utf-8');
      chmodSync(file, 0o000);
      try {
        // An unreadable file must never be mistaken for "no rules": merging
        // into an empty base would rewrite the file with only the new rule.
        expect(() => writeMarkdownlintRule(dir, 'MD010', false)).toThrow();
      } finally {
        chmodSync(file, 0o644);
      }
      expect(readFileSync(file, 'utf-8')).toBe(original);
    },
  );

  test('a MALFORMED file is still clobbered cleanly (documented behavior)', () => {
    writeFileSync(join(dir, '.markdownlint.json'), '{ not valid json', 'utf-8');
    const res = writeMarkdownlintRule(dir, 'MD010', false);
    expect(res.action).toBe('written');
    expect(discoverMarkdownlintConfig(dir)?.rules).toEqual({ MD010: false });
  });

  test('preserves an extends reference verbatim — never materializes the base', () => {
    writeFileSync(join(dir, 'base.markdownlint.json'), JSON.stringify({ MD041: false }), 'utf-8');
    writeFileSync(
      join(dir, '.markdownlint.json'),
      JSON.stringify({ extends: './base.markdownlint.json', MD013: false }),
      'utf-8',
    );
    writeMarkdownlintRule(dir, 'MD010', false);
    // Own keys only: the extends key survives, the base's MD041 is NOT copied in.
    expect(readOwnNativeRules(dir)?.rules).toEqual({
      extends: './base.markdownlint.json',
      MD013: false,
      MD010: false,
    });
    // The flattened resolution still sees the base through the chain.
    expect(discoverMarkdownlintConfig(dir)?.rules).toEqual({
      MD041: false,
      MD013: false,
      MD010: false,
    });
  });
});

describe('JSONC comment preservation', () => {
  const COMMENTED = [
    '{',
    '  // tuned for prose, not code',
    '  "MD013": false, /* long lines OK */',
    '  "MD041": false',
    '}',
    '',
  ].join('\n');

  test('toggling an existing rule keeps every comment, changing only the value', () => {
    writeFileSync(join(dir, '.markdownlint.jsonc'), COMMENTED, 'utf-8');
    const res = writeMarkdownlintRule(dir, 'MD013', true);
    expect(res).toEqual({ action: 'written', file: '.markdownlint.jsonc' });
    const raw = readFileSync(join(dir, '.markdownlint.jsonc'), 'utf-8');
    expect(raw).toContain('// tuned for prose, not code');
    expect(raw).toContain('/* long lines OK */');
    expect(discoverMarkdownlintConfig(dir)?.rules).toEqual({ MD013: true, MD041: false });
  });

  test('adding a new rule appends it without disturbing comments', () => {
    writeFileSync(join(dir, '.markdownlint.jsonc'), COMMENTED, 'utf-8');
    writeMarkdownlintRule(dir, 'MD007', { indent: 4 });
    const raw = readFileSync(join(dir, '.markdownlint.jsonc'), 'utf-8');
    expect(raw).toContain('// tuned for prose, not code');
    expect(discoverMarkdownlintConfig(dir)?.rules).toEqual({
      MD013: false,
      MD041: false,
      MD007: { indent: 4 },
    });
  });

  test('removing a rule keeps the remaining config and its comments', () => {
    writeFileSync(join(dir, '.markdownlint.jsonc'), COMMENTED, 'utf-8');
    writeMarkdownlintRule(dir, 'MD041', null);
    const raw = readFileSync(join(dir, '.markdownlint.jsonc'), 'utf-8');
    expect(raw).toContain('// tuned for prose, not code');
    expect(discoverMarkdownlintConfig(dir)?.rules).toEqual({ MD013: false });
  });

  test('removing the LAST rule keeps a file that still carries comments', () => {
    writeFileSync(
      join(dir, '.markdownlint.jsonc'),
      '// our lint philosophy, hand-tuned\n{\n  "MD013": false\n}\n',
      'utf-8',
    );
    const res = writeMarkdownlintRule(dir, 'MD013', null);
    // The emptied config keeps governing (native defaults, no OK underlay) —
    // deleting would destroy the user's comments.
    expect(res.action).toBe('written');
    const raw = readFileSync(join(dir, '.markdownlint.jsonc'), 'utf-8');
    expect(raw).toContain('// our lint philosophy, hand-tuned');
    expect(discoverMarkdownlintConfig(dir)?.rules).toEqual({});
  });

  test('a comment annotating ONLY the removed rule goes with it; an emptied file is deleted', () => {
    writeFileSync(
      join(dir, '.markdownlint.jsonc'),
      '{\n  // about MD013 specifically\n  "MD013": false\n}\n',
      'utf-8',
    );
    // jsonc-parser removes the property together with the comment attached to
    // it — nothing meaningful remains, so the file goes too.
    const res = writeMarkdownlintRule(dir, 'MD013', null);
    expect(res.action).toBe('deleted');
    expect(existsSync(join(dir, '.markdownlint.jsonc'))).toBe(false);
  });

  test('removing the last rule of a comment-free .jsonc still deletes the file', () => {
    writeFileSync(join(dir, '.markdownlint.jsonc'), '{ "MD013": false }\n', 'utf-8');
    const res = writeMarkdownlintRule(dir, 'MD013', null);
    expect(res.action).toBe('deleted');
    expect(existsSync(join(dir, '.markdownlint.jsonc'))).toBe(false);
  });
});

describe('alias-keyed configs', () => {
  test('setting a rule writes through the existing alias key — no dual MD### key', () => {
    writeFileSync(
      join(dir, '.markdownlint.jsonc'),
      '{\n  // prefer readable names\n  "line-length": { "line_length": 100 }\n}\n',
      'utf-8',
    );
    writeMarkdownlintRule(dir, 'MD013', false);
    const raw = readFileSync(join(dir, '.markdownlint.jsonc'), 'utf-8');
    expect(raw).toContain('"line-length": false');
    expect(raw).not.toContain('MD013');
    expect(raw).toContain('// prefer readable names');
  });

  test('with mixed keys, the governing (last) key is edited; the shadowed one is left alone', () => {
    writeFileSync(
      join(dir, '.markdownlint.json'),
      '{\n  "MD013": false,\n  "line-length": true\n}\n',
      'utf-8',
    );
    writeMarkdownlintRule(dir, 'MD013', { line_length: 120 });
    const parsed = JSON.parse(readFileSync(join(dir, '.markdownlint.json'), 'utf-8'));
    // Last-key-wins in the engine: editing the shadowed MD013 would be a no-op.
    expect(parsed).toEqual({ MD013: false, 'line-length': { line_length: 120 } });
  });

  test('removing a rule deletes EVERY key addressing it (a shadowed alias would resurrect it)', () => {
    writeFileSync(
      join(dir, '.markdownlint.json'),
      JSON.stringify({ MD013: false, 'line-length': true, MD010: false }),
      'utf-8',
    );
    writeMarkdownlintRule(dir, 'MD013', null);
    expect(readOwnNativeRules(dir)?.rules).toEqual({ MD010: false });
  });

  test('setting through an alias works on YAML too', () => {
    writeFileSync(join(dir, '.markdownlint.yaml'), 'line-length: false\n', 'utf-8');
    writeMarkdownlintRule(dir, 'MD013', true);
    const raw = readFileSync(join(dir, '.markdownlint.yaml'), 'utf-8');
    expect(parseYaml(raw)).toEqual({ 'line-length': true });
  });

  test('a rule id outside the catalog falls back to exact-key semantics', () => {
    writeFileSync(join(dir, '.markdownlint.json'), JSON.stringify({ MD999: true }), 'utf-8');
    writeMarkdownlintRule(dir, 'MD999', false);
    expect(readOwnNativeRules(dir)?.rules).toEqual({ MD999: false });
  });
});
