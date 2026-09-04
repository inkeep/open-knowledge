import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OKF_FRONTMATTER_REGISTRY,
  OKF_SCHEMA_DIR,
  okfSchemaPathFor,
  renderOkfSchemaFiles,
} from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  ensureOkfSchemaFiles,
  resetOkfSchemaWriteState,
  writeOkfSchemaFiles,
} from './write-okf-schemas.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ok-okf-schemas-'));
  mkdirSync(join(root, '.ok'), { recursive: true });
  resetOkfSchemaWriteState();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

describe('writing the schemas', () => {
  test('every registered schema lands at the path it is advertised as', () => {
    writeOkfSchemaFiles(root);
    for (const entry of OKF_FRONTMATTER_REGISTRY) {
      const advertised = okfSchemaPathFor(entry.id);
      expect(existsSync(join(root, advertised)), advertised).toBe(true);
    }
  });

  test('the written bytes ARE the schema the plugin validates with', () => {
    writeOkfSchemaFiles(root);
    for (const file of renderOkfSchemaFiles()) {
      const onDisk = JSON.parse(read(file.path));
      const { $comment, ...schema } = onDisk;
      const entry = OKF_FRONTMATTER_REGISTRY.find((e) => e.id === file.ruleId);
      expect(schema, file.path).toEqual(entry?.schema);
      expect($comment).toBeTypeOf('string');
    }
  });

  test('each file says it is generated and that editing it does nothing', () => {
    writeOkfSchemaFiles(root);
    const first = JSON.parse(read(okfSchemaPathFor('frontmatter-required')));
    expect(first.$comment).toMatch(/do not edit/i);
    expect(first.$comment).toMatch(/overwritten/i);
  });

  test('an edit is reverted on the next write', () => {
    writeOkfSchemaFiles(root);
    const path = okfSchemaPathFor('frontmatter-required');
    writeFileSync(join(root, path), '{"type":"object"}\n', 'utf8');
    writeOkfSchemaFiles(root);
    expect(JSON.parse(read(path)).title).toContain('OKF v0.2');
  });

  test('an unchanged rewrite produces identical bytes', () => {
    writeOkfSchemaFiles(root);
    const path = okfSchemaPathFor('frontmatter-provenance');
    const before = read(path);
    writeOkfSchemaFiles(root);
    expect(read(path)).toBe(before);
  });
});

describe('git handling', () => {
  test('the generated directory is added to .ok/.gitignore', () => {
    writeFileSync(join(root, '.ok', '.gitignore'), 'local/\n', 'utf8');
    writeOkfSchemaFiles(root);
    expect(read('.ok/.gitignore')).toMatch(/^okf\/$/m);
  });

  test('the rule is not duplicated on a second write', () => {
    writeFileSync(join(root, '.ok', '.gitignore'), 'local/\n', 'utf8');
    writeOkfSchemaFiles(root);
    writeOkfSchemaFiles(root);
    const lines = read('.ok/.gitignore')
      .split('\n')
      .filter((l) => l.trim() === 'okf/');
    expect(lines).toHaveLength(1);
  });

  test('a rule the user already wrote themselves is left alone', () => {
    writeFileSync(join(root, '.ok', '.gitignore'), 'local/\n  okf/  \n', 'utf8');
    writeOkfSchemaFiles(root);
    const lines = read('.ok/.gitignore')
      .split('\n')
      .filter((l) => l.trim() === 'okf/');
    expect(lines).toHaveLength(1);
  });

  test('a project with no .ok/.gitignore still gets its schemas', () => {
    rmSync(join(root, '.ok', '.gitignore'), { force: true });
    expect(writeOkfSchemaFiles(root).length).toBeGreaterThan(0);
    expect(existsSync(join(root, OKF_SCHEMA_DIR))).toBe(true);
  });
});

