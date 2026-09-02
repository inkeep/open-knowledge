import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LINTER_CONFIG,
  LINT_PLUGINS,
  type LinterConfig,
} from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { auditProject, lintDoc } from './audit.ts';
import { AuditCache } from './audit-cache.ts';

let root: string;

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

const DOC_WITH_TAB = '# Title\n\n\tindented with a tab\n';
const CLEAN_DOC = '# Title\n\nClean paragraph.\n';

const base: LinterConfig = {
  ...DEFAULT_LINTER_CONFIG,
  plugins: {
    ...DEFAULT_LINTER_CONFIG.plugins,
    markdownlint: { ...DEFAULT_LINTER_CONFIG.plugins.markdownlint, enabled: true },
  },
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-audit-')));
});
afterEach(() => {
  vi.restoreAllMocks();
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
    expect(result.ran).toEqual(['markdownlint']);
    expect(result.failures).toEqual([]);
  });

  test('honors the native .markdownlint.json (disables a rule)', async () => {
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

  test('keeps a selected plugin in ran when it degrades and reports the failure', async () => {
    write('a.md', DOC_WITH_TAB);
    const markdownlint = LINT_PLUGINS.find((plugin) => plugin.id === 'markdownlint');
    if (!markdownlint) throw new Error('markdownlint plugin missing');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(markdownlint, 'lint').mockRejectedValue(new Error('boom'));

    const result = await lintDoc({
      projectDir: root,
      contentDir: root,
      baseConfig: base,
      docRelPath: 'a.md',
    });

    expect(result.ran).toEqual(['markdownlint']);
    expect(result.failures).toEqual([
      { source: 'markdownlint', phase: 'lint', docName: 'a.md', message: 'boom' },
    ]);
  });

  test('a degraded lint is not cached — a hit would replay it as clean', async () => {
    write('a.md', DOC_WITH_TAB);
    const markdownlint = LINT_PLUGINS.find((plugin) => plugin.id === 'markdownlint');
    if (!markdownlint) throw new Error('markdownlint plugin missing');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lint = vi.spyOn(markdownlint, 'lint').mockRejectedValue(new Error('boom'));
    const cache = new AuditCache();

    const opts = {
      projectDir: root,
      contentDir: root,
      baseConfig: base,
      docRelPath: 'a.md',
      cache,
    };
    await lintDoc(opts);
    const second = await lintDoc(opts);
    expect(second.failures).toHaveLength(1);
    expect(cache.stats().entries).toBe(0);

    lint.mockRestore();
    const recovered = await lintDoc(opts);
    expect(recovered.failures).toEqual([]);
    expect(cache.stats().entries).toBe(1);
  });
});

