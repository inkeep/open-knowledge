/**
 * Symlink containment for the lint read path: symlinks resolving inside the
 * content dir are supported (realpath-based identity), escapes are refused —
 * lint diagnostics echo source text, so an escaped read is exfiltration.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LINTER_CONFIG, type LinterConfig } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { auditProject, lintDoc } from './audit.ts';

let root: string;
let outside: string;

const SECRET = 'TOP-SECRET-OUTSIDE-CONTENT';
// MD010 (hard tabs) is on by default; a doc with a tab produces a diagnostic.
const DOC_WITH_TAB = '# Title\n\n\tindented with a tab\n';

const base: LinterConfig = {
  ...DEFAULT_LINTER_CONFIG,
  plugins: { markdownlint: { ...DEFAULT_LINTER_CONFIG.plugins.markdownlint, enabled: true } },
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-audit-symlink-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'ok-audit-outside-')));
  writeFileSync(join(outside, 'secret.md'), `# Secret\n\n\t${SECRET}\n`, 'utf-8');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('lintDoc symlink containment', () => {
  test('refuses a symlink escaping the content dir', async () => {
    symlinkSync(join(outside, 'secret.md'), join(root, 'escape.md'));
    await expect(
      lintDoc({ projectDir: root, contentDir: root, baseConfig: base, docRelPath: 'escape.md' }),
    ).rejects.toThrow(/^symlink-escape: /);
  });

  test('lints a symlink resolving inside the content dir', async () => {
    writeFileSync(join(root, 'real.md'), DOC_WITH_TAB, 'utf-8');
    symlinkSync(join(root, 'real.md'), join(root, 'alias.md'));
    const result = await lintDoc({
      projectDir: root,
      contentDir: root,
      baseConfig: base,
      docRelPath: 'alias.md',
    });
    expect(result.file).toBe('alias.md');
    expect(result.diagnostics.some((d) => d.code === 'MD010')).toBe(true);
  });
});

describe('auditProject symlink containment', () => {
  test('a scope through an escaped symlinked dir warns and leaks no diagnostics', async () => {
    symlinkSync(outside, join(root, 'linked'));
    const audit = await auditProject({
      projectDir: root,
      contentDir: root,
      baseConfig: base,
      targetPath: 'linked',
    });
    expect(audit.files).toEqual([]);
    expect(audit.warnings).toEqual([expect.stringContaining('symlink-escape')]);
    expect(JSON.stringify(audit)).not.toContain(SECRET);
  });

  test('a scope targeting an escaping symlinked file warns and leaks no diagnostics', async () => {
    symlinkSync(join(outside, 'secret.md'), join(root, 'escape.md'));
    const audit = await auditProject({
      projectDir: root,
      contentDir: root,
      baseConfig: base,
      targetPath: 'escape.md',
    });
    expect(audit.files).toEqual([]);
    expect(audit.warnings).toEqual([expect.stringContaining('symlink-escape')]);
    expect(JSON.stringify(audit)).not.toContain(SECRET);
  });

  test('a scope through a symlinked dir resolving inside the content dir lints fine', async () => {
    mkdirSync(join(root, 'realdir'));
    writeFileSync(join(root, 'realdir', 'doc.md'), DOC_WITH_TAB, 'utf-8');
    symlinkSync(join(root, 'realdir'), join(root, 'aliasdir'));
    const audit = await auditProject({
      projectDir: root,
      contentDir: root,
      baseConfig: base,
      targetPath: 'aliasdir',
    });
    expect(audit.files.map((f) => f.file)).toEqual([join('aliasdir', 'doc.md')]);
    expect(audit.warnings).toEqual([]);
  });
});
