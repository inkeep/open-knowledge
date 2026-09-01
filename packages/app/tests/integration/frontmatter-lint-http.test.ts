import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FrontmatterSchemasListSuccessSchema,
  LintAuditResponseSchema,
  LintConfigResponseSchema,
  LintDocResultSchema,
  LintFixResultSchema,
} from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness.ts';

let server: TestServer;

const SEED_CONFIG = [
  'contentRules:',
  '  frontmatter:',
  '    enabled: true',
  '    schemas:',
  '      - appliesTo:',
  '          - "docs/**"',
  '          - "!**/{index,log}"',
  '        file: ".ok/schemas/doc.schema.json"',
  '      - appliesTo: "broken/**"',
  '        file: ".ok/schemas/missing.schema.json"',
  '      - appliesTo: "modern/**"',
  '        file: ".ok/schemas/modern.schema.json"',
  '      - appliesTo: "nineteen/**"',
  '        file: ".ok/schemas/nineteen.schema.json"',
  '',
].join('\n');

const DOC_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['owner', 'status'],
  properties: {
    owner: { type: 'string' },
    status: { enum: ['draft', 'review', 'published'] },
  },
};

const MODERN_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  $defs: { Status: { enum: ['draft', 'review', 'published'] } },
  required: ['owner', 'status'],
  properties: {
    owner: { type: 'string' },
    status: { $ref: '#/$defs/Status' },
    pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] },
  },
};

const NINETEEN_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2019-09/schema',
  type: 'object',
  $defs: { Slug: { type: 'string', pattern: '^[a-z-]+$' } },
  required: ['slug'],
  properties: { slug: { $ref: '#/$defs/Slug' } },
  dependentRequired: { slug: ['owner'] },
};

const VIOLATING_DOC = ['---', 'status: shipped', '---', '', '# Guide'].join('\n');

