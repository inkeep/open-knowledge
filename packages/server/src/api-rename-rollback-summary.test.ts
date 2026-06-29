import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import type { Principal } from '@inkeep/open-knowledge-core';
import { createApiExtension } from './api-extension.ts';
import { BacklinkIndex } from './backlink-index.ts';
import {
  __formatContributorsForTests as formatContributorsForTest,
  __resetContributorsForTests as resetContributorsForTest,
} from './contributor-tracker.ts';
import { _resetDocExtensionsForTests } from './doc-extensions.ts';
import type { FileIndexEntry } from './file-watcher.ts';
import { getMetrics, resetMetrics } from './metrics.ts';

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function makeReq(url: string, method: string, body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  const readable = Readable.from(Buffer.from(raw)) as unknown as IncomingMessage;
  readable.method = method;
  readable.url = url;
  readable.headers = { host: 'localhost' };
  return readable;
}

function makeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, headers: {}, body: '' };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      if (headers) Object.assign(captured.headers, headers);
    },
    end(body?: string) {
      captured.body = body ?? '';
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

function buildFileIndex(contentDir: string): ReadonlyMap<string, FileIndexEntry> {
  const index = new Map<string, FileIndexEntry>();
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const stat = statSync(fullPath);
      const docName = fullPath.slice(contentDir.length + 1).replace(/\.md$/, '');
      index.set(docName, { size: stat.size, modified: stat.mtime.toISOString() });
    }
  }
  walk(contentDir);
  return index;
}

async function buildBacklinkIndex(contentDir: string): Promise<BacklinkIndex> {
  const index = new BacklinkIndex({ projectDir: contentDir, contentDir });
  await index.rebuildFromDisk();
  return index;
}

/** Captures calls to the `flushGitCommit` hook so the leak-fix regression
 *  test can assert that handleRenamePath / handleRollback drain pending
 *  contributors into their own L2 commit instead of leaking into the next
 *  unrelated write's commit. */
type FlushGitCommitSpy = {
  readonly calls: ReadonlyArray<number>;
  fn: () => Promise<void>;
};

function createFlushGitCommitSpy(): FlushGitCommitSpy {
  const calls: number[] = [];
  const fn = async (): Promise<void> => {
    calls.push(Date.now());
  };
  return { calls, fn };
}

