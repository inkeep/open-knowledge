import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CANONICAL_SCHEMA_DIALECT_URIS,
  DEFAULT_LINTER_CONFIG,
  DEFAULT_SCHEMA_DIALECT,
  type LinterConfig,
  SUPPORTED_SCHEMA_DIALECTS,
} from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  listProjectSchemaFiles,
  resolveFrontmatterSchemas,
  unmatchedAppliesToProblems,
} from './frontmatter-schemas.ts';
import { composeFrontmatterSchemasConfig, resolveEffectiveLinterConfig } from './resolve-config.ts';

let projectDir: string;
let outsideDir: string;

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-fm-schemas-')));
  outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-fm-outside-')));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const abs = join(projectDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

const GOOD_SCHEMA = JSON.stringify({
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['title'],
});

describe('resolveFrontmatterSchemas — loading', () => {
  test('loads a good schema with content + canonical key', () => {
    const abs = write('.ok/schemas/doc.schema.json', GOOD_SCHEMA);
    const { entries, problems } = resolveFrontmatterSchemas(projectDir, [
      { appliesTo: 'docs/**', file: '.ok/schemas/doc.schema.json' },
    ]);
    expect(problems).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.schema).toMatchObject({ required: ['title'] });
    expect(entries[0]?.key).toBe(realpathSync(abs));
    expect(entries[0]?.appliesTo).toBe('docs/**');
  });

  test('schemas can live anywhere in the project, not only .ok/schemas/', () => {
    write('schemas/custom.json', GOOD_SCHEMA);
    const { entries, problems } = resolveFrontmatterSchemas(projectDir, [
      { file: 'schemas/custom.json' },
    ]);
    expect(problems).toEqual([]);
    expect(entries[0]?.schema).toBeDefined();
  });

  test('a broken file mapped disabled-then-enabled still reports once', () => {
    // The disabled mapping loads (and caches) the outcome first while staying
    // silent. Reporting from inside the cache-miss branch would let the later
    // ENABLED mapping hit the cache and never report, silently unvalidating
    // docs it actively governs — and the suppression would depend on entry
    // order, which the config contract says carries no precedence.
    write('.ok/schemas/broken.json', '{ not json');
    const { problems } = resolveFrontmatterSchemas(projectDir, [
      { file: '.ok/schemas/broken.json', appliesTo: 'archive/**', enabled: false },
      { file: '.ok/schemas/broken.json', appliesTo: 'docs/**', enabled: true },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('.ok/schemas/broken.json');
  });

  test('a broken file mapped by two enabled mappings is not double-reported', () => {
    write('.ok/schemas/broken.json', '{ not json');
    const { problems } = resolveFrontmatterSchemas(projectDir, [
      { file: '.ok/schemas/broken.json', appliesTo: 'docs/**' },
      { file: '.ok/schemas/broken.json', appliesTo: 'specs/**' },
    ]);
    expect(problems).toHaveLength(1);
  });

  test('a broken file mapped only by a disabled mapping stays silent', () => {
    write('.ok/schemas/broken.json', '{ not json');
    const { problems } = resolveFrontmatterSchemas(projectDir, [
      { file: '.ok/schemas/broken.json', appliesTo: 'archive/**', enabled: false },
    ]);
    expect(problems).toEqual([]);
  });

  test('a missing file is a schemaError problem; the entry stays content-less with a key', () => {
    const { entries, problems } = resolveFrontmatterSchemas(projectDir, [
      { file: '.ok/schemas/nope.json' },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('.ok/schemas/nope.json');
    expect(problems[0]).toContain('cannot read');
    expect(entries[0]?.schema).toBeUndefined();
    expect(entries[0]?.key).toBe('.ok/schemas/nope.json');
  });

  test('malformed JSON is a problem, never a throw', () => {
    write('bad.json', '{ not json');
    const { entries, problems } = resolveFrontmatterSchemas(projectDir, [{ file: 'bad.json' }]);
    expect(problems[0]).toContain('malformed JSON');
    expect(entries[0]?.schema).toBeUndefined();
  });

  test('non-object JSON is a problem', () => {
    write('array.json', '["not", "an", "object"]');
    const { problems } = resolveFrontmatterSchemas(projectDir, [{ file: 'array.json' }]);
    expect(problems[0]).toContain('not a JSON object');
  });

  test.each(SUPPORTED_SCHEMA_DIALECTS)('a %s schema loads cleanly', (dialect) => {
    write(
      'dialect.json',
      JSON.stringify({
        $schema: CANONICAL_SCHEMA_DIALECT_URIS[dialect],
        type: 'object',
        required: ['title'],
      }),
    );
    const { entries, problems } = resolveFrontmatterSchemas(projectDir, [{ file: 'dialect.json' }]);
    expect(problems).toEqual([]);
    expect(entries[0]?.schema).toMatchObject({ required: ['title'] });
  });

  test('a schema with no $schema loads (absent means the default dialect)', () => {
    write('bare.json', JSON.stringify({ type: 'object', required: ['title'] }));
    const { entries, problems } = resolveFrontmatterSchemas(projectDir, [{ file: 'bare.json' }]);
    expect(problems).toEqual([]);
    expect(entries[0]?.schema).toMatchObject({ required: ['title'] });
  });

  test('an unsupported dialect is skipped with a problem naming what is supported', () => {
    write(
      'draft04.json',
      JSON.stringify({ $schema: 'http://json-schema.org/draft-04/schema#', type: 'object' }),
    );
    const { entries, problems } = resolveFrontmatterSchemas(projectDir, [{ file: 'draft04.json' }]);
    expect(problems[0]).toContain('unsupported dialect');
    expect(problems[0]).toContain('draft-04');
    for (const dialect of SUPPORTED_SCHEMA_DIALECTS) {
      expect(problems[0]).toContain(dialect);
    }
    // The message carries a paste-ready canonical `$schema` URI, not just the
    // dialect labels, so the fix reads off directly.
    expect(problems[0]).toContain(CANONICAL_SCHEMA_DIALECT_URIS[DEFAULT_SCHEMA_DIALECT]);
    expect(entries[0]?.schema).toBeUndefined();
  });

  test('a schema ajv refuses is a problem', () => {
    write('refused.json', JSON.stringify({ type: 'object', properties: { x: { pattern: '[' } } }));
    const { problems } = resolveFrontmatterSchemas(projectDir, [{ file: 'refused.json' }]);
    expect(problems[0]).toContain('does not compile');
  });

  test('an invalid appliesTo glob surfaces as a problem while the schema still loads', () => {
    write('ok.json', GOOD_SCHEMA);
    const { entries, problems } = resolveFrontmatterSchemas(projectDir, [
      { appliesTo: ['docs/**', 'docs/['], file: 'ok.json' },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('invalid appliesTo glob');
    expect(problems[0]).toContain('docs/[');
    expect(entries[0]?.schema).toBeDefined();
  });

  test('a suspicious glob surfaces an advisory problem; disabled mappings stay silent', () => {
    write('ok.json', GOOD_SCHEMA);
    const { problems } = resolveFrontmatterSchemas(projectDir, [
      { appliesTo: ['docs/', 'notes/**/*.md'], file: 'ok.json' },
    ]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('suspicious appliesTo glob');
    expect(problems[0]).toContain('trailing slash');
    expect(problems[1]).toContain('extension');

    const silent = resolveFrontmatterSchemas(projectDir, [
      { appliesTo: ['docs/'], file: 'ok.json', enabled: false },
    ]);
    expect(silent.problems).toEqual([]);
  });
});

describe('resolveFrontmatterSchemas — escape guards', () => {
  test('a .. path is refused lexically, even when the target exists', () => {
    writeFileSync(join(outsideDir, 'evil.json'), GOOD_SCHEMA);
    const rel = `../${outsideDir.split('/').pop()}/evil.json`;
    const { entries, problems } = resolveFrontmatterSchemas(projectDir, [{ file: rel }]);
    expect(problems[0]).toContain('outside the project');
    expect(entries[0]?.schema).toBeUndefined();
  });

  test('a symlink pointing outside the project is refused', () => {
    writeFileSync(join(outsideDir, 'evil.json'), GOOD_SCHEMA);
    symlinkSync(join(outsideDir, 'evil.json'), join(projectDir, 'link.json'));
    const { entries, problems } = resolveFrontmatterSchemas(projectDir, [{ file: 'link.json' }]);
    expect(problems[0]).toContain('outside the project');
    expect(entries[0]?.schema).toBeUndefined();
  });

  test('a symlink resolving inside the project is fine (realpath identity)', () => {
    write('real/doc.schema.json', GOOD_SCHEMA);
    symlinkSync(join(projectDir, 'real/doc.schema.json'), join(projectDir, 'alias.json'));
    const { entries, problems } = resolveFrontmatterSchemas(projectDir, [{ file: 'alias.json' }]);
    expect(problems).toEqual([]);
    expect(entries[0]?.key).toBe(realpathSync(join(projectDir, 'real/doc.schema.json')));
  });

  test('an unreadable file is a cannot-read problem', () => {
    const abs = write('locked.json', GOOD_SCHEMA);
    chmodSync(abs, 0o000);
    const { problems } = resolveFrontmatterSchemas(projectDir, [{ file: 'locked.json' }]);
    expect(problems[0]).toContain('cannot read');
    chmodSync(abs, 0o644);
  });
});

describe('resolveFrontmatterSchemas — dedup identity', () => {
  test('./-spelled duplicates of one file share a canonical key and read once', () => {
    const abs = write('.ok/schemas/doc.schema.json', GOOD_SCHEMA);
    const { entries, problems } = resolveFrontmatterSchemas(projectDir, [
      { appliesTo: 'docs/**', file: '.ok/schemas/doc.schema.json' },
      { appliesTo: 'specs/**', file: './.ok/schemas/doc.schema.json' },
    ]);
    expect(problems).toEqual([]);
    expect(entries[0]?.key).toBe(realpathSync(abs));
    expect(entries[1]?.key).toBe(realpathSync(abs));
  });

  test('distinct files with identical content keep distinct keys', () => {
    write('a.json', GOOD_SCHEMA);
    write('b.json', GOOD_SCHEMA);
    const { entries } = resolveFrontmatterSchemas(projectDir, [
      { file: 'a.json' },
      { file: 'b.json' },
    ]);
    expect(entries[0]?.key).not.toBe(entries[1]?.key);
  });
});

describe('composeFrontmatterSchemasConfig + resolveEffectiveLinterConfig', () => {
  function baseWith(schemas: { appliesTo?: string | string[]; file: string }[]): LinterConfig {
    return {
      ...DEFAULT_LINTER_CONFIG,
      plugins: {
        ...DEFAULT_LINTER_CONFIG.plugins,
        frontmatter: { enabled: true, schemas },
      },
    };
  }

  test('injects loaded content into the effective slice', () => {
    write('.ok/schemas/doc.schema.json', GOOD_SCHEMA);
    const problems: string[] = [];
    const effective = composeFrontmatterSchemasConfig(
      projectDir,
      baseWith([{ appliesTo: 'docs/**', file: '.ok/schemas/doc.schema.json' }]),
      (p) => problems.push(p),
    );
    expect(problems).toEqual([]);
    expect(effective.plugins.frontmatter.schemas[0]?.schema).toBeDefined();
  });

  test('disabled slice or zero mappings skip the disk entirely', () => {
    const disabled = composeFrontmatterSchemasConfig(projectDir, DEFAULT_LINTER_CONFIG);
    expect(disabled).toBe(DEFAULT_LINTER_CONFIG);
    const empty = composeFrontmatterSchemasConfig(projectDir, baseWith([]));
    expect(empty.plugins.frontmatter.schemas).toEqual([]);
  });

  test('already-resolved entries pass through without re-reading (audit precompose)', () => {
    write('.ok/schemas/doc.schema.json', GOOD_SCHEMA);
    const once = composeFrontmatterSchemasConfig(
      projectDir,
      baseWith([{ file: '.ok/schemas/doc.schema.json' }]),
    );
    rmSync(join(projectDir, '.ok/schemas/doc.schema.json'));
    const twice = composeFrontmatterSchemasConfig(projectDir, once);
    expect(twice).toBe(once);
  });

  test('projectDir resolution holds when contentDir is a subfolder (content.dir)', () => {
    write('.ok/schemas/doc.schema.json', GOOD_SCHEMA);
    const contentDir = join(projectDir, 'kb');
    mkdirSync(contentDir, { recursive: true });
    const problems: string[] = [];
    const effective = resolveEffectiveLinterConfig(
      contentDir,
      baseWith([{ file: '.ok/schemas/doc.schema.json' }]),
      { projectDir, onProblem: (p) => problems.push(p) },
    );
    expect(problems).toEqual([]);
    expect(effective.plugins.frontmatter.schemas[0]?.schema).toBeDefined();
  });
});

describe('listProjectSchemaFiles', () => {
  test('enumerates .ok/schemas/*.json as project-relative paths, sorted', () => {
    write('.ok/schemas/zebra.json', '{}');
    write('.ok/schemas/alpha.schema.json', '{}');
    write('.ok/schemas/notes.JSON', '{}'); // case-insensitive extension match
    write('.ok/schemas/readme.md', '# not a schema'); // non-json ignored
    mkdirSync(join(projectDir, '.ok/schemas/nested'), { recursive: true }); // dirs ignored
    const { schemas, truncated } = listProjectSchemaFiles(projectDir);
    expect(schemas).toEqual([
      '.ok/schemas/alpha.schema.json',
      '.ok/schemas/notes.JSON',
      '.ok/schemas/zebra.json',
    ]);
    expect(truncated).toBe(false);
  });

  test('missing .ok/schemas/ is an empty list, not an error', () => {
    expect(listProjectSchemaFiles(projectDir)).toEqual({ schemas: [], truncated: false });
  });
});

describe('unmatchedAppliesToProblems', () => {
  const docs = ['docs/guide.md', 'notes/todo.md'];

  test('reports enabled mappings whose authored globs match zero docs', () => {
    const problems = unmatchedAppliesToProblems(
      [{ file: '.ok/schemas/doc.schema.json', enabled: true, appliesTo: ['docs/**', 'specs/**'] }],
      docs,
    );
    expect(problems).toEqual([
      'unmatched appliesTo glob "specs/**" — matches no docs in this project (frontmatter mapping for .ok/schemas/doc.schema.json)',
    ]);
  });

  test('disabled mappings stay silent', () => {
    const problems = unmatchedAppliesToProblems(
      [{ file: '.ok/schemas/doc.schema.json', enabled: false, appliesTo: ['specs/**'] }],
      docs,
    );
    expect(problems).toEqual([]);
  });

  test('mappings without appliesTo (implicit every doc) report nothing', () => {
    const problems = unmatchedAppliesToProblems(
      [{ file: '.ok/schemas/doc.schema.json', enabled: true }],
      docs,
    );
    expect(problems).toEqual([]);
  });
});