describe('rule toggles', () => {
  test('a disabled rule loses its schema file and keeps the others', () => {
    writeOkfSchemaFiles(root);
    writeOkfSchemaFiles(root, { 'frontmatter-provenance': false });
    expect(existsSync(join(root, okfSchemaPathFor('frontmatter-provenance')))).toBe(false);
    expect(existsSync(join(root, okfSchemaPathFor('frontmatter-required')))).toBe(true);
  });

  test('re-enabling a rule restores its schema file', () => {
    writeOkfSchemaFiles(root, { 'frontmatter-provenance': false });
    writeOkfSchemaFiles(root);
    expect(existsSync(join(root, okfSchemaPathFor('frontmatter-provenance')))).toBe(true);
  });

  test('a body rule with no schema changes nothing', () => {
    writeOkfSchemaFiles(root);
    const before = OKF_FRONTMATTER_REGISTRY.map((e) => read(okfSchemaPathFor(e.id)));
    writeOkfSchemaFiles(root, { 'no-wiki-links': false });
    expect(OKF_FRONTMATTER_REGISTRY.map((e) => read(okfSchemaPathFor(e.id)))).toEqual(before);
  });
});

describe('the enablement gate', () => {
  test('nothing is written while the plugin is off', () => {
    ensureOkfSchemaFiles(root, { enabled: false });
    expect(existsSync(join(root, OKF_SCHEMA_DIR))).toBe(false);
  });

  test('turning it on writes, and repeat calls are a no-op', () => {
    ensureOkfSchemaFiles(root, { enabled: true });
    const path = okfSchemaPathFor('frontmatter-required');
    expect(existsSync(join(root, path))).toBe(true);

    writeFileSync(join(root, path), 'edited\n', 'utf8');
    ensureOkfSchemaFiles(root, { enabled: true });
    expect(read(path)).toBe('edited\n');

    ensureOkfSchemaFiles(root, { enabled: false });
    ensureOkfSchemaFiles(root, { enabled: true });
    expect(JSON.parse(read(path)).title).toContain('OKF v0.2');
  });

  test('toggling a rule off deletes its file without a restart', () => {
    ensureOkfSchemaFiles(root, { enabled: true });
    ensureOkfSchemaFiles(root, { enabled: true, rules: { 'frontmatter-provenance': false } });
    expect(existsSync(join(root, okfSchemaPathFor('frontmatter-provenance')))).toBe(false);
    expect(existsSync(join(root, okfSchemaPathFor('frontmatter-required')))).toBe(true);
  });

  test('disabling the plugin removes the generated files and the directory', () => {
    ensureOkfSchemaFiles(root, { enabled: true });
    ensureOkfSchemaFiles(root, { enabled: false });
    expect(existsSync(join(root, OKF_SCHEMA_DIR))).toBe(false);
  });

  test('disabling the plugin leaves a file it did not write', () => {
    ensureOkfSchemaFiles(root, { enabled: true });
    const stray = join(root, OKF_SCHEMA_DIR, 'notes.txt');
    writeFileSync(stray, 'mine\n', 'utf8');
    ensureOkfSchemaFiles(root, { enabled: false });
    expect(readFileSync(stray, 'utf8')).toBe('mine\n');
    expect(existsSync(join(root, okfSchemaPathFor('frontmatter-required')))).toBe(false);
  });

  test('a second project is not skipped by the first', () => {
    const rootB = mkdtempSync(join(tmpdir(), 'ok-okf-schemas-b-'));
    mkdirSync(join(rootB, '.ok'), { recursive: true });
    try {
      ensureOkfSchemaFiles(root, { enabled: true });
      ensureOkfSchemaFiles(rootB, { enabled: true });
      expect(existsSync(join(rootB, okfSchemaPathFor('frontmatter-required')))).toBe(true);
    } finally {
      rmSync(rootB, { recursive: true, force: true });
    }
  });

  test('an unwritable project degrades quietly rather than throwing', () => {
    expect(() => writeOkfSchemaFiles(join(root, 'nope', '\0bad'))).not.toThrow();
  });
});
