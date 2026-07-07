import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OK_DIR } from '../constants.ts';
import { previewContent } from './preview.ts';

describe('previewContent', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = resolve(
      tmpdir(),
      `preview-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('counts seeded markdown files and returns samples', () => {
    writeFileSync(join(testDir, 'a.md'), '# A');
    writeFileSync(join(testDir, 'b.md'), '# B');
    mkdirSync(join(testDir, 'docs'));
    writeFileSync(join(testDir, 'docs', 'c.md'), '# C');

    const result = previewContent({ projectDir: testDir, contentDir: testDir });

    expect(result.totalCount).toBe(3);
    expect(result.sample.length).toBe(3);
    expect(result.warnings).toEqual([]);
  });

  it('respects .okignore patterns', () => {
    writeFileSync(join(testDir, 'keep.md'), '# Keep');
    writeFileSync(join(testDir, '.okignore'), 'vendored/\n');
    mkdirSync(join(testDir, 'vendored'));
    writeFileSync(join(testDir, 'vendored', 'drop.md'), '# Drop');

    const result = previewContent({ projectDir: testDir, contentDir: testDir });

    expect(result.totalCount).toBe(1);
    expect(result.sample).toEqual(['keep.md']);
  });

  it('respects .gitignore', () => {
    writeFileSync(join(testDir, '.gitignore'), 'ignored/\n');
    writeFileSync(join(testDir, 'visible.md'), '# Visible');
    mkdirSync(join(testDir, 'ignored'));
    writeFileSync(join(testDir, 'ignored', 'hidden.md'), '# Hidden');

    const result = previewContent({ projectDir: testDir, contentDir: testDir });

    expect(result.totalCount).toBe(1);
    expect(result.sample).toEqual(['visible.md']);
  });

  it('returns warning and zero count when contentDir does not exist', () => {
    const missing = join(testDir, 'nonexistent');

    const result = previewContent({ projectDir: testDir, contentDir: missing });

    expect(result.totalCount).toBe(0);
    expect(result.sample).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('cannot access content directory');
  });

  it('caps sample at sampleCap', () => {
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(testDir, `file-${i}.md`), `# ${i}`);
    }

    const result = previewContent({
      projectDir: testDir,
      contentDir: testDir,
      sampleCap: 5,
    });

    expect(result.totalCount).toBe(20);
    expect(result.sample.length).toBe(5);
  });

  it('uses default sampleCap of 5', () => {
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(testDir, `file-${i}.md`), `# ${i}`);
    }

    const result = previewContent({ projectDir: testDir, contentDir: testDir });

    expect(result.totalCount).toBe(10);
    expect(result.sample.length).toBe(5);
  });

  it('skips .ok/ entirely (BUILTIN_SKIP_DIRS coverage)', () => {
    const okDir = join(testDir, OK_DIR);
    mkdirSync(okDir, { recursive: true });
    writeFileSync(join(okDir, 'AGENTS.md'), '# Agents');
    mkdirSync(join(okDir, 'cache'));
    writeFileSync(join(okDir, 'cache', 'cached.md'), '# Cached');
    writeFileSync(join(testDir, 'real.md'), '# Real');

    const result = previewContent({ projectDir: testDir, contentDir: testDir });

    expect(result.totalCount).toBe(1);
    expect(result.sample).toEqual(['real.md']);
  });

  it('returns zero count for empty directory (no .md files)', () => {
    mkdirSync(join(testDir, 'empty-sub'));

    const result = previewContent({ projectDir: testDir, contentDir: testDir });

    expect(result.totalCount).toBe(0);
    expect(result.sample).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('ignores files outside the asset allowlist and the supported-doc extensions', () => {
    writeFileSync(join(testDir, 'readme.md'), '# Readme');
    // TypeScript source is in EXECUTABLE_BLOCKLIST_EXTENSIONS territory and
    // outside the supported-doc extension whitelist (.md / .mdx) —
    // `isSupportedDocFile` rejects it before the filter sees it.
    writeFileSync(join(testDir, 'script.ts'), 'export {}');
    // Truly unknown extension — outside ASSET_EXTENSIONS, outside the
    // doc-extension gate — falls through to step 4 default-exclude.
    writeFileSync(join(testDir, 'arbitrary.xyz'), 'data');

    const result = previewContent({ projectDir: testDir, contentDir: testDir });

    expect(result.totalCount).toBe(1);
    expect(result.sample).toEqual(['readme.md']);
  });

  it('counts symlinked files and traverses symlinked directories', () => {
    writeFileSync(join(testDir, 'real.md'), '# Real');
    mkdirSync(join(testDir, 'real-dir'));
    writeFileSync(join(testDir, 'real-dir', 'nested.md'), '# Nested');

    symlinkSync(join(testDir, 'real.md'), join(testDir, 'link.md'));
    symlinkSync(join(testDir, 'real-dir'), join(testDir, 'link-dir'));

    const result = previewContent({ projectDir: testDir, contentDir: testDir });

    expect(result.totalCount).toBe(4);
    expect(result.warnings).toEqual([]);
  });

  it('warns on broken symlinks instead of throwing', () => {
    writeFileSync(join(testDir, 'real.md'), '# Real');
    symlinkSync(join(testDir, 'nonexistent.md'), join(testDir, 'broken-link.md'));

    const result = previewContent({ projectDir: testDir, contentDir: testDir });

    expect(result.totalCount).toBe(1);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('broken or cyclic symlink');
  });
});