async function callApi(
  contentDir: string,
  url: string,
  body: unknown,
  backlinkIndex?: BacklinkIndex,
  flushGitCommit?: () => Promise<void>,
  getPrincipal?: () => Principal | null,
  contentFilter?: Parameters<typeof createApiExtension>[0]['contentFilter'],
): Promise<CapturedResponse> {
  const ext = createApiExtension({
    hocuspocus: {
      documents: new Map(),
      closeConnections() {},
      unloadDocument: async () => {},
      debouncer: {
        isDebounced: () => false,
        executeNow: async () => undefined,
      },
    } as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
    sessionManager: {
      closeSession: async () => {},
      closeAllForDoc: async () => {},
    } as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
    contentDir,
    getFileIndex: () => buildFileIndex(contentDir),
    backlinkIndex: backlinkIndex ?? (await buildBacklinkIndex(contentDir)),
    ...(flushGitCommit ? { flushGitCommit } : {}),
    ...(getPrincipal ? { getPrincipal } : {}),
    ...(contentFilter ? { contentFilter } : {}),
  });
  const req = makeReq(url, 'POST', body);
  const { res, captured } = makeRes();
  await (
    ext as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: req, response: res });
  return captured;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ok-rename-rollback-summary-'));
  resetContributorsForTest();
  resetMetrics();
  _resetDocExtensionsForTests();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('handleRenamePath (kind: file) — agentId-guarded attribution', () => {
  test('no agentId (UI-shape body) → rename succeeds with ZERO contributor entries', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'notes',
      toPath: 'renamed-notes',
    });

    expect(response.status).toBe(200);
    expect(formatContributorsForTest()).toBe('');
    expect(getMetrics().agentWriteCalls).toBe(0);
    expect(getMetrics().summariesProvided).toBe(0);
    const parsed = JSON.parse(response.body);
    expect(parsed.summary).toBeUndefined();
  });

  test('with agentId, no summary → default "Renamed X → Y" bullet attributed to new doc only', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');
    writeFileSync(join(tmpDir, 'journal.md'), '# Journal\n\nSee [[notes]].\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'notes',
      toPath: 'renamed-notes',
      agentId: 'claude-1',
      agentName: 'Claude',
    });

    expect(response.status).toBe(200);
    const body = formatContributorsForTest();
    const lines = body.split('\n').filter((l) => l.startsWith('ok-contributors:'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"docs":["renamed-notes"]');
    expect(lines[0]).toContain('"summaries":["Renamed notes → renamed-notes"]');
    expect(getMetrics().agentWriteCalls).toBe(1);
    expect(getMetrics().summariesProvided).toBe(1);
    expect(getMetrics().summariesTruncated).toBe(0);

    const parsed = JSON.parse(response.body);
    expect(parsed.summary).toEqual({ value: 'Renamed notes → renamed-notes' });
  });

  test('with agentId + provided summary → uses provided summary (not default)', async () => {
    writeFileSync(join(tmpDir, 'old.md'), '# Old\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'old',
      toPath: 'new',
      agentId: 'claude-1',
      agentName: 'Claude',
      summary: 'Aligned naming with module layout',
    });

    expect(response.status).toBe(200);
    expect(formatContributorsForTest()).toContain(
      '"summaries":["Aligned naming with module layout"]',
    );
    expect(formatContributorsForTest().match(/ok-contributors:/g)?.length ?? 0).toBe(1);
  });

  test('with agentId, wrong-type summary → 400, no rename side-effects, no counters', async () => {
    writeFileSync(join(tmpDir, 'src.md'), '# Src\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'src',
      toPath: 'dst',
      agentId: 'claude-1',
      summary: { not: 'a string' },
    });

    expect(response.status).toBe(400);
    const summaryErr = JSON.parse(response.body) as Record<string, unknown>;
    expect(summaryErr.type).toBe('urn:ok:error:invalid-request');
    expect(typeof summaryErr.title).toBe('string');
    expect(readFileSync(join(tmpDir, 'src.md'), 'utf-8')).toBe('# Src\n');
    expect(getMetrics().agentWriteCalls).toBe(0);
    expect(formatContributorsForTest()).toBe('');
  });

  test('with agentId + >80-char summary → truncated + truncatedFrom in response', async () => {
    writeFileSync(join(tmpDir, 'x.md'), '# X\n', 'utf-8');

    const long = 'w'.repeat(100);
    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'x',
      toPath: 'y',
      agentId: 'claude-1',
      summary: long,
    });
    const parsed = JSON.parse(response.body);
    expect(parsed.summary.truncatedFrom).toBe(100);
    expect(parsed.summary.hint).toBe('Summary truncated from 100 chars to 80 (max 80).');
    expect(getMetrics().summariesTruncated).toBe(1);
  });

  test('with agentId + overflow default (long doc paths) → server-generated default is truncated silently (no misleading hint/truncatedFrom in response; no M2 inflation)', async () => {
    const long = 'a'.repeat(50);
    writeFileSync(join(tmpDir, `${long}.md`), '# Long\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: long,
      toPath: `${long}-v2`,
      agentId: 'claude-1',
      agentName: 'Claude',
    });

    expect(response.status).toBe(200);
    const parsed = JSON.parse(response.body);
    expect(parsed.summary.value.endsWith('…')).toBe(true);
    expect(parsed.summary.truncatedFrom).toBeUndefined();
    expect(parsed.summary.hint).toBeUndefined();
    expect(getMetrics().summariesTruncated).toBe(0);
    expect(getMetrics().summariesProvided).toBe(1);
  });

  test('no agentId + wrong-type summary → 400 (validation runs unconditionally; attribution still skipped)', async () => {
    writeFileSync(join(tmpDir, 'src.md'), '# Src\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'src',
      toPath: 'dst',
      summary: 42,
    });

    expect(response.status).toBe(400);
    const summaryErr = JSON.parse(response.body) as Record<string, unknown>;
    expect(summaryErr.type).toBe('urn:ok:error:invalid-request');
    expect(typeof summaryErr.title).toBe('string');
    expect(readFileSync(join(tmpDir, 'src.md'), 'utf-8')).toBe('# Src\n');
    expect(formatContributorsForTest()).toBe('');
    expect(getMetrics().agentWriteCalls).toBe(0);
  });
});

