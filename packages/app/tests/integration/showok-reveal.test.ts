/**
 * `?showOk=true` tree-listing reveal over the real HTTP API. The flag admits
 * `.ok` rows — minus `.ok/worktrees` and `.ok/local` — into the showAll walk
 * on both the buffered and NDJSON paths, and ONLY there: with the flag in
 * active use, the watcher-index-backed default listing and the search corpus
 * must stay `.ok`-free (reveal is a per-request view, never an index rescope),
 * and a plain showAll request keeps today's `.ok`-less listing.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentListSuccessSchema, SearchSuccessSchema } from '@inkeep/open-knowledge-core';
import { createTestServer, type TestServer } from './test-harness';

// Unique body/name tokens so the search-corpus assertions can't false-pass on
// unrelated fixture content: the control token lives in an indexed doc (the
// positive control proving search works), the ok token ONLY under `.ok`.
const VISIBLE_TOKEN = 'zzcontroltoken';
const OK_TOKEN = 'zzoktemplatetoken';
let server: TestServer;

function documentsUrl(params: string): string {
  return `http://127.0.0.1:${server.port}/api/documents${params}`;
}

type ListedEntry = { kind: string; docName?: string; path?: string };

function entryPath(e: ListedEntry): string {
  return e.kind === 'folder' ? (e.path ?? '') : (e.docName ?? e.path ?? '');
}

function hasOkSegment(p: string): boolean {
  return p.split('/').includes('.ok');
}

beforeAll(async () => {
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-showok-reveal-')));
  writeFileSync(join(contentDir, `${VISIBLE_TOKEN}.md`), `# Control\n\n${VISIBLE_TOKEN} body\n`);
  mkdirSync(join(contentDir, '.ok', 'templates'), { recursive: true });
  writeFileSync(join(contentDir, '.ok', 'config.yml'), 'content:\n  dir: .\n');
  writeFileSync(
    join(contentDir, '.ok', 'templates', `${OK_TOKEN}.md`),
    `# Template\n\n${OK_TOKEN} body\n`,
  );
  mkdirSync(join(contentDir, '.ok', 'worktrees', 'checkout'), { recursive: true });
  writeFileSync(join(contentDir, '.ok', 'worktrees', 'checkout', 'README.md'), '# checkout\n');
  // `.ok/local` is not seeded — the booted server creates its own runtime
  // state there (server.lock), which is exactly what must never be listed.
  server = await createTestServer({ contentDir, keepContentDir: false });
}, 60_000);

afterAll(async () => {
  await server.cleanup();
});

describe('showOk reveal on GET /api/documents', () => {
  test('showAll+showOk buffered listing reveals .ok rows minus worktrees/local', async () => {
    const res = await fetch(documentsUrl('?showAll=true&showOk=true'));
    expect(res.ok).toBe(true);
    const body = DocumentListSuccessSchema.parse(await res.json());
    const paths = body.documents.map(entryPath);
    expect(paths).toContain('.ok');
    expect(paths).toContain('.ok/config.yml');
    expect(paths).toContain('.ok/templates');
    expect(paths).toContain(`.ok/templates/${OK_TOKEN}`);
    expect(paths.some((p) => p.startsWith('.ok/worktrees'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.ok/local'))).toBe(false);
  }, 30_000);

  test('showAll without showOk stays .ok-free (default listing unchanged)', async () => {
    const res = await fetch(documentsUrl('?showAll=true'));
    expect(res.ok).toBe(true);
    const body = DocumentListSuccessSchema.parse(await res.json());
    const paths = body.documents.map(entryPath);
    expect(paths.some(hasOkSegment)).toBe(false);
    expect(paths).toContain(VISIBLE_TOKEN);
  }, 30_000);

  test('the NDJSON streaming path honors showOk', async () => {
    const res = await fetch(documentsUrl('?showAll=true&showOk=true'), {
      headers: { Accept: 'application/x-ndjson' },
    });
    expect(res.ok).toBe(true);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const rows = (await res.text())
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as ListedEntry & { type?: string });
    const entries = rows.filter((row) => row.type === undefined);
    const paths = entries.map(entryPath);
    expect(paths).toContain(`.ok/templates/${OK_TOKEN}`);
    expect(paths.some((p) => p.startsWith('.ok/worktrees'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.ok/local'))).toBe(false);
  }, 30_000);

  test('lazy .ok expansion composes showOk with dir + depth', async () => {
    const res = await fetch(
      documentsUrl(`?showAll=true&showOk=true&dir=${encodeURIComponent('.ok')}&depth=1`),
    );
    expect(res.ok).toBe(true);
    const body = DocumentListSuccessSchema.parse(await res.json());
    const paths = body.documents.map(entryPath);
    expect(paths).toContain('.ok/config.yml');
    expect(paths).toContain('.ok/templates');
    expect(paths.some((p) => p.startsWith('.ok/worktrees'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.ok/local'))).toBe(false);
    const templates = body.documents.find((d) => d.kind === 'folder' && d.path === '.ok/templates');
    expect(templates?.kind === 'folder' && templates.hasChildren).toBe(true);
  }, 30_000);
});

describe('showOk never leaks past the tree listing', () => {
  test('with showOk in use, the watcher index keeps non-skill .ok content out', async () => {
    // Exercise the reveal first so the flag is genuinely in use before the
    // index-backed read.
    await (await fetch(documentsUrl('?showAll=true&showOk=true'))).json();
    const res = await fetch(documentsUrl(''));
    expect(res.ok).toBe(true);
    const body = DocumentListSuccessSchema.parse(await res.json());
    const paths = body.documents.map(entryPath);
    // The bare `.ok` folder row and `.ok/skills/**` are the pre-existing
    // skills-as-content carve-out surface of the default listing (the client
    // adapter drops them from the tree); everything else under `.ok` must
    // stay out of the index regardless of showOk traffic.
    const nonSkillOkPaths = paths.filter(
      (p) => hasOkSegment(p) && p !== '.ok' && !p.startsWith('.ok/skills/'),
    );
    expect(nonSkillOkPaths).toEqual([]);
    // Positive control: the index itself is populated and serving.
    expect(paths).toContain(VISIBLE_TOKEN);
  }, 30_000);

  test('with showOk in use, the search corpus never sees .ok content', async () => {
    await (await fetch(documentsUrl('?showAll=true&showOk=true'))).json();
    // Positive control first: an indexed doc's token IS searchable, so the
    // `.ok` negative below can't pass vacuously on a broken corpus.
    const controlRes = await fetch(
      `http://127.0.0.1:${server.port}/api/search?query=${VISIBLE_TOKEN}`,
    );
    expect(controlRes.ok).toBe(true);
    const control = SearchSuccessSchema.parse(await controlRes.json());
    expect(control.results.length).toBeGreaterThan(0);

    const okRes = await fetch(`http://127.0.0.1:${server.port}/api/search?query=${OK_TOKEN}`);
    expect(okRes.ok).toBe(true);
    const okBody = SearchSuccessSchema.parse(await okRes.json());
    expect(okBody.results).toEqual([]);
  }, 30_000);
});