beforeAll(async () => {
  server = await createTestServer({ seedProjectConfigYml: SEED_CONFIG });
  mkdirSync(join(server.contentDir, '.ok', 'schemas'), { recursive: true });
  writeFileSync(
    join(server.contentDir, '.ok', 'schemas', 'doc.schema.json'),
    JSON.stringify(DOC_SCHEMA, null, 2),
    'utf-8',
  );
  writeFileSync(
    join(server.contentDir, '.ok', 'schemas', 'modern.schema.json'),
    JSON.stringify(MODERN_SCHEMA, null, 2),
    'utf-8',
  );
  mkdirSync(join(server.contentDir, 'docs'), { recursive: true });
  writeFileSync(join(server.contentDir, 'docs', 'guide.md'), VIOLATING_DOC, 'utf-8');
  writeFileSync(join(server.contentDir, 'docs', 'index.md'), VIOLATING_DOC, 'utf-8');
  writeFileSync(
    join(server.contentDir, '.ok', 'schemas', 'nineteen.schema.json'),
    JSON.stringify(NINETEEN_SCHEMA, null, 2),
    'utf-8',
  );
  mkdirSync(join(server.contentDir, 'nineteen'), { recursive: true });
  writeFileSync(
    join(server.contentDir, 'nineteen', 'note.md'),
    ['---', 'slug: Bad Slug', '---', '', '# Note'].join('\n'),
    'utf-8',
  );
  mkdirSync(join(server.contentDir, 'modern'), { recursive: true });
  writeFileSync(
    join(server.contentDir, 'modern', 'spec.md'),
    [
      '---',
      'owner: serafin',
      'status: shipped',
      'pair:',
      '  - ok',
      '  - nope',
      '---',
      '',
      '# Spec',
    ].join('\n'),
    'utf-8',
  );
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

function api(pathAndQuery: string): string {
  return `http://127.0.0.1:${server.port}${pathAndQuery}`;
}

describe('GET /api/lint — frontmatter diagnostics', () => {
  test('a matching doc reports the worked-example diagnostics', async () => {
    const res = await fetch(api('/api/lint?doc=docs%2Fguide'));
    expect(res.status).toBe(200);
    const body = LintDocResultSchema.parse(await res.json());
    const byCode = new Map(body.diagnostics.map((d) => [d.code, d]));
    const required = byCode.get('required');
    const enumViolation = byCode.get('enum');
    expect(required?.source).toBe('frontmatter');
    expect(required?.message).toContain('"owner"');
    expect(required?.range.start.line).toBe(0);
    expect(enumViolation?.message).toContain('draft, review, published');
    expect(enumViolation?.range.start.line).toBe(1);
    expect(enumViolation?.severity).toBe('warning');
  });

  test('a missing-required diagnostic carries frontmatterProperty across the wire', async () => {
    const res = await fetch(api('/api/lint?doc=docs%2Fguide'));
    expect(res.status).toBe(200);
    const raw = (await res.json()) as { diagnostics: Array<Record<string, unknown>> };
    const required = raw.diagnostics.find((d) => d.code === 'required');
    expect(required?.frontmatterScope).toBe('missing');
    expect(required?.frontmatterProperty).toBe('owner');
  });

  test('a doc excluded by the negated glob gets no frontmatter diagnostics', async () => {
    const res = await fetch(api('/api/lint?doc=docs%2Findex'));
    const body = LintDocResultSchema.parse(await res.json());
    expect(body.diagnostics.filter((d) => d.source === 'frontmatter')).toEqual([]);
  });

  test('a 2020-12 schema validates, including $defs/$ref and prefixItems', async () => {
    const res = await fetch(api('/api/lint?doc=modern%2Fspec'));
    expect(res.status).toBe(200);
    const body = LintDocResultSchema.parse(await res.json());
    const frontmatter = body.diagnostics.filter((d) => d.source === 'frontmatter');

    expect(body.warnings?.some((w) => w.includes('modern.schema.json'))).toBe(false);

    const enumViolation = frontmatter.find((d) => d.code === 'enum');
    expect(enumViolation?.message).toContain('draft, review, published');
    expect(enumViolation?.range.start.line).toBe(2);

    const tuple = frontmatter.find((d) => d.code === 'type');
    expect(tuple?.message).toContain('"pair.1"');
    expect(tuple?.range.start.line).toBe(3);
  });

  test('a 2019-09 schema validates, including $defs/$ref and dependentRequired', async () => {
    const res = await fetch(api('/api/lint?doc=nineteen%2Fnote'));
    expect(res.status).toBe(200);
    const body = LintDocResultSchema.parse(await res.json());
    const frontmatter = body.diagnostics.filter((d) => d.source === 'frontmatter');

    expect(body.warnings?.some((w) => w.includes('nineteen.schema.json'))).toBe(false);
    expect(frontmatter.map((d) => d.code).sort()).toEqual(['dependentRequired', 'pattern']);

    const pattern = frontmatter.find((d) => d.code === 'pattern');
    expect(pattern?.range.start.line).toBe(1);
  });

  test('single-doc responses carry the schemaError on the additive warnings channel, never per-doc', async () => {
    const res = await fetch(api('/api/lint?doc=docs%2Fguide'));
    const body = LintDocResultSchema.parse(await res.json());
    expect(body.warnings?.some((w) => w.includes('missing.schema.json'))).toBe(true);
    expect(body.diagnostics.every((d) => !d.message.includes('missing.schema.json'))).toBe(true);
  });
});

describe('GET /api/lint/audit — aggregation + config channel', () => {
  test('audit aggregates frontmatter diagnostics and dedupes schemaErrors into warnings', async () => {
    const res = await fetch(api('/api/lint/audit?path=docs'));
    expect(res.status).toBe(200);
    const body = LintAuditResponseSchema.parse(await res.json());
    const guide = body.files.find((f) => f.file === 'docs/guide.md');
    expect(guide?.diagnostics.some((d) => d.source === 'frontmatter')).toBe(true);
    expect(body.files.find((f) => f.file === 'docs/index.md')).toBeUndefined();
    const schemaErrors = body.warnings.filter((w) => w.includes('missing.schema.json'));
    expect(schemaErrors).toHaveLength(1);
  });
});

describe('POST /api/lint/fix — config channel', () => {
  test('a schemaError reaches warnings when no content fix is available', async () => {
    const res = await fetch(api('/api/lint/fix'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName: 'docs/guide', agentId: 'frontmatter-fix-agent' }),
    });
    expect(res.status).toBe(200);
    const body = LintFixResultSchema.parse(await res.json());
    expect(body.fixedCount).toBe(0);
    expect(body.ran).toEqual(['frontmatter']);
    expect(body.warnings?.some((warning) => warning.includes('missing.schema.json'))).toBe(true);
  });
});

