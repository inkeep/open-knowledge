/**
 * ordering invariant — crash-injection tests for the rewrite spine.
 *
 * Two test-only crash windows are gated by `process.env.OK_TEST_RENAME_FAULT`:
 *
 *   - `pre-append`: thrown AFTER `tracedRenameSync` (disk move) but BEFORE
 *     `appendRenameLogEntry`. Outcome: spine throws; recovery journal stays
 *     on disk; on next-boot recovery, disk reverts; jsonl is unchanged.
 *
 *   - `pre-journal-clear`: thrown AFTER the log append + per-doc sync loop
 *     completes, BEFORE the implicit `clearManagedRenameJournal` at the end
 *     of the recovery envelope. Outcome: spine throws; recovery journal
 *     stays on disk; jsonl has the orphan entry with empty `commitSha`. On
 *     next-boot: disk reverts, `sweepLazyPopOrphans` drops the
 *     empty-commitSha entry. Final state: pre-rename disk + no log entry.
 *
 * Production builds elide these branches (NODE_ENV !== 'test' AND
 * OK_TEST_RENAME_FAULT unset).
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
import { swapContributors } from './contributor-tracker.ts';
import type { FileIndexEntry } from './file-watcher.ts';
import { recoverPendingManagedRename } from './managed-rename-journal.ts';
import { loadRenameLogIndex, resetRenameLogIndexCache, sweepLazyPopOrphans } from './rename-log.ts';
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
  const fs = require('node:fs') as typeof import('node:fs');
  function walk(dir: string) {
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
  tmpDir = mkdtempSync(join(tmpdir(), 'ok-rename-crash-'));
  projectDir = tmpDir;
  contentDir = resolve(tmpDir, 'content');
  mkdirSync(contentDir, { recursive: true });

  const git = simpleGit(projectDir);
  await git.init();
  await git.addConfig('user.name', 'Test');
  await git.addConfig('user.email', 'test@example.com');
  writeFileSync(resolve(contentDir, 'a.md'), '# A original\n');
  await git.add('.');
  await git.commit('initial');

  const shadow = await initShadowRepo(projectDir);
  shadowRef = { current: shadow };

  swapContributors();
  resetRenameLogIndexCache();
});

afterEach(() => {
  delete process.env.OK_TEST_RENAME_FAULT;
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

describe('FR12 ordering invariant — pre-append crash window', () => {
  test('crash AFTER tracedRenameSync, BEFORE log append → recovery rolls back disk; jsonl untouched', async () => {
    process.env.OK_TEST_RENAME_FAULT = 'pre-append';

    // Even though the API surfaces a 5xx, the rewrite spine has thrown
    // mid-flight. The recovery journal is on disk (created before the
    // disk move per `withManagedRenameRecovery`); the jsonl was never
    // written to.
    const response = await callRename({
      kind: 'file',
      fromPath: 'a.md',
      toPath: 'b.md',
      agentId: 'claude-1',
    });
    expect(response.status).not.toBe(200); // request failed mid-flight

    // jsonl should not exist or should be empty
    if (shadowRef.current) {
      const jsonlPath = resolve(shadowRef.current.gitDir, 'renames.jsonl');
      if (existsSync(jsonlPath)) {
        expect(readFileSync(jsonlPath, 'utf-8')).toBe('');
      }
    }

    // Simulate next-boot recovery: drop the fault env, run recovery,
    // confirm disk reverted to pre-rename state.
    delete process.env.OK_TEST_RENAME_FAULT;
    const recoveryResult = recoverPendingManagedRename(contentDir);
    expect(recoveryResult.recovered).toBe(true);
    expect(existsSync(resolve(contentDir, 'a.md'))).toBe(true);
    expect(existsSync(resolve(contentDir, 'b.md'))).toBe(false);
  });
});

describe('Goal G5 — appendRenameLogEntry filesystem failure aborts the rename', () => {
  test('append failure (EISDIR / disk-full / EACCES shape) → spine throws; recovery rolls back disk; G5 (post-rename, no entry) state never observed', async () => {
    // Simulate ENOSPC / EROFS / EACCES on `<gitdir>/ok/renames.jsonl` by
    // pre-creating the path AS A DIRECTORY. The append helper opens the
    // file with `flag: 'a'` for write — opening a directory for write
    // fails with EISDIR on POSIX (same shape failure path: errno bubbles
    // out of `appendFileSync`). This proves the spine re-throws append
    // errors instead of swallowing them, and the recovery envelope keeps
    // the journal so next-boot recovery rolls disk back.
    if (!shadowRef.current) throw new Error('shadow missing');
    const jsonlPath = resolve(shadowRef.current.gitDir, 'renames.jsonl');
    mkdirSync(jsonlPath); // pre-create as directory → next appendFileSync fails

    const response = await callRename({
      kind: 'file',
      fromPath: 'a.md',
      toPath: 'b.md',
      agentId: 'claude-1',
    });
    // Spine threw → handler responds with a non-200. Goal G5 forbids
    // (post-rename, no entry); a 200 here would mean the swallow regressed.
    expect(response.status).not.toBe(200);

    // Recovery journal is still on disk (operation threw → envelope did
    // not clear it). Disk root may or may not have been moved depending
    // on tracedRenameSync timing — either way, recovery converges.
    delete process.env.OK_TEST_RENAME_FAULT;
    rmSync(jsonlPath, { recursive: true, force: true }); // unblock the next boot's writes
    const recoveryResult = recoverPendingManagedRename(contentDir);
    expect(recoveryResult.recovered).toBe(true);

    // Final state: pre-rename disk + no log entry. The (post-rename,
    // no-entry) inconsistency Goal G5 forbids never materialized.
    expect(existsSync(resolve(contentDir, 'a.md'))).toBe(true);
    expect(existsSync(resolve(contentDir, 'b.md'))).toBe(false);

    // jsonl now exists as a regular file (or doesn't exist) — never
    // contains the half-applied entry.
    if (existsSync(jsonlPath)) {
      const raw = readFileSync(jsonlPath, 'utf-8');
      expect(raw).toBe('');
    }
  });
});

describe('FR12 ordering invariant — pre-journal-clear crash window', () => {
  test('crash AFTER log append → orphan entry; boot recovery + sweepLazyPopOrphans converge to consistent state', async () => {
    process.env.OK_TEST_RENAME_FAULT = 'pre-journal-clear';

    const response = await callRename({
      kind: 'file',
      fromPath: 'a.md',
      toPath: 'b.md',
      agentId: 'claude-1',
    });
    expect(response.status).not.toBe(200);

    // After the crash, the jsonl carries the orphan entry with empty commitSha
    if (!shadowRef.current) throw new Error('shadow missing');
    const jsonlPath = resolve(shadowRef.current.gitDir, 'renames.jsonl');
    expect(existsSync(jsonlPath)).toBe(true);
    const raw = readFileSync(jsonlPath, 'utf-8');
    expect(raw.length).toBeGreaterThan(0);
    const entries = raw.split('\n').filter((l) => l.length > 0);
    expect(entries).toHaveLength(1);
    const parsed = JSON.parse(entries[0]);
    expect(parsed.from).toBe('a');
    expect(parsed.to).toBe('b');
    expect(parsed.commitSha).toBe(''); // orphan — the post-success backfill never ran

    // Next-boot recovery: drop the fault, run journal recovery + lazy-pop sweep
    delete process.env.OK_TEST_RENAME_FAULT;
    const recoveryResult = recoverPendingManagedRename(contentDir);
    expect(recoveryResult.recovered).toBe(true);

    // Disk should be back to pre-rename
    expect(existsSync(resolve(contentDir, 'a.md'))).toBe(true);
    expect(existsSync(resolve(contentDir, 'b.md'))).toBe(false);

    // Sweep the orphan
    const index = loadRenameLogIndex(shadowRef.current.gitDir);
    expect(index.byTo.size).toBe(1); // entry exists
    const sweepResult = sweepLazyPopOrphans(shadowRef.current.gitDir, index);
    expect(sweepResult.dropped).toBe(1);
    expect(index.byTo.size).toBe(0);

    // Final state on disk: pre-rename (a.md only) + no log entry
    const finalRaw = readFileSync(jsonlPath, 'utf-8');
    expect(finalRaw).toBe('');
  });
});
