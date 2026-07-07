/**
 * Verifies the write-side of the rename history mitigation:
 * - Per-rename JSONL appends to `<gitdir>/ok/renames.jsonl`.
 * - Anonymous renames produce service-writer log entries.
 * - `previous_paths` threads to `OkActorEntry.previous_paths` on the
 *   writer's L2 commit.
 * - Folder rename of N docs produces N entries with shared `groupId`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import simpleGit from 'simple-git';
import { createApiExtension } from './api-extension.ts';
import { BacklinkIndex } from './backlink-index.ts';
import { recordContributor, swapContributors } from './contributor-tracker.ts';
import { _resetDocExtensionsForTests } from './doc-extensions.ts';
import type { FileIndexEntry } from './file-watcher.ts';
import { loadRenameLogIndex, type RenameLogEntry, resetRenameLogIndexCache } from './rename-log.ts';
import { initShadowRepo, type ShadowRef } from './shadow-repo.ts';

interface CapturedResponse {
  status: number;
  body: string;
}

function makeReq(url: string, body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  const readable = Readable.from(Buffer.from(raw)) as unknown as IncomingMessage;
  readable.method = 'POST';
  readable.url = url;
  readable.headers = { host: 'localhost' };
  return readable;
}

function makeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: '' };
  const res = {
    writeHead(status: number) {
      captured.status = status;
    },
    setHeader() {},
    end(body?: string) {
      captured.body = body ?? '';
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

function buildFileIndex(contentDir: string): ReadonlyMap<string, FileIndexEntry> {
  const index = new Map<string, FileIndexEntry>();
  function walk(dir: string) {
    const fs = require('node:fs') as typeof import('node:fs');
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.ok' || entry.name === '.git') continue;
        walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const stat = fs.statSync(fullPath);
      const docName = fullPath.slice(contentDir.length + 1).replace(/\.md$/, '');
      index.set(docName, { size: stat.size, modified: stat.mtime.toISOString() });
    }
  }
  walk(contentDir);
  return index;
}

let tmpDir: string;
let projectDir: string;
let contentDir: string;
let shadowRef: ShadowRef;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ok-rename-emit-'));
  projectDir = tmpDir;
  contentDir = resolve(tmpDir, 'content');
  mkdirSync(contentDir, { recursive: true });

  const git = simpleGit(projectDir);
  await git.init();
  await git.addConfig('user.name', 'Test');
  await git.addConfig('user.email', 'test@example.com');
  writeFileSync(resolve(contentDir, 'placeholder.md'), '# placeholder\n');
  await git.add('.');
  await git.commit('initial');

  const shadow = await initShadowRepo(projectDir);
  shadowRef = { current: shadow };

  swapContributors();
  _resetDocExtensionsForTests();
  resetRenameLogIndexCache();
});

afterEach(() => {
  swapContributors();
  resetRenameLogIndexCache();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function callRename(body: unknown): Promise<CapturedResponse> {
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
    contentRoot: 'content',
    shadowRef,
    getFileIndex: () => buildFileIndex(contentDir),
    backlinkIndex: new BacklinkIndex({ projectDir, contentDir }),
  });
  const req = makeReq('/api/rename-path', body);
  const { res, captured } = makeRes();
  await (
    ext as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: req, response: res });
  return captured;
}

function loadEntries(): RenameLogEntry[] {
  if (!shadowRef.current) return [];
  const index = loadRenameLogIndex(shadowRef.current.gitDir);
  return [...index.byTo.values()];
}

describe('rename log emission inside withManagedRenameRecovery (US-006)', () => {
  test('file rename produces exactly one jsonl entry with the right shape', async () => {
    writeFileSync(resolve(contentDir, 'a.md'), '# A\n');

    const response = await callRename({
      kind: 'file',
      fromPath: 'a.md',
      toPath: 'b.md',
      agentId: 'claude-1',
      agentName: 'Claude',
    });
    expect(response.status).toBe(200);

    const entries = loadEntries();
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.from).toBe('a');
    expect(e.to).toBe('b');
    expect(e.v).toBe(1);
    expect(e.kind).toBe('file');
    expect(e.branch).toBe('main');
    expect(e.commitSha).toBe(''); // lazy-population — backfill is concern
    expect(e.actor.writerId).toBe('agent-claude-1');
    expect(e.actor.displayName).toBeTruthy();
    expect(e.groupId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(e.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('same-base extension change succeeds without a self-rename log entry', async () => {
    writeFileSync(resolve(contentDir, 'a.md'), '# A\n');

    const response = await callRename({
      kind: 'file',
      fromPath: 'a',
      toPath: 'a.mdx',
      agentId: 'claude-1',
      agentName: 'Claude',
    });
    expect(response.status).toBe(200);

    expect(existsSync(resolve(contentDir, 'a.mdx'))).toBe(true);
    expect(existsSync(resolve(contentDir, 'a.md'))).toBe(false);
    expect(loadEntries()).toHaveLength(0);
  });

  test('anonymous rename produces a service-writer log entry (FR13)', async () => {
    writeFileSync(resolve(contentDir, 'a.md'), '# A\n');

    const response = await callRename({
      kind: 'file',
      fromPath: 'a.md',
      toPath: 'b.md',
      // no agentId; no getPrincipal supplied (default → null)
    });
    expect(response.status).toBe(200);

    const entries = loadEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].actor.writerId).toBe('openknowledge-service');
    expect(entries[0].actor.displayName).toBe('OpenKnowledge (service)');
  });

  test('folder rename of 3 docs produces 3 entries with shared groupId (FR5)', async () => {
    mkdirSync(resolve(contentDir, 'articles'), { recursive: true });
    writeFileSync(resolve(contentDir, 'articles/auth.md'), '# auth\n');
    writeFileSync(resolve(contentDir, 'articles/sso.md'), '# sso\n');
    writeFileSync(resolve(contentDir, 'articles/oauth.md'), '# oauth\n');

    const response = await callRename({
      kind: 'folder',
      fromPath: 'articles',
      toPath: 'essays',
      agentId: 'claude-1',
    });
    expect(response.status).toBe(200);

    const entries = loadEntries();
    expect(entries).toHaveLength(3);
    const groupIds = new Set(entries.map((e) => e.groupId));
    expect(groupIds.size).toBe(1); // all three share a single groupId
    const tos = entries.map((e) => e.to).sort();
    expect(tos).toEqual(['essays/auth', 'essays/oauth', 'essays/sso']);
    for (const e of entries) {
      expect(e.kind).toBe('folder');
    }
  });

  test('previous_paths threads through recordContributor onto the writer ContributorEntry — agent path', async () => {
    // The L2 drain (commitToWipRefInner) projects ContributorEntry.previousPaths
    // onto OkActorEntry.previous_paths verbatim. Asserting the upstream entry
    // proves the rename pipeline populated it; the projection is covered by
    // the integration test in rename-history.test.ts which runs a real
    // Hocuspocus drain and verifies `git show <renameSha> --no-patch
    // --format=%B` body contains the `previous_paths` field.
    writeFileSync(resolve(contentDir, 'a.md'), '# A\n');
    const response = await callRename({
      kind: 'file',
      fromPath: 'a.md',
      toPath: 'b.md',
      agentId: 'claude-emit-1',
      agentName: 'Claude',
    });
    expect(response.status).toBe(200);

    const snapshot = swapContributors();
    const entry = snapshot.get('agent-claude-emit-1');
    expect(entry).toBeDefined();
    expect(entry?.previousPaths).toEqual([{ from: 'a', to: 'b' }]);
    expect(entry?.subjectOverride).toBe('rename: a -> b');
    expect(entry?.docs.has('b')).toBe(true);
  });

  test('previous_paths threads through service-writer recordContributor on anonymous rename — regression for M1', async () => {
    // Without the explicit service-writer recordContributor, an anonymous
    // rename's empty-commitSha jsonl entry would orphan when a concurrent
    // agent write fires per-writer fan-out (no service-writer commit ⇒ no
    // backfill ⇒ next-boot sweepLazyPopOrphans drops it). This test
    // simulates the concurrent-agent scenario and asserts
    // `openknowledge-service` is in the pending snapshot.
    writeFileSync(resolve(contentDir, 'a.md'), '# A\n');
    // Pre-existing agent activity in this drain window (a write to some doc).
    recordContributor('unrelated-doc', 'agent-claude-x', 'Claude');

    const response = await callRename({
      kind: 'file',
      fromPath: 'a.md',
      toPath: 'b.md',
      // anonymous — no agentId, no principal
    });
    expect(response.status).toBe(200);

    const snapshot = swapContributors();
    const serviceEntry = snapshot.get('openknowledge-service');
    expect(serviceEntry).toBeDefined();
    expect(serviceEntry?.previousPaths).toEqual([{ from: 'a', to: 'b' }]);
    expect(serviceEntry?.subjectOverride).toBe('rename: a -> b');
    // Agent's own contributor entry is preserved alongside.
    expect(snapshot.get('agent-claude-x')).toBeDefined();
  });

  test('jsonl file is created at <gitdir>/ok/renames.jsonl', async () => {
    writeFileSync(resolve(contentDir, 'a.md'), '# A\n');
    await callRename({
      kind: 'file',
      fromPath: 'a.md',
      toPath: 'b.md',
      agentId: 'claude-1',
    });
    if (!shadowRef.current) throw new Error('shadow missing');
    const path = resolve(shadowRef.current.gitDir, 'renames.jsonl');
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, 'utf-8');
    // Single newline-terminated line for a file rename
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.split('\n').filter((l) => l.length > 0)).toHaveLength(1);
  });
});
