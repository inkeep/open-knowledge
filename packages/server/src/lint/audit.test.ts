/**
 * Unit tests for project-wide + single-doc lint against a real temp tree:
 * native-file config resolution, content-filter exclusion, and the
 * diagnostics-only audit payload.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LINTER_CONFIG, type LinterConfig } from '@inkeep/open-knowledge-core';
import { auditProject, lintDoc } from './audit.ts';

let root: string;

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

// MD010 (hard tabs) is on by default; a doc with a tab produces a diagnostic.
const DOC_WITH_TAB = '# Title\n\n\tindented with a tab\n';
const CLEAN_DOC = '# Title\n\nClean paragraph.\n';

const base: LinterConfig = {
  ...DEFAULT_LINTER_CONFIG,
  plugins: { markdownlint: { ...DEFAULT_LINTER_CONFIG.plugins.markdownlint, enabled: true } },
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-audit-')));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('lintDoc', () => {
  test('lints a single doc with the base config', async () => {
    write('a.md', DOC_WITH_TAB);
    const result = await lintDoc({
      projectDir: root,
      contentDir: root,
      baseConfig: base,
      docRelPath: 'a.md',
    });
    expect(result.file).toBe('a.md');
    expect(result.diagnostics.some((d) => d.code === 'MD010')).toBe(true);
  });

  test('honors the native .markdownlint.json (disables a rule)', async () => {
    // markdownlint rules are sourced from the project's own `.markdownlint.*`,
    // discovered server-side and injected into the effective config.
    write('sub/b.md', DOC_WITH_TAB);
    write('.markdownlint.json', JSON.stringify({ MD010: false }));
    const result = await lintDoc({
      projectDir: root,
      contentDir: root,
      baseConfig: base,
      docRelPath: 'sub/b.md',
    });
    expect(result.diagnostics.some((d) => d.code === 'MD010')).toBe(false);
  });
});

describe('auditProject', () => {
  test('includes only docs that have diagnostics, counts all files', async () => {
    write('dirty.md', DOC_WITH_TAB);
    write('clean.md', CLEAN_DOC);
    const audit = await auditProject({ projectDir: root, contentDir: root, baseConfig: base });
    expect(audit.fileCount).toBe(2);
    expect(audit.files.map((f) => f.file)).toEqual(['dirty.md']);
    expect(audit.warningCount).toBeGreaterThan(0);
    expect(audit.errorCount).toBe(0);
  });

  test('respects .okignore exclusions', async () => {
    write('keep.md', DOC_WITH_TAB);
    write('drafts/skip.md', DOC_WITH_TAB);
    write('.okignore', 'drafts/\n');
    const audit = await auditProject({ projectDir: root, contentDir: root, baseConfig: base });
    expect(audit.files.map((f) => f.file)).toEqual(['keep.md']);
    expect(audit.fileCount).toBe(1);
  });

  test('scopes to a sub-path when targetPath is a directory', async () => {
    write('top.md', DOC_WITH_TAB);
    write('sub/inner.md', DOC_WITH_TAB);
    const audit = await auditProject({
      projectDir: root,
      contentDir: root,
      baseConfig: base,
      targetPath: 'sub',
    });
    expect(audit.files.map((f) => f.file)).toEqual(['sub/inner.md']);
  });

  test('scopes to a single file when targetPath is a file', async () => {
    write('top.md', DOC_WITH_TAB);
    write('sub/inner.md', DOC_WITH_TAB);
    const audit = await auditProject({
      projectDir: root,
      contentDir: root,
      baseConfig: base,
      targetPath: 'top.md',
    });
    expect(audit.files.map((f) => f.file)).toEqual(['top.md']);
    expect(audit.fileCount).toBe(1);
  });

  test('refuses an absolute targetPath outside the content dir (arbitrary-read guard)', async () => {
    const audit = await auditProject({
      projectDir: root,
      contentDir: root,
      baseConfig: base,
      targetPath: '/etc',
    });
    expect(audit.files).toEqual([]);
    expect(audit.fileCount).toBe(0);
    expect(audit.warnings).toEqual([
      expect.stringContaining('refusing audit scope outside the content directory'),
    ]);
  });

  test('refuses a relative targetPath that escapes the content dir', async () => {
    const audit = await auditProject({
      projectDir: root,
      contentDir: root,
      baseConfig: base,
      targetPath: '../outside',
    });
    expect(audit.files).toEqual([]);
    expect(audit.warnings).toEqual([
      expect.stringContaining('refusing audit scope outside the content directory'),
    ]);
  });

  test('returns nothing when linting is disabled', async () => {
    write('dirty.md', DOC_WITH_TAB);
    const audit = await auditProject({
      projectDir: root,
      contentDir: root,
      baseConfig: { ...base, enabled: false },
    });
    expect(audit.files).toEqual([]);
    expect(audit.warningCount).toBe(0);
  });
});
