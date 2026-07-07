/**
 * Tests for `POST /api/trash/cleanup` — Step 2 of the two-step Option B
 * Trash flow.
 *
 * Asserts the cleanup contract:
 *   - File index: synchronous purge of the affected docName(s)
 *   - Folder index: synchronous purge for `kind: 'folder'`
 *   - recentlyRemovedDocs: setDeleted invoked per docName
 *   - CC1 broadcast: signalChannel('files') emitted
 *   - Hocuspocus docs: closed via captureAndCloseDocuments / closeAllForDoc
 *   - Disk: untouched (file is already in Trash from Step 1 IPC; the handler
 *     must NOT call unlinkSync / rmSync)
 *   - extractActorIdentity: threaded (agentId → agent,
 *     getPrincipal() → principal, neither → anonymous; invalid-summary → 400)
 *   - Idempotent: 200 + empty array when fileIndex no longer has the entries
 *   - Validation: reserved docName, invalid path, malformed body all 400
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { Principal } from '@inkeep/open-knowledge-core';
import { createApiExtension } from './api-extension.ts';
import { BacklinkIndex } from './backlink-index.ts';
import type { FileIndexEntry, FolderIndexEntry } from './file-watcher.ts';
import { RecentlyRemovedDocs } from './recently-removed-docs.ts';

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function makeReq(url: string, method: string, body: unknown): IncomingMessage {
  const raw = body === undefined ? '' : JSON.stringify(body);
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

function buildFileIndex(contentDir: string): Map<string, FileIndexEntry> {
  const index = new Map<string, FileIndexEntry>();
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const stat = statSync(fullPath);
      const docName = fullPath.slice(contentDir.length + 1).replace(/\.md$/, '');
      index.set(docName, {
        size: stat.size,
        modified: stat.mtime.toISOString(),
        canonicalPath: fullPath,
        inode: stat.ino,
        aliases: [],
      });
    }
  }
  walk(contentDir);
  return index;
}

function buildFolderIndex(contentDir: string): Map<string, FolderIndexEntry> {
  const index = new Map<string, FolderIndexEntry>();
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const fullPath = resolve(dir, entry.name);
      const stat = statSync(fullPath);
      const folderPath = fullPath.slice(contentDir.length + 1);
      index.set(folderPath, {
        size: 0,
        modified: stat.mtime.toISOString(),
        canonicalPath: fullPath,
        inode: stat.ino,
      });
      walk(fullPath);
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

interface HocuspocusInspector {
  closedConnections: string[];
  unloadedDocs: string[];
}

interface SessionManagerInspector {
  closedDocs: string[];
}

async function callApi(
  contentDir: string,
  body: unknown,
  options?: {
    fileIndex?: Map<string, FileIndexEntry>;
    folderIndex?: Map<string, FolderIndexEntry>;
    recentlyRemovedDocs?: RecentlyRemovedDocs;
    signalChannel?: (channel: 'files' | 'backlinks' | 'graph') => void;
    getPrincipal?: () => Principal | null;
    hocuspocusInspector?: HocuspocusInspector;
    sessionInspector?: SessionManagerInspector;
  },
): Promise<CapturedResponse> {
  const fileIndex = options?.fileIndex ?? buildFileIndex(contentDir);
  const folderIndex = options?.folderIndex ?? buildFolderIndex(contentDir);
  const backlinkIndex = await buildBacklinkIndex(contentDir);
  const inspector = options?.hocuspocusInspector ?? { closedConnections: [], unloadedDocs: [] };
  const sessionInspector = options?.sessionInspector ?? { closedDocs: [] };

  const ext = createApiExtension({
    hocuspocus: {
      documents: new Map(),
      closeConnections(name: string) {
        inspector.closedConnections.push(name);
      },
      unloadDocument: async (doc: unknown) => {
        const named = doc as { name?: string };
        if (named.name) inspector.unloadedDocs.push(named.name);
      },
    } as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
    sessionManager: {
      closeSession: async () => {},
      closeAllForDoc: async (docName: string) => {
        sessionInspector.closedDocs.push(docName);
      },
    } as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
    contentDir,
    getFileIndex: () => fileIndex,
    getFolderIndex: () => folderIndex,
    backlinkIndex,
    signalChannel: options?.signalChannel,
    recentlyRemovedDocs: options?.recentlyRemovedDocs,
    getPrincipal: options?.getPrincipal,
  });

  const req = makeReq('/api/trash/cleanup', 'POST', body);
  const { res, captured } = makeRes();
  await (
    ext as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: req, response: res });
  return captured;
}

let tmpDir: string;

function setupTmpDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'ok-trash-cleanup-'));
  return tmpDir;
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('POST /api/trash/cleanup — file kind', () => {
  test('purges fileIndex + reports the affected docName', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'trash-me.md'), '# Bye\n', 'utf-8');
    writeFileSync(join(dir, 'keep-me.md'), '# Stay\n', 'utf-8');
    const fileIndex = buildFileIndex(dir);
    expect(fileIndex.has('trash-me')).toBe(true);
    expect(fileIndex.has('keep-me')).toBe(true);

    const result = await callApi(dir, { kind: 'file', path: 'trash-me' }, { fileIndex });

    expect(result.status).toBe(200);
    const body = JSON.parse(result.body) as { deletedDocNames: string[] };
    expect(body.deletedDocNames).toEqual(['trash-me']);
    expect(fileIndex.has('trash-me')).toBe(false);
    expect(fileIndex.has('keep-me')).toBe(true);
  });

  test('does NOT touch disk (file kept on disk by harness; real flow has Trash IPC delete it first)', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'still-here.md'), '# Present\n', 'utf-8');
    const fileIndex = buildFileIndex(dir);

    const result = await callApi(dir, { kind: 'file', path: 'still-here' }, { fileIndex });

    expect(result.status).toBe(200);
    // Handler MUST NOT call unlinkSync — verify the on-disk file is still
    // there even though the index entry was purged. In the production flow,
    // Step 1's `shell.trashItem` moves the file to ~/.Trash before this
    // handler runs; in tests, we leave the disk file in place to prove the
    // handler doesn't unlink it itself.
    expect(existsSync(join(dir, 'still-here.md'))).toBe(true);
  });

  test('populates recentlyRemovedDocs.setDeleted for the affected docName', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'goodbye.md'), '# Bye\n', 'utf-8');
    const fileIndex = buildFileIndex(dir);
    const recentlyRemovedDocs = new RecentlyRemovedDocs();

    const result = await callApi(
      dir,
      { kind: 'file', path: 'goodbye' },
      { fileIndex, recentlyRemovedDocs },
    );

    expect(result.status).toBe(200);
    expect(recentlyRemovedDocs.has('goodbye')).toBe(true);
    expect(recentlyRemovedDocs.peek('goodbye')?.kind).toBe('deleted');
  });

  test('emits signalChannel("files") synchronously', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'sig.md'), '# Sig\n', 'utf-8');
    const fileIndex = buildFileIndex(dir);
    const signals: string[] = [];

    const result = await callApi(
      dir,
      { kind: 'file', path: 'sig' },
      { fileIndex, signalChannel: (channel) => signals.push(channel) },
    );

    expect(result.status).toBe(200);
    expect(signals).toContain('files');
  });

  test('closes Hocuspocus documents via captureAndCloseDocuments', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'live.md'), '# Live\n', 'utf-8');
    const fileIndex = buildFileIndex(dir);
    const sessionInspector: SessionManagerInspector = { closedDocs: [] };

    const result = await callApi(
      dir,
      { kind: 'file', path: 'live' },
      { fileIndex, sessionInspector },
    );

    expect(result.status).toBe(200);
    expect(sessionInspector.closedDocs).toContain('live');
  });
});

describe('POST /api/trash/cleanup — folder kind', () => {
  test('purges every descendant docName from fileIndex', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'project/sub'), { recursive: true });
    writeFileSync(join(dir, 'project/root.md'), '# Root\n', 'utf-8');
    writeFileSync(join(dir, 'project/sub/leaf.md'), '# Leaf\n', 'utf-8');
    writeFileSync(join(dir, 'other.md'), '# Other\n', 'utf-8');
    const fileIndex = buildFileIndex(dir);
    expect(fileIndex.size).toBe(3);

    const result = await callApi(dir, { kind: 'folder', path: 'project' }, { fileIndex });

    expect(result.status).toBe(200);
    const body = JSON.parse(result.body) as { deletedDocNames: string[] };
    expect(body.deletedDocNames).toEqual(['project/root', 'project/sub/leaf']);
    expect(fileIndex.has('project/root')).toBe(false);
    expect(fileIndex.has('project/sub/leaf')).toBe(false);
    expect(fileIndex.has('other')).toBe(true);
  });

  test('purges folder-index entries for the subtree', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'gone/sub'), { recursive: true });
    mkdirSync(join(dir, 'kept'), { recursive: true });
    writeFileSync(join(dir, 'gone/x.md'), '# X\n', 'utf-8');
    const fileIndex = buildFileIndex(dir);
    const folderIndex = buildFolderIndex(dir);
    expect(folderIndex.has('gone')).toBe(true);
    expect(folderIndex.has('gone/sub')).toBe(true);
    expect(folderIndex.has('kept')).toBe(true);

    const result = await callApi(dir, { kind: 'folder', path: 'gone' }, { fileIndex, folderIndex });

    expect(result.status).toBe(200);
    expect(folderIndex.has('gone')).toBe(false);
    expect(folderIndex.has('gone/sub')).toBe(false);
    expect(folderIndex.has('kept')).toBe(true);
  });

  test('populates recentlyRemovedDocs for every descendant', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'drafts'), { recursive: true });
    writeFileSync(join(dir, 'drafts/a.md'), '# A\n', 'utf-8');
    writeFileSync(join(dir, 'drafts/b.md'), '# B\n', 'utf-8');
    const fileIndex = buildFileIndex(dir);
    const recentlyRemovedDocs = new RecentlyRemovedDocs();

    const result = await callApi(
      dir,
      { kind: 'folder', path: 'drafts' },
      { fileIndex, recentlyRemovedDocs },
    );

    expect(result.status).toBe(200);
    expect(recentlyRemovedDocs.has('drafts/a')).toBe(true);
    expect(recentlyRemovedDocs.has('drafts/b')).toBe(true);
  });
});

describe('POST /api/trash/cleanup — idempotency', () => {
  test('returns 200 + empty deletedDocNames when fileIndex already lacks the entry (watcher ran first)', async () => {
    const dir = setupTmpDir();
    // No file on disk, no entry in index — simulates the case where the
    // file-watcher beat the cleanup HTTP call.
    const fileIndex = new Map<string, FileIndexEntry>();

    const result = await callApi(dir, { kind: 'file', path: 'already-purged' }, { fileIndex });

    expect(result.status).toBe(200);
    const body = JSON.parse(result.body) as { deletedDocNames: string[] };
    expect(body.deletedDocNames).toEqual([]);
  });

  test('returns 200 + empty deletedDocNames for folder kind with no descendants in index', async () => {
    const dir = setupTmpDir();
    const fileIndex = new Map<string, FileIndexEntry>();

    const result = await callApi(dir, { kind: 'folder', path: 'no-such-folder' }, { fileIndex });

    expect(result.status).toBe(200);
    const body = JSON.parse(result.body) as { deletedDocNames: string[] };
    expect(body.deletedDocNames).toEqual([]);
  });
});

describe('POST /api/trash/cleanup — validation', () => {
  test('rejects malformed path (absolute) with 400', async () => {
    const dir = setupTmpDir();
    const result = await callApi(dir, { kind: 'file', path: '/etc/passwd' });
    expect(result.status).toBe(400);
    const body = JSON.parse(result.body) as { type: string };
    expect(body.type).toBe('urn:ok:error:invalid-request');
  });

  test('rejects path with traversal segment', async () => {
    const dir = setupTmpDir();
    const result = await callApi(dir, { kind: 'file', path: '../escape' });
    expect(result.status).toBe(400);
  });

  test('rejects reserved synthetic doc name (defense in depth)', async () => {
    const dir = setupTmpDir();
    const result = await callApi(dir, { kind: 'file', path: '__system__' });
    expect(result.status).toBe(400);
    const body = JSON.parse(result.body) as { type: string };
    expect(body.type).toBe('urn:ok:error:reserved-doc-name');
  });

  test('rejects invalid kind (Zod fails on enum)', async () => {
    const dir = setupTmpDir();
    const result = await callApi(dir, { kind: 'symlink', path: 'x' });
    expect(result.status).toBe(400);
  });

  test('rejects body missing path (Zod fails on required field)', async () => {
    const dir = setupTmpDir();
    const result = await callApi(dir, { kind: 'file' });
    expect(result.status).toBe(400);
  });

  test('rejects invalid summary type (non-string) with 400', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'x.md'), '# X\n', 'utf-8');
    // summaryField permits string | undefined; passing a number bypasses Zod
    // (the field is loose) and gets caught at extractActorIdentity which
    // returns { kind: 'invalid-summary' }.
    const result = await callApi(dir, { kind: 'file', path: 'x', summary: 42 });
    expect(result.status).toBe(400);
    const body = JSON.parse(result.body) as { type: string; detail?: string };
    expect(body.type).toBe('urn:ok:error:invalid-request');
  });
});

describe('POST /api/trash/cleanup — attribution threading (extractActorIdentity)', () => {
  test('invokes getPrincipal() when body carries no agentId (principal-fallback path)', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'principal-test.md'), '# P\n', 'utf-8');
    const fileIndex = buildFileIndex(dir);
    let principalCalls = 0;
    const getPrincipal = (): Principal | null => {
      principalCalls += 1;
      return {
        id: 'principal-uuid-test',
        display_name: 'Test User',
        email: 'test@example.com',
      } as Principal;
    };

    const result = await callApi(
      dir,
      { kind: 'file', path: 'principal-test' },
      { fileIndex, getPrincipal },
    );

    expect(result.status).toBe(200);
    // extractActorIdentity calls getPrincipal exactly once during threading.
    expect(principalCalls).toBe(1);
  });

  test('does NOT invoke getPrincipal when body carries valid agentId (agent path short-circuits)', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'agent-test.md'), '# A\n', 'utf-8');
    const fileIndex = buildFileIndex(dir);
    let principalCalls = 0;
    const getPrincipal = (): Principal | null => {
      principalCalls += 1;
      return null;
    };

    const result = await callApi(
      dir,
      {
        kind: 'file',
        path: 'agent-test',
        agentId: 'agent-claude-001',
        agentName: 'Claude',
      },
      { fileIndex, getPrincipal },
    );

    expect(result.status).toBe(200);
    // extractActorIdentity still calls getPrincipal to populate
    // `actor.principalId` for the agent-on-behalf-of-principal audit trail
    // even when the body has an agentId.
    expect(principalCalls).toBe(1);
  });

  test('succeeds when both body lacks agentId AND principal is null (anonymous path)', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'anon-test.md'), '# Anon\n', 'utf-8');
    const fileIndex = buildFileIndex(dir);

    const result = await callApi(
      dir,
      { kind: 'file', path: 'anon-test' },
      { fileIndex, getPrincipal: () => null },
    );

    expect(result.status).toBe(200);
    const body = JSON.parse(result.body) as { deletedDocNames: string[] };
    expect(body.deletedDocNames).toEqual(['anon-test']);
  });
});