describe('handleRollback — agentId-guarded attribution (regression gate)', () => {
  test('no agentId → body parses and short-circuits the attribution branch', async () => {
    const response = await callApi(tmpDir, '/api/rollback', {
      docName: 'test-doc',
      commitSha: 'a'.repeat(40),
    });
    expect(response.status).toBe(503);
    expect(formatContributorsForTest()).toBe('');
    expect(getMetrics().agentWriteCalls).toBe(0);
    expect(getMetrics().summariesProvided).toBe(0);
  });

  test('with agentId but non-string summary → 400 summary-error takes precedence over shadow check', async () => {
    const response = await callApi(tmpDir, '/api/rollback', {
      docName: 'test-doc',
      commitSha: 'a'.repeat(40),
      agentId: 'claude-1',
      summary: 42,
    });
    expect(response.status).toBe(400);
    expect(formatContributorsForTest()).toBe('');
    expect(getMetrics().agentWriteCalls).toBe(0);
  });
});

describe('leak-fix regression', () => {
  test('handleRenamePath (file) with agentId triggers flushGitCommit after recordContributor', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');
    const spy = createFlushGitCommitSpy();

    const response = await callApi(
      tmpDir,
      '/api/rename-path',
      {
        kind: 'file',
        fromPath: 'notes',
        toPath: 'renamed-notes',
        agentId: 'claude-1',
        agentName: 'Claude',
      },
      undefined,
      spy.fn,
    );

    expect(response.status).toBe(200);
    await setImmediate();
    expect(spy.calls.length).toBeGreaterThanOrEqual(1);
  });

  test('handleRenamePath (file) WITHOUT agentId does NOT trigger flushGitCommit (no attribution → no flush needed)', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');
    const spy = createFlushGitCommitSpy();

    const response = await callApi(
      tmpDir,
      '/api/rename-path',
      {
        kind: 'file',
        fromPath: 'notes',
        toPath: 'renamed-notes',
      },
      undefined,
      spy.fn,
    );

    expect(response.status).toBe(200);
    await setImmediate();
    expect(spy.calls.length).toBe(0);
  });

  test('handleRenamePath (file) WITH wrong-type summary does NOT trigger flushGitCommit (early-return 400)', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');
    const spy = createFlushGitCommitSpy();

    const response = await callApi(
      tmpDir,
      '/api/rename-path',
      {
        kind: 'file',
        fromPath: 'notes',
        toPath: 'renamed-notes',
        agentId: 'claude-1',
        summary: 42,
      },
      undefined,
      spy.fn,
    );

    expect(response.status).toBe(400);
    await setImmediate();
    expect(spy.calls.length).toBe(0);
  });
});