describe('auditProject', () => {
  test('emits an explicit empty selection when linting is disabled', async () => {
    write('clean.md', CLEAN_DOC);
    const audit = await auditProject({
      projectDir: root,
      contentDir: root,
      baseConfig: DEFAULT_LINTER_CONFIG,
    });
    expect(audit.ran).toEqual([]);
  });

  test('a plugin failing across the corpus collapses to one counted warning', async () => {
    for (const name of ['a.md', 'b.md', 'c.md']) write(name, DOC_WITH_TAB);
    const markdownlint = LINT_PLUGINS.find((plugin) => plugin.id === 'markdownlint');
    if (!markdownlint) throw new Error('markdownlint plugin missing');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(markdownlint, 'lint').mockRejectedValue(new Error('boom'));

    const audit = await auditProject({ projectDir: root, contentDir: root, baseConfig: base });

    expect(audit.warnings).toEqual([
      'source "markdownlint" lint failed on 3 documents (first: "a.md"): boom',
    ]);
    expect(audit.ran).toEqual(['markdownlint']);
  });

  test('plugin failures stay distinct from generic configuration warnings', async () => {
    write('a.md', DOC_WITH_TAB);
    write('.markdownlint.json', '{ invalid json');
    const markdownlint = LINT_PLUGINS.find((plugin) => plugin.id === 'markdownlint');
    if (!markdownlint) throw new Error('markdownlint plugin missing');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(markdownlint, 'lint').mockRejectedValue(new Error('boom'));

    const audit = await auditProject({ projectDir: root, contentDir: root, baseConfig: base });

    expect(audit.warnings).toContain('source "markdownlint" lint failed on "a.md": boom');
    expect(audit.warnings.some((warning) => warning.includes('.markdownlint.json'))).toBe(true);
  });

  test('includes only docs that have diagnostics, counts all files', async () => {
    write('dirty.md', DOC_WITH_TAB);
    write('clean.md', CLEAN_DOC);
    const audit = await auditProject({ projectDir: root, contentDir: root, baseConfig: base });
    expect(audit.fileCount).toBe(2);
    expect(audit.files.map((f) => f.file)).toEqual(['dirty.md']);
    expect(audit.warningCount).toBeGreaterThan(0);
    expect(audit.errorCount).toBe(0);
    expect(audit.ran).toEqual(['markdownlint']);
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
    expect(audit.ran).toEqual([]);
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
    expect(audit.ran).toEqual([]);
  });

  test('skips hidden path segments — docs there are not addressable to fix or navigate', async () => {
    write('.ok/skills/pack/SKILL.md', DOC_WITH_TAB);
    write('.hidden-notes.md', DOC_WITH_TAB);
    write('visible.md', DOC_WITH_TAB);
    const audit = await auditProject({
      projectDir: root,
      contentDir: root,
      baseConfig: base,
    });
    expect(audit.files.map((f) => f.file)).toEqual(['visible.md']);
  });

  test('refuses a targetPath under a hidden segment', async () => {
    write('.ok/skills/pack/SKILL.md', DOC_WITH_TAB);
    const audit = await auditProject({
      projectDir: root,
      contentDir: root,
      baseConfig: base,
      targetPath: '.ok/skills',
    });
    expect(audit.files).toEqual([]);
    expect(audit.warnings).toEqual([
      expect.stringContaining('refusing audit scope under a hidden path segment'),
    ]);
    expect(audit.ran).toEqual([]);
  });

  test('liveSourceFor overrides disk for loaded docs; null falls back to disk', async () => {
    write('loaded-clean.md', DOC_WITH_TAB);
    write('loaded-dirty.md', CLEAN_DOC);
    write('unloaded.md', DOC_WITH_TAB);
    const audit = await auditProject({
      projectDir: root,
      contentDir: root,
      baseConfig: base,
      liveSourceFor: (rel) => {
        if (rel === 'loaded-clean.md') return CLEAN_DOC;
        if (rel === 'loaded-dirty.md') return DOC_WITH_TAB;
        return null;
      },
    });
    expect(audit.files.map((f) => f.file).sort()).toEqual(['loaded-dirty.md', 'unloaded.md']);
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

  describe('with a result cache', () => {
    test('a second audit at unchanged config re-lints nothing and agrees', async () => {
      write('a.md', DOC_WITH_TAB);
      write('b.md', DOC_WITH_TAB);
      write('clean.md', CLEAN_DOC);
      const cache = new AuditCache();
      const opts = { projectDir: root, contentDir: root, baseConfig: base, cache };

      const first = await auditProject(opts);
      expect(cache.stats()).toMatchObject({ hits: 0, misses: 3, entries: 3 });

      const second = await auditProject(opts);
      expect(cache.stats().hits).toBe(3);
      expect(second.files).toEqual(first.files);
      expect(second.warningCount).toBe(first.warningCount);
      expect(second.errorCount).toBe(first.errorCount);
    });

    test('editing a doc invalidates only that doc', async () => {
      write('a.md', DOC_WITH_TAB);
      write('b.md', DOC_WITH_TAB);
      const cache = new AuditCache();
      const opts = { projectDir: root, contentDir: root, baseConfig: base, cache };
      await auditProject(opts);

      write('a.md', `${DOC_WITH_TAB}\nAnother\tline with a tab.\n`);
      const after = await auditProject(opts);

      expect(cache.stats().hits).toBe(1);
      expect(after.files.map((f) => f.file).sort()).toEqual(['a.md', 'b.md']);
    });

    test('a rule change invalidates every doc', async () => {
      write('a.md', DOC_WITH_TAB);
      write('b.md', DOC_WITH_TAB);
      const cache = new AuditCache();
      await auditProject({ projectDir: root, contentDir: root, baseConfig: base, cache });
      expect(cache.stats().misses).toBe(2);

      const md010Off: LinterConfig = {
        ...base,
        plugins: {
          ...base.plugins,
          markdownlint: { ...base.plugins.markdownlint, rules: { MD010: false } },
        },
      };
      const after = await auditProject({
        projectDir: root,
        contentDir: root,
        baseConfig: md010Off,
        cache,
      });

      expect(cache.stats().hits).toBe(0);
      expect(after.files.some((f) => f.diagnostics.some((d) => d.code === 'MD010'))).toBe(false);
    });

    test('editing the native .markdownlint.json invalidates the cache', async () => {
      write('a.md', DOC_WITH_TAB);
      write('.markdownlint.json', JSON.stringify({ MD010: true }));
      const cache = new AuditCache();
      const opts = { projectDir: root, contentDir: root, baseConfig: base, cache };

      const before = await auditProject(opts);
      expect(before.files.some((f) => f.diagnostics.some((d) => d.code === 'MD010'))).toBe(true);

      write('.markdownlint.json', JSON.stringify({ MD010: false }));
      const after = await auditProject(opts);

      expect(cache.stats().hits).toBe(0);
      expect(after.files.some((f) => f.diagnostics.some((d) => d.code === 'MD010'))).toBe(false);
    });

    test('a doc served from the live CRDT overlay is never cached', async () => {
      write('loaded.md', CLEAN_DOC);
      const cache = new AuditCache();
      const opts = {
        projectDir: root,
        contentDir: root,
        baseConfig: base,
        cache,
        liveSourceFor: (rel: string) => (rel === 'loaded.md' ? DOC_WITH_TAB : null),
      };
      const first = await auditProject(opts);
      const second = await auditProject(opts);

      expect(cache.stats()).toMatchObject({ hits: 0, misses: 0, entries: 0 });
      expect(first.files.map((f) => f.file)).toEqual(['loaded.md']);
      expect(second.files).toEqual(first.files);
    });

    test('config-resolution problems still surface on a cache hit', async () => {
      write('a.md', DOC_WITH_TAB);
      write('.markdownlint.json', '{ not valid json');
      const cache = new AuditCache();
      const opts = { projectDir: root, contentDir: root, baseConfig: base, cache };

      const first = await auditProject(opts);
      expect(first.warnings.length).toBeGreaterThan(0);
      const second = await auditProject(opts);
      expect(second.warnings).toEqual(first.warnings);
    });
  });
});