describe('GET /api/lint/config — effective slice for the browser', () => {
  test('the effective config inlines loaded schema content + configProblems', async () => {
    const res = await fetch(api('/api/lint/config?doc=docs%2Fguide'));
    const body = LintConfigResponseSchema.parse(await res.json());
    const slice = body.effective.plugins.frontmatter;
    expect(slice.enabled).toBe(true);
    const loaded = slice.schemas.find((s) => s.file === '.ok/schemas/doc.schema.json');
    expect(loaded?.schema).toMatchObject({ required: ['owner', 'status'] });
    expect(body.configProblems?.some((p) => p.includes('missing.schema.json'))).toBe(true);
  });
});

describe('agent write path — advisory only, never gating', () => {
  test('a violating write lands AND returns frontmatter lint-violation advisories', async () => {
    const md = ['---', 'status: bogus', '---', '', '# New doc'].join('\n');
    const res = await fetch(api('/api/agent-write-md'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docName: 'docs/advisory-target', markdown: md, position: 'replace' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok?: boolean;
      warnings?: { kind: string; source?: string; code?: string }[];
    };
    const lintWarnings = (body.warnings ?? []).filter((w) => w.kind === 'lint-violation');
    expect(lintWarnings.length).toBeGreaterThan(0);
    expect(lintWarnings.every((w) => w.source === 'frontmatter')).toBe(true);
    expect(lintWarnings.length).toBeLessThanOrEqual(10);
    const target = join(server.contentDir, 'docs', 'advisory-target.md');
    const pollDelay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let onDisk = '';
    for (let i = 0; i < 250; i++) {
      try {
        onDisk = readFileSync(target, 'utf-8');
        if (onDisk.includes('status: bogus')) break;
      } catch {}
      await pollDelay(20);
    }
    expect(onDisk).toContain('status: bogus');
    rmSync(target, { force: true });
  });
});

describe('POST /api/lint/frontmatter-schema — write surface over HTTP', () => {
  function postSchema(payload: Record<string, unknown>): Promise<Response> {
    return fetch(api('/api/lint/frontmatter-schema'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  test('a per-field edit routes to disk and returns the recomputed effective config', async () => {
    const file = '.ok/schemas/http-edit.schema.json';
    const res = await postSchema({
      file,
      field: 'status',
      constraint: { enum: ['draft', 'shipped'], required: true },
    });
    expect(res.status).toBe(200);
    const body = LintConfigResponseSchema.parse(await res.json());
    expect(body.effective.plugins.frontmatter.enabled).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(server.contentDir, file), 'utf-8'));
    expect(onDisk.properties.status.enum).toEqual(['draft', 'shipped']);
    expect(onDisk.required).toContain('status');
    expect(typeof onDisk.$schema).toBe('string');
    rmSync(join(server.contentDir, file), { force: true });
  });

  test('a field-less request takes the create-empty branch and is idempotent', async () => {
    const file = '.ok/schemas/http-create.schema.json';
    const created = await postSchema({ file });
    expect(created.status).toBe(200);
    LintConfigResponseSchema.parse(await created.json());
    const first = readFileSync(join(server.contentDir, file), 'utf-8');
    expect(JSON.parse(first)).toMatchObject({ type: 'object' });

    const again = await postSchema({ file });
    expect(again.status).toBe(200);
    expect(readFileSync(join(server.contentDir, file), 'utf-8')).toBe(first);
    rmSync(join(server.contentDir, file), { force: true });
  });

  test('a project-root-escaping path is refused with 409, not written', async () => {
    const res = await postSchema({ file: '../escape.schema.json' });
    expect(res.status).toBe(409);
  });

  test('a delete request removes a tool-managed schema file and is idempotent', async () => {
    const file = '.ok/schemas/http-delete.schema.json';
    writeFileSync(join(server.contentDir, file), '{"type":"object"}', 'utf-8');
    const res = await postSchema({ file, delete: true });
    expect(res.status).toBe(200);
    LintConfigResponseSchema.parse(await res.json());
    expect(existsSync(join(server.contentDir, file))).toBe(false);

    const again = await postSchema({ file, delete: true });
    expect(again.status).toBe(200);
  });

  test('a delete of a *.schema.json anywhere succeeds; unconventional json is refused', async () => {
    const anywhere = 'notes/x.schema.json';
    mkdirSync(join(server.contentDir, 'notes'), { recursive: true });
    writeFileSync(join(server.contentDir, anywhere), '{"type":"object"}', 'utf-8');
    const okRes = await postSchema({ file: anywhere, delete: true });
    expect(okRes.status).toBe(200);
    expect(existsSync(join(server.contentDir, anywhere))).toBe(false);

    const plain = 'user-owned.json';
    writeFileSync(join(server.contentDir, plain), '{"type":"object"}', 'utf-8');
    const refused = await postSchema({ file: plain, delete: true });
    expect(refused.status).toBe(409);
    expect(existsSync(join(server.contentDir, plain))).toBe(true);
    rmSync(join(server.contentDir, plain), { force: true });
  });

  test('removeField and renameTo shapes edit the file over HTTP', async () => {
    const file = '.ok/schemas/http-fieldops.schema.json';
    writeFileSync(
      join(server.contentDir, file),
      JSON.stringify({ type: 'object', required: ['a'], properties: { a: {}, b: {} } }),
      'utf-8',
    );
    const renamed = await postSchema({ file, field: 'a', renameTo: 'z' });
    expect(renamed.status).toBe(200);
    let onDisk = JSON.parse(readFileSync(join(server.contentDir, file), 'utf-8'));
    expect(Object.keys(onDisk.properties)).toEqual(['z', 'b']);
    expect(onDisk.required).toEqual(['z']);

    const removed = await postSchema({ file, field: 'b', removeField: true });
    expect(removed.status).toBe(200);
    onDisk = JSON.parse(readFileSync(join(server.contentDir, file), 'utf-8'));
    expect(Object.keys(onDisk.properties)).toEqual(['z']);
    rmSync(join(server.contentDir, file), { force: true });
  });

  test('parentPath addresses a nested object property over HTTP', async () => {
    const file = '.ok/schemas/http-nested.schema.json';
    const res = await postSchema({
      file,
      field: 'owner',
      constraint: { type: 'string', required: true },
      parentPath: ['meta'],
    });
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(join(server.contentDir, file), 'utf-8'));
    expect(onDisk.properties.meta.properties.owner.type).toBe('string');
    expect(onDisk.properties.meta.required).toEqual(['owner']);
    expect('required' in onDisk).toBe(false);
    rmSync(join(server.contentDir, file), { force: true });
  });

  test('an {items: true} parentPath segment edits an array element schema over HTTP', async () => {
    const file = '.ok/schemas/http-items.schema.json';
    writeFileSync(
      join(server.contentDir, file),
      JSON.stringify({
        type: 'object',
        properties: { ingredients: { type: 'array', items: { type: 'object' } } },
      }),
      'utf-8',
    );
    const res = await postSchema({
      file,
      field: 'name',
      constraint: { type: 'string', required: true },
      parentPath: ['ingredients', { items: true }],
    });
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(join(server.contentDir, file), 'utf-8'));
    expect(onDisk.properties.ingredients.items.properties.name).toEqual({ type: 'string' });
    expect(onDisk.properties.ingredients.items.required).toEqual(['name']);
    rmSync(join(server.contentDir, file), { force: true });
  });

  test('a bare field, and removeField without field, are rejected as malformed', async () => {
    expect((await postSchema({ file: '.ok/schemas/doc.schema.json', field: 'x' })).status).toBe(
      400,
    );
    expect(
      (await postSchema({ file: '.ok/schemas/doc.schema.json', removeField: true })).status,
    ).toBe(400);
  });

  test('mixing delete with a field edit is rejected as malformed', async () => {
    const res = await postSchema({
      file: '.ok/schemas/doc.schema.json',
      delete: true,
      field: 'status',
      constraint: { type: 'string' },
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/lint/frontmatter-schemas — file listing for the picker', () => {
  test('discovers *.schema.json files anywhere in the project', async () => {
    mkdirSync(join(server.contentDir, 'shapes'), { recursive: true });
    writeFileSync(join(server.contentDir, 'shapes', 'thing.schema.json'), '{}', 'utf-8');
    const res = await fetch(api('/api/lint/frontmatter-schemas'));
    const body = FrontmatterSchemasListSuccessSchema.parse(await res.json());
    expect(body.schemas).toContain('shapes/thing.schema.json');
    expect(body.schemas).toContain('.ok/schemas/doc.schema.json');
    rmSync(join(server.contentDir, 'shapes'), { recursive: true, force: true });
  });

  test('lists the project .ok/schemas/*.json files as project-relative paths', async () => {
    const res = await fetch(api('/api/lint/frontmatter-schemas'));
    expect(res.status).toBe(200);
    const body = FrontmatterSchemasListSuccessSchema.parse(await res.json());
    expect(body.schemas).toContain('.ok/schemas/doc.schema.json');
    expect(body.schemas).not.toContain('.ok/schemas/missing.schema.json');
    expect(body.truncated).toBe(false);
  });
});