describe('handleRenamePath (kind: file) — extension change via explicit .md/.mdx in toPath', () => {
  test('same-base rename with .mdx in toPath physically changes extension on disk', async () => {
    writeFileSync(join(tmpDir, 'foo.md'), '# Foo\n\nOriginal .md content.\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'foo',
      toPath: 'foo.mdx',
    });

    expect(response.status).toBe(200);
    expect(existsSync(join(tmpDir, 'foo.mdx'))).toBe(true);
    expect(existsSync(join(tmpDir, 'foo.md'))).toBe(false);
    const content = readFileSync(join(tmpDir, 'foo.mdx'), 'utf-8');
    expect(content).toContain('Original .md content');
  });

  test('name-and-ext change: rename bar.md → baz.mdx physically moves and renames', async () => {
    writeFileSync(join(tmpDir, 'bar.md'), '# Bar\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'bar',
      toPath: 'baz.mdx',
    });

    expect(response.status).toBe(200);
    expect(existsSync(join(tmpDir, 'baz.mdx'))).toBe(true);
    expect(existsSync(join(tmpDir, 'bar.md'))).toBe(false);
  });

  test('extension-less toPath preserves source extension (backward compat)', async () => {
    writeFileSync(join(tmpDir, 'qux.md'), '# Qux\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'qux',
      toPath: 'renamed-qux',
    });

    expect(response.status).toBe(200);
    expect(existsSync(join(tmpDir, 'renamed-qux.md'))).toBe(true);
    expect(existsSync(join(tmpDir, 'qux.md'))).toBe(false);
    expect(existsSync(join(tmpDir, 'renamed-qux.mdx'))).toBe(false);
  });

  test('explicit extension matching the source (foo → foo.md when foo.md exists) is a no-op', async () => {
    writeFileSync(join(tmpDir, 'stable.md'), '# Stable\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'stable',
      toPath: 'stable.md',
    });

    expect(response.status).toBe(200);
    const parsed = JSON.parse(response.body);
    expect(parsed.renamed).toEqual([]);
    expect(existsSync(join(tmpDir, 'stable.md'))).toBe(true);
  });
});

const fixturePrincipal: Principal = {
  id: 'principal-rename-fixture-9999',
  display_name: 'Miles',
  display_email: 'miles@example.test',
  source: 'git-config',
  created_at: '2026-04-29T10:00:00.000Z',
};

describe('handleRenamePath — actor identity routing', () => {
  test('UI-driven file rename (no agentId) with principal loaded → principal contributor', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');

    const response = await callApi(
      tmpDir,
      '/api/rename-path',
      { kind: 'file', fromPath: 'notes', toPath: 'renamed-notes' },
      undefined,
      undefined,
      () => fixturePrincipal,
    );

    expect(response.status).toBe(200);
    const body = formatContributorsForTest();
    const lines = body.split('\n').filter((l) => l.startsWith('ok-contributors:'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`"id":"${fixturePrincipal.id}"`);
    expect(lines[0]).toContain('"docs":["renamed-notes"]');
  });

  test('UI-driven file rename (no agentId) with NO principal loaded → no contributor (anonymous)', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'notes',
      toPath: 'renamed-notes',
    });

    expect(response.status).toBe(200);
    expect(formatContributorsForTest()).toBe('');
  });

  test('agent file rename + principal loaded → agent contributor (agent wins)', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');

    const response = await callApi(
      tmpDir,
      '/api/rename-path',
      {
        kind: 'file',
        fromPath: 'notes',
        toPath: 'renamed-notes',
        agentId: 'claude-1',
        agentName: 'Claude',
      },
      undefined,
      undefined,
      () => fixturePrincipal,
    );

    expect(response.status).toBe(200);
    const body = formatContributorsForTest();
    const lines = body.split('\n').filter((l) => l.startsWith('ok-contributors:'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"id":"agent-claude-1"');
  });

  test('file rename via consolidated endpoint rewrites inbound wiki-links (FR2/FR10)', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');
    writeFileSync(join(tmpDir, 'journal.md'), '# Journal\n\nSee [[notes]].\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'notes',
      toPath: 'renamed-notes',
    });

    expect(response.status).toBe(200);
    expect(readFileSync(join(tmpDir, 'journal.md'), 'utf-8')).toContain('[[renamed-notes]]');
    const parsed = JSON.parse(response.body);
    expect(parsed.rewrittenDocs).toEqual(
      expect.arrayContaining([expect.objectContaining({ docName: 'journal' })]),
    );
  });

  test('case-only rename succeeds and rewrites inbound wiki-links', async () => {
    writeFileSync(join(tmpDir, 'Notes.md'), '# Notes\n', 'utf-8');
    writeFileSync(join(tmpDir, 'journal.md'), '# Journal\n\nSee [[Notes]].\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'Notes',
      toPath: 'notes',
    });

    expect(response.status).toBe(200);
    expect(readdirSync(tmpDir)).toContain('notes.md');
    expect(readdirSync(tmpDir)).not.toContain('Notes.md');
    expect(readFileSync(join(tmpDir, 'journal.md'), 'utf-8')).toContain('[[notes]]');
    const parsed = JSON.parse(response.body) as Record<string, unknown>;
    expect(parsed.renamed).toEqual([{ fromDocName: 'Notes', toDocName: 'notes' }]);
  });

  test('non-string summary returns 400 before rename', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'notes',
      toPath: 'renamed-notes',
      summary: 42,
    });

    expect(response.status).toBe(400);
    expect(readFileSync(join(tmpDir, 'notes.md'), 'utf-8')).toBe('# Notes\n');
  });

  test('agent file rename with default summary "Renamed X → Y" lands on contributor entry', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'notes',
      toPath: 'renamed-notes',
      agentId: 'claude-1',
      agentName: 'Claude',
    });

    expect(response.status).toBe(200);
    const body = formatContributorsForTest();
    expect(body).toContain('"summaries":["Renamed notes → renamed-notes"]');
  });

  test('side-effect docs (backlink rewrites) stay anonymous (D-A2/NG8)', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');
    writeFileSync(join(tmpDir, 'journal.md'), '# Journal\n\nSee [[notes]].\n', 'utf-8');

    const response = await callApi(
      tmpDir,
      '/api/rename-path',
      { kind: 'file', fromPath: 'notes', toPath: 'renamed-notes' },
      undefined,
      undefined,
      () => fixturePrincipal,
    );

    expect(response.status).toBe(200);
    const body = formatContributorsForTest();
    const lines = body.split('\n').filter((l) => l.startsWith('ok-contributors:'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"docs":["renamed-notes"]');
    expect(lines[0]).not.toContain('journal');
  });
});

