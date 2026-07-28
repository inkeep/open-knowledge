import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Config, ConfigSchema } from '@inkeep/open-knowledge-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OK_DIR } from '../constants.ts';
import { formatPreviewBlock, previewContent } from '../content/preview.ts';

function makeConfig(dir = '.'): Config {
  return ConfigSchema.parse({ content: { dir } });
}

describe('preview command', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = resolve(
      tmpdir(),
      `preview-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('works pre-init (no .ok/) using schema defaults', () => {
    writeFileSync(join(testDir, 'a.md'), '# A');
    writeFileSync(join(testDir, 'b.md'), '# B');
    writeFileSync(join(testDir, 'c.md'), '# C');

    expect(existsSync(join(testDir, OK_DIR))).toBe(false);

    const config = makeConfig();
    const contentDir = resolve(testDir, config.content.dir);
    const result = previewContent({ projectDir: testDir, contentDir });

    expect(result.totalCount).toBe(3);
    expect(result.warnings).toEqual([]);

    const output = formatPreviewBlock(result, testDir);
    expect(output).toContain('Found 3 markdown files');
  });

  it('reflects .okignore edits (count drops after adding patterns)', () => {
    mkdirSync(join(testDir, 'docs'));
    mkdirSync(join(testDir, 'vendored'));
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(testDir, 'docs', `d${i}.md`), `# Doc ${i}`);
    }
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(testDir, 'vendored', `v${i}.md`), `# Vendor ${i}`);
    }

    const config = makeConfig();
    const result1 = previewContent({
      projectDir: testDir,
      contentDir: resolve(testDir, config.content.dir),
    });
    expect(result1.totalCount).toBe(8);

    writeFileSync(join(testDir, '.okignore'), 'vendored/\n');

    const result2 = previewContent({
      projectDir: testDir,
      contentDir: resolve(testDir, config.content.dir),
    });
    expect(result2.totalCount).toBe(3);
  });

  it('returns warnings and zero count when contentDir does not exist', () => {
    const config = makeConfig('./missing-dir');
    const contentDir = resolve(testDir, config.content.dir);
    const result = previewContent({ projectDir: testDir, contentDir });

    expect(result.totalCount).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('cannot access content directory');
  });

  it('produces zero filesystem writes', () => {
    writeFileSync(join(testDir, 'test.md'), '# Test');

    const okExistsBefore = existsSync(join(testDir, OK_DIR));
    const mcpExistsBefore = existsSync(join(testDir, '.mcp.json'));

    const config = makeConfig();
    previewContent({ projectDir: testDir, contentDir: resolve(testDir, config.content.dir) });

    expect(existsSync(join(testDir, OK_DIR))).toBe(okExistsBefore);
    expect(existsSync(join(testDir, '.mcp.json'))).toBe(mcpExistsBefore);
  });

  it('renders zero-count with exit-friendly output when dir is empty', () => {
    mkdirSync(join(testDir, 'empty'));

    const config = makeConfig('./empty');
    const contentDir = resolve(testDir, config.content.dir);
    const result = previewContent({ projectDir: testDir, contentDir });

    expect(result.totalCount).toBe(0);
    expect(result.warnings).toEqual([]);

    const output = formatPreviewBlock(result, testDir);
    expect(output).toContain('Found 0 markdown files');
    expect(output).not.toContain('Sample:');
  });
});
