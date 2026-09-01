import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LINTER_CONFIG } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { lintDoc } from '../../../server/src/lint/audit.ts';
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
    baseConfig: {
      ...DEFAULT_LINTER_CONFIG,
      plugins: {
        ...DEFAULT_LINTER_CONFIG.plugins,
        markdownlint: { ...DEFAULT_LINTER_CONFIG.plugins.markdownlint, enabled: true },
      },
    },
    ...opts,
  });
}

describe('runLint — walk + lint', () => {
  test('reports the same selected families as the server lint path', async () => {
    write('a.md', '# A\n');
    const local = await run();
    const server = await lintDoc({
      projectDir: root,
      contentDir: root,
      baseConfig: {
        ...DEFAULT_LINTER_CONFIG,
        plugins: {
          ...DEFAULT_LINTER_CONFIG.plugins,
          markdownlint: { ...DEFAULT_LINTER_CONFIG.plugins.markdownlint, enabled: true },
        },
      },
      docRelPath: 'a.md',
    });

    expect(local.ran).toEqual(server.ran);
  });

  test('the walk skips hidden segments; an explicit hidden file target still lints', async () => {
    write('visible.md', '# A\n\ntext with a\ttab\n');
    write('.ok/skills/pack/SKILL.md', '# S\n\ntext with a\ttab\n');
    const swept = await run();
    expect(swept.files.map((f) => f.file)).toEqual(['visible.md']);
    const explicit = await run({ targetPath: join(root, '.ok/skills/pack/SKILL.md') });
    expect(explicit.files.map((f) => f.file)).toEqual(['.ok/skills/pack/SKILL.md']);
  });

  test('lints every in-scope doc and counts problems', async () => {
    write('a.md', '# A\n\ntext with a\ttab\n');
    write('b.md', '# B\n\n#bad heading\n');
    const result = await run();
    expect(result.ran).toEqual(['markdownlint']);
    expect(result.fileCount).toBe(2);
    const a = result.files.find((f) => f.file === 'a.md');
    expect(a?.diagnostics.some((d) => d.code === 'MD010')).toBe(true);
    expect(result.warningCount).toBeGreaterThan(0);
  });

  test('does not flag OK non-HTML superset syntax', async () => {
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

describe('runLint — frontmatter schemas', () => {
  const DOC_SCHEMA = JSON.stringify({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['owner', 'status'],
    properties: { status: { enum: ['draft', 'review', 'published'] } },
  });

  function frontmatterBase(schemas: { appliesTo?: string | string[]; file: string }[]) {
    return {
      ...DEFAULT_LINTER_CONFIG,
      plugins: {
        ...DEFAULT_LINTER_CONFIG.plugins,
        frontmatter: { enabled: true, schemas },
      },
    };
  }

  test('matching docs report frontmatter diagnostics with server-identical anchors', async () => {
    write('.ok/schemas/doc.schema.json', DOC_SCHEMA);
    write('docs/guide.md', '---\nstatus: shipped\n---\n\n# Guide\n');
    write('docs/index.md', '---\nstatus: shipped\n---\n\n# Index\n');
    const result = await run({
      baseConfig: frontmatterBase([
        { appliesTo: ['docs/**', '!**/{index,log}'], file: '.ok/schemas/doc.schema.json' },
      ]),
    });
    expect(result.warnings).toEqual([]);
    const guide = result.files.find((f) => f.file === join('docs', 'guide.md'));
    const codes = guide?.diagnostics.map((d) => `${d.source}/${d.code}`).sort();
    expect(codes).toEqual(['frontmatter/enum', 'frontmatter/required']);
    const enumDiag = guide?.diagnostics.find((d) => d.code === 'enum');
    expect(enumDiag?.range.start.line).toBe(1);
    const index = result.files.find((f) => f.file === join('docs', 'index.md'));
    expect(index?.diagnostics.filter((d) => d.source === 'frontmatter')).toEqual([]);
  });

  test('a 2020-12 schema validates through the CLI path too', async () => {
    write(
      '.ok/schemas/modern.schema.json',
      JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        $defs: { Status: { enum: ['draft', 'published'] } },
        properties: { status: { $ref: '#/$defs/Status' } },
        required: ['status'],
      }),
    );
    write('docs/guide.md', '---\nstatus: shipped\n---\n\n# Guide\n');
    const result = await run({
      baseConfig: frontmatterBase([
        { appliesTo: 'docs/**', file: '.ok/schemas/modern.schema.json' },
      ]),
    });
    expect(result.warnings).toEqual([]);
    const guide = result.files.find((f) => f.file === join('docs', 'guide.md'));
    expect(guide?.diagnostics.map((d) => `${d.source}/${d.code}`)).toEqual(['frontmatter/enum']);
    expect(guide?.diagnostics[0]?.range.start.line).toBe(1);
  });

  test('schemaError surfaces as a report warning and never flips diagnostics', async () => {
    write('docs/guide.md', '---\nstatus: draft\n---\n');
    const result = await run({
      baseConfig: frontmatterBase([{ appliesTo: 'docs/**', file: '.ok/schemas/missing.json' }]),
    });
    expect(result.warnings).toEqual([expect.stringContaining('missing.json')]);
    expect(result.files.every((f) => f.diagnostics.length === 0)).toBe(true);
  });

  test('--fix leaves frontmatter diagnostics untouched while fixing markdownlint issues', async () => {
    write('.ok/schemas/doc.schema.json', DOC_SCHEMA);
    write('docs/guide.md', '---\nstatus: shipped\n---\n\n# G\n\na\tb\n');
    const base = frontmatterBase([{ appliesTo: 'docs/**', file: '.ok/schemas/doc.schema.json' }]);
    base.plugins = {
      ...base.plugins,
      markdownlint: { ...DEFAULT_LINTER_CONFIG.plugins.markdownlint, enabled: true },
    };
    const result = await run({ baseConfig: base, fix: true });
    const guide = result.files.find((f) => f.file === join('docs', 'guide.md'));
    expect(guide?.fixed).toBe(true);
    const onDisk = readFileSync(join(root, 'docs', 'guide.md'), 'utf-8');
    expect(onDisk).toContain('status: shipped');
    expect(onDisk).not.toContain('\t');
    expect(guide?.diagnostics.some((d) => d.source === 'frontmatter')).toBe(true);
  });
});