describe('handleRenamePath — folder rename via consolidated endpoint', () => {
  test('folder rename rewrites inbound wiki-links across affected docs (FR3)', async () => {
    const setupDir = mkdtempSync(join(tmpdir(), 'ok-folder-rename-'));
    try {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(setupDir, 'articles'), { recursive: true });
      writeFileSync(join(setupDir, 'articles', 'auth.md'), '# Auth\n', 'utf-8');
      writeFileSync(join(setupDir, 'articles', 'login.md'), '# Login\n', 'utf-8');
      writeFileSync(
        join(setupDir, 'index.md'),
        '# Index\n\nSee [[articles/auth]] and [[articles/login]].\n',
        'utf-8',
      );

      const response = await callApi(setupDir, '/api/rename-path', {
        kind: 'folder',
        fromPath: 'articles',
        toPath: 'essays',
      });

      expect(response.status).toBe(200);
      const indexContent = readFileSync(join(setupDir, 'index.md'), 'utf-8');
      expect(indexContent).toContain('[[essays/auth]]');
      expect(indexContent).toContain('[[essays/login]]');
      expect(indexContent).not.toContain('[[articles/');
    } finally {
      rmSync(setupDir, { recursive: true, force: true });
    }
  });

  test('folder rename to nested non-existent destination parent succeeds (auto-create)', async () => {
    const setupDir = mkdtempSync(join(tmpdir(), 'ok-folder-rename-'));
    try {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(setupDir, 'articles'), { recursive: true });
      writeFileSync(join(setupDir, 'articles', 'auth.md'), '# Auth\n', 'utf-8');

      const response = await callApi(setupDir, '/api/rename-path', {
        kind: 'folder',
        fromPath: 'articles',
        toPath: '2026/essays',
      });

      expect(response.status).toBe(200);
      expect(readFileSync(join(setupDir, '2026/essays/auth.md'), 'utf-8')).toBe('# Auth\n');
    } finally {
      rmSync(setupDir, { recursive: true, force: true });
    }
  });

  test('UI folder rename (no agentId) with principal records principal contributor per affected doc', async () => {
    const setupDir = mkdtempSync(join(tmpdir(), 'ok-folder-rename-'));
    try {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(setupDir, 'articles'), { recursive: true });
      writeFileSync(join(setupDir, 'articles', 'auth.md'), '# Auth\n', 'utf-8');
      writeFileSync(join(setupDir, 'articles', 'login.md'), '# Login\n', 'utf-8');

      const response = await callApi(
        setupDir,
        '/api/rename-path',
        { kind: 'folder', fromPath: 'articles', toPath: 'essays' },
        undefined,
        undefined,
        () => fixturePrincipal,
      );

      expect(response.status).toBe(200);
      const body = formatContributorsForTest();
      expect(body).toContain(`"id":"${fixturePrincipal.id}"`);
      expect(body).toContain('essays/auth');
      expect(body).toContain('essays/login');
    } finally {
      rmSync(setupDir, { recursive: true, force: true });
    }
  });
});

