import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DocumentListSuccessSchema,
  PagesSuccessSchema,
  SearchSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestServer, type TestServer } from './test-harness';

const VISIBLE_TOKEN = 'zzcontroltoken';
const OK_TOKEN = 'zzoktemplatetoken';
const SHARED_TOKEN = 'zzsharedranktoken';
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
  writeFileSync(
    join(contentDir, `${VISIBLE_TOKEN}.md`),
    `# ${SHARED_TOKEN}\n\n${VISIBLE_TOKEN} body\n`,
  );
  mkdirSync(join(contentDir, '.ok', 'templates'), { recursive: true });
  writeFileSync(join(contentDir, '.ok', 'config.yml'), 'content:\n  dir: .\n');
  writeFileSync(
    join(contentDir, '.ok', 'templates', `${OK_TOKEN}.md`),
    `# ${SHARED_TOKEN}\n\n${OK_TOKEN} body\n`,
  );
  mkdirSync(join(contentDir, '.ok', 'worktrees', 'checkout'), { recursive: true });
  writeFileSync(join(contentDir, '.ok', 'worktrees', 'checkout', 'README.md'), '# checkout\n');
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

describe('showOk is a tree-only reveal; template content docs are searchable and link-target-able', () => {
  test('with showOk in use, the watcher index keeps non-skill/template .ok content out', async () => {
    await (await fetch(documentsUrl('?showAll=true&showOk=true'))).json();
    const res = await fetch(documentsUrl(''));
    expect(res.ok).toBe(true);
    const body = DocumentListSuccessSchema.parse(await res.json());
    const paths = body.documents.map(entryPath);
    const nonCarveOutOkPaths = paths.filter(
      (p) =>
        hasOkSegment(p) &&
        p !== '.ok' &&
        !p.startsWith('.ok/skills/') &&
        p !== '.ok/templates' &&
        !p.startsWith('.ok/templates/'),
    );
    expect(nonCarveOutOkPaths).toEqual([]);
    expect(paths).toContain(VISIBLE_TOKEN);
  }, 30_000);

  test('a template body token is searchable but ranks below an ordinary doc (rank penalty)', async () => {
    await (await fetch(documentsUrl('?showAll=true&showOk=true'))).json();
    const controlRes = await fetch(
      `http://127.0.0.1:${server.port}/api/search?query=${VISIBLE_TOKEN}`,
    );
    expect(controlRes.ok).toBe(true);
    const control = SearchSuccessSchema.parse(await controlRes.json());
    expect(control.results.length).toBeGreaterThan(0);

    const okRes = await fetch(`http://127.0.0.1:${server.port}/api/search?query=${OK_TOKEN}`);
    expect(okRes.ok).toBe(true);
    const okBody = SearchSuccessSchema.parse(await okRes.json());
    expect(okBody.results.some((r) => r.path === `.ok/templates/${OK_TOKEN}`)).toBe(true);

    const sharedRes = await fetch(
      `http://127.0.0.1:${server.port}/api/search?query=${SHARED_TOKEN}&intent=omnibar`,
    );
    expect(sharedRes.ok).toBe(true);
    const shared = SearchSuccessSchema.parse(await sharedRes.json());
    const paths = shared.results.map((r) => r.path);
    const visibleRank = paths.indexOf(VISIBLE_TOKEN);
    const templateRank = paths.indexOf(`.ok/templates/${OK_TOKEN}`);
    expect(visibleRank).toBeGreaterThanOrEqual(0);
    expect(templateRank).toBeGreaterThanOrEqual(0);
    expect(templateRank).toBeGreaterThan(visibleRank);
  }, 30_000);

  test('the `[[` link-target list (/api/pages) offers a template content doc', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/pages`);
    expect(res.ok).toBe(true);
    const body = PagesSuccessSchema.parse(await res.json());
    const docNames = body.pages.map((p) => p.docName);
    expect(docNames).toContain(VISIBLE_TOKEN);
    expect(docNames).toContain(`.ok/templates/${OK_TOKEN}`);
  }, 30_000);
});
