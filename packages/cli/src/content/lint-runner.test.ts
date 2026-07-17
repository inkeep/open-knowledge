/**
 * Integration tests for the headless lint runner over a real temp project:
 * the walk, ignore filtering, native-file config resolution, the lint pass,
 * and `--fix` write-back. A real temp dir (not in-memory) is used so the
 * `createContentFilter` ignore-file path and the fs seams are exercised as in
 * production.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LINTER_CONFIG } from '@inkeep/open-knowledge-core';
import { runLint } from './lint-runner.ts';

let root: string;

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-lint-run-')));
  write('.ok/config.yml', 'content:\n  dir: .\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(opts: Partial<Parameters<typeof runLint>[0]> = {}) {
  return runLint({
    projectDir: root,
    contentDir: root,
    // markdownlint is opt-in (off by default); these tests exercise the linter,
    // so enable the plugin explicitly on the base config.
    baseConfig: {
      ...DEFAULT_LINTER_CONFIG,
      plugins: { markdownlint: { ...DEFAULT_LINTER_CONFIG.plugins.markdownlint, enabled: true } },
    },
    ...opts,
  });
}

describe('runLint — walk + lint', () => {
  test('the walk skips hidden segments; an explicit hidden file target still lints', async () => {
    write('visible.md', '# A\n\ntext with a\ttab\n');
    write('.ok/skills/pack/SKILL.md', '# S\n\ntext with a\ttab\n');
    const swept = await run();
    expect(swept.files.map((f) => f.file)).toEqual(['visible.md']);
    // Naming the hidden file bypasses the walk — linter-CLI convention.
    const explicit = await run({ targetPath: join(root, '.ok/skills/pack/SKILL.md') });
    expect(explicit.files.map((f) => f.file)).toEqual(['.ok/skills/pack/SKILL.md']);
  });

  test('lints every in-scope doc and counts problems', async () => {
    write('a.md', '# A\n\ntext with a\ttab\n');
    write('b.md', '# B\n\n#bad heading\n');
    const result = await run();
    expect(result.fileCount).toBe(2);
    const a = result.files.find((f) => f.file === 'a.md');
    expect(a?.diagnostics.some((d) => d.code === 'MD010')).toBe(true);
    expect(result.warningCount).toBeGreaterThan(0);
  });

  test('does not flag OK non-HTML superset syntax', async () => {
    // Defaults match vscode-markdownlint (all on except MD013): raw-HTML MDX
    // (MD033) and a frontmatter title beside an H1 (MD025) DO flag, as in VS
    // Code — so the clean fixture covers only the non-HTML superset.
    write(
      'clean.md',
      '---\nstatus: draft\n---\n\n# H\n\nA [[wiki]], math $x^2$, ==hl==.\n\n> [!NOTE]\n> alert\n',
    );
    const result = await run();
    expect(result.files.find((f) => f.file === 'clean.md')?.diagnostics).toEqual([]);
  });

  test('skips files under ignored/.ok and non-doc files', async () => {
    write('keep.md', '# Keep\n');
    write('notes.txt', 'not markdown\n');
    const result = await run();
    expect(result.files.map((f) => f.file)).toEqual(['keep.md']);
  });
});

describe('runLint — native markdownlint config', () => {
  test('the native .markdownlint.json disables a rule project-wide', async () => {
    // markdownlint rules live in the project's own `.markdownlint.*`, discovered
    // at the content root and injected into the effective config.
    write('.markdownlint.json', JSON.stringify({ MD010: false }));
    write('strict/tabs.md', '# H\n\nhas a\ttab\n');
    const result = await run();
    const note = result.files.find((f) => f.file === join('strict', 'tabs.md'));
    expect(note?.diagnostics.some((d) => d.code === 'MD010')).toBe(false);
  });
});

describe('runLint — scope', () => {
  test('scopes to a single folder', async () => {
    write('a.md', '# A\n');
    write('sub/b.md', '# B\n');
    const result = await run({ targetPath: join(root, 'sub') });
    expect(result.files.map((f) => f.file)).toEqual([join('sub', 'b.md')]);
  });

  test('scopes to a single file', async () => {
    write('a.md', '# A\n\na\tb\n');
    write('b.md', '# B\n');
    const result = await run({ targetPath: join(root, 'a.md') });
    expect(result.files.map((f) => f.file)).toEqual(['a.md']);
  });
});

describe('runLint — fix', () => {
  test('rewrites fixable issues in place and reports residual', async () => {
    write('a.md', '# A\n\ntext with a\ttab\n');
    const result = await run({ fix: true });
    expect(result.fixedCount).toBe(1);
    expect(readFileSync(join(root, 'a.md'), 'utf-8')).not.toContain('\t');
    expect(result.files[0]?.fixed).toBe(true);
  });

  test('does not write when there is nothing to fix', async () => {
    write('a.md', '# A\n\nclean paragraph.\n');
    const before = readFileSync(join(root, 'a.md'), 'utf-8');
    const result = await run({ fix: true });
    expect(result.fixedCount).toBe(0);
    expect(readFileSync(join(root, 'a.md'), 'utf-8')).toBe(before);
  });
});

describe('runLint — per-dir cascade (cli2 semantics)', () => {
  test('the nearest .markdownlint.json governs its subtree wholesale', async () => {
    // Root file leaves MD010 (hard tabs) ON; the folder file turns it off.
    write('.markdownlint.json', JSON.stringify({ MD047: false }));
    write('notes/.markdownlint.json', JSON.stringify({ MD010: false, MD047: false }));
    write('tabbed-root.md', '# A\n\na\tb\n');
    write('notes/tabbed-sub.md', '# B\n\na\tb\n');
    const result = await run({});
    const byFile = new Map(result.files.map((f) => [f.file, f.diagnostics]));
    expect(byFile.get('tabbed-root.md')?.some((d) => d.code === 'MD010')).toBe(true);
    expect(byFile.get(join('notes', 'tabbed-sub.md'))?.some((d) => d.code === 'MD010')).toBe(false);
  });

  test('a malformed native file surfaces a loud warning, not silence', async () => {
    write('.markdownlint.json', '{ nope');
    write('a.md', '# A\n');
    const result = await run({});
    expect(result.warnings).toEqual([expect.stringContaining('malformed markdownlint config')]);
  });
});