describe('handleRenamePath — content-filter admission (FR11)', () => {
  function makeFilter(opts: {
    excludedFiles?: string[];
    excludedDirs?: string[];
  }): Parameters<typeof createApiExtension>[0]['contentFilter'] {
    const excludedFiles = new Set(opts.excludedFiles ?? []);
    const excludedDirs = new Set(opts.excludedDirs ?? []);
    return {
      isExcluded: (relativePath: string) => excludedFiles.has(relativePath),
      isDirExcluded: (relativePath: string) => excludedDirs.has(relativePath),
      getWatcherIgnoreGlobs: () => [],
      incrementMdDir: () => {},
      decrementMdDir: () => {},
    };
  }

  test('file rename to excluded destination → 400 with admission error; source untouched', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');

    const response = await callApi(
      tmpDir,
      '/api/rename-path',
      { kind: 'file', fromPath: 'notes', toPath: 'drafts/private' },
      undefined,
      undefined,
      undefined,
      makeFilter({ excludedFiles: ['drafts/private.md'] }),
    );

    expect(response.status).toBe(400);
    const parsed = JSON.parse(response.body) as Record<string, unknown>;
    expect(parsed.type).toBe('urn:ok:error:invalid-request');
    expect(String(parsed.title)).toContain('Destination document is excluded');
    expect(readFileSync(join(tmpDir, 'notes.md'), 'utf-8')).toBe('# Notes\n');
  });

  test('folder rename to excluded destination → 400 with admission error; source untouched', async () => {
    const folder = join(tmpDir, 'articles');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'auth.md'), '# Auth\n', 'utf-8');

    const response = await callApi(
      tmpDir,
      '/api/rename-path',
      { kind: 'folder', fromPath: 'articles', toPath: 'archive/old' },
      undefined,
      undefined,
      undefined,
      makeFilter({ excludedDirs: ['archive/old'] }),
    );

    expect(response.status).toBe(400);
    const parsed = JSON.parse(response.body) as Record<string, unknown>;
    expect(parsed.type).toBe('urn:ok:error:invalid-request');
    expect(String(parsed.title)).toContain('Destination folder is excluded');
    expect(readFileSync(join(folder, 'auth.md'), 'utf-8')).toBe('# Auth\n');
  });

  test('rename to admitted destination passes content-filter check (no false positive)', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');

    const response = await callApi(
      tmpDir,
      '/api/rename-path',
      { kind: 'file', fromPath: 'notes', toPath: 'renamed' },
      undefined,
      undefined,
      undefined,
      makeFilter({ excludedFiles: ['drafts/private.md'] }),
    );

    expect(response.status).toBe(200);
    const parsed = JSON.parse(response.body);
    expect(parsed.renamed).toEqual([{ fromDocName: 'notes', toDocName: 'renamed' }]);
  });

  test('contentFilter omitted → admission check is a no-op (back-compat)', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'notes',
      toPath: 'drafts/private',
    });

    expect(response.status).toBe(200);
  });
});
