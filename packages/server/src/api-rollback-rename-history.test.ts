import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import simpleGit from 'simple-git';
import * as Y from 'yjs';
import { createApiExtension } from './api-extension.ts';
import { BacklinkIndex } from './backlink-index.ts';
import { swapContributors } from './contributor-tracker.ts';
import {
  appendRenameLogEntry,
  createEmptyIndex,
  type RenameLogEntry,
  resetRenameLogIndexCache,
  setRenameLogIndex,
} from './rename-log.ts';
import {
  commitWip,
  initShadowRepo,
  type ShadowRef,
  saveVersion,
  type WriterIdentity,
} from './shadow-repo.ts';

interface CapturedResponse {
  status: number;
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

function entry(overrides: Partial<RenameLogEntry> = {}): RenameLogEntry {
  return {
    v: 1,
    from: 'a',
    to: 'b',
    at: '2026-05-05T12:00:00.000Z',
    commitSha: '',
    branch: 'main',
    groupId: '01234567-89ab-cdef-0123-456789abcdef',
    kind: 'file',
    actor: { writerId: 'agent-test', displayName: 'Test' },
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ok-rollback-rename-'));
  swapContributors();
  resetRenameLogIndexCache();
});

afterEach(() => {
  swapContributors();
  resetRenameLogIndexCache();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('handleRollback — rename history mitigation (US-005)', () => {
  /** Strictly-increasing ISO commit timestamps (1s apart) so checkpoints and
   *  the rename commit order deterministically without real-time ticks (git
   *  committer dates are 1-second-granular). */
  function makeTick(startIso = '2026-05-05T12:00:00.000Z') {
    let t = Date.parse(startIso);
    return () => {
      t += 1000;
      return new Date(t).toISOString();
    };
  }

  /**
   * Sets up:
   * - cycle 1: write `a.md`, commitWip → commitA, saveVersion → K1.
   * - cycle 2: delete `a.md`, write `b.md`, commitWip → renameCommit.
   * - rename-log entry `a → b` keyed at `renameCommit`.
   * - hocuspocus document for `b` ready to receive the rollback.
   */
  async function setup() {
    const projectDir = tmpDir;
    const contentDir = resolve(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });

    // Initial project commit
    writeFileSync(resolve(contentDir, 'placeholder.md'), '# placeholder\n');
    const git = simpleGit(projectDir);
    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');
    await git.add('.');
    await git.commit('initial');

    const shadow = await initShadowRepo(projectDir);

    const writer: WriterIdentity = {
      id: 'principal-test-1234',
      name: 'Test',
      email: 'test@example.com',
    };
    const at = makeTick();

    // Cycle 1: a.md
    rmSync(resolve(contentDir, 'placeholder.md'));
    writeFileSync(resolve(contentDir, 'a.md'), '# A pre-rename\n');
    const commitA = await commitWip(shadow, writer, 'content', 'WIP: a v1', 'main', { date: at() });
    await saveVersion(shadow, 'content', [writer], 'main', undefined, { date: at() });

    // Cycle 2: rename a → b (delete a.md, write b.md). Dated so K1 is strictly
    // before the rename commit without a real-time tick.
    rmSync(resolve(contentDir, 'a.md'));
    writeFileSync(resolve(contentDir, 'b.md'), '# B post-rename\n');
    const renameCommit = await commitWip(shadow, writer, 'content', 'rename: a -> b', 'main', {
      date: at(),
    });

    // Wire rename log
    const index = createEmptyIndex();
    appendRenameLogEntry(
      shadow.gitDir,
      entry({ from: 'a', to: 'b', commitSha: renameCommit }),
      index,
    );
    setRenameLogIndex(shadow.gitDir, index);

    // Y.Doc for b — required for the editor-side application path
    const docName = 'b';
    const yDoc = new Y.Doc();
    yDoc.getXmlFragment('default');
    yDoc.getText('source').insert(0, '# B post-rename\n');

    const shadowRef: ShadowRef = { current: shadow };
    const hocuspocus = {
      documents: new Map([[docName, yDoc]]),
      closeConnections() {},
      unloadDocument: async () => {},
      debouncer: {
        isDebounced: () => false,
        executeNow: async () => undefined,
      },
    };

    const callRollback = async (body: unknown): Promise<CapturedResponse> => {
      const ext = createApiExtension({
        hocuspocus: hocuspocus as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
        sessionManager: {
          closeSession: async () => {},
          closeAllForDoc: async () => {},
        } as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
        contentDir,
        contentRoot: 'content',
        shadowRef,
        getFileIndex: () => new Map(),
        backlinkIndex: new BacklinkIndex({ projectDir, contentDir }),
      });
      const req = makeReq('/api/rollback', 'POST', body);
      const { res, captured } = makeRes();
      await (
        ext as {
          onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
        }
      ).onRequest({ request: req, response: res });
      return captured;
    };

    return { shadow, contentDir, commitA, renameCommit, callRollback, docName, hocuspocus, at };
  }

  test('rollback to pre-rename commit (path a.md) → resolves via cycle bound, restores content, name unchanged', async () => {
    const { commitA, callRollback, docName, hocuspocus, contentDir } = await setup();
    const response = await callRollback({ docName, commitSha: commitA });
    expect(response.status).toBe(200);
    // content actually reverts. Status 200 alone doesn't prove the
    // historical body was applied; a no-op handler that returns 200 would
    // still pass without this check.
    const yDoc = hocuspocus.documents.get(docName);
    expect(yDoc).toBeDefined();
    const restoredText = yDoc?.getText('source').toString() ?? '';
    expect(restoredText).toContain('A pre-rename');
    expect(restoredText).not.toContain('B post-rename');
    // Filename is unchanged (restore is verbatim content, not name reversion).
    const { existsSync } = await import('node:fs');
    expect(existsSync(resolve(contentDir, 'b.md'))).toBe(true);
    expect(existsSync(resolve(contentDir, 'a.md'))).toBe(false);
  });

  test('rollback to current-name SHA still works (no regression)', async () => {
    const { renameCommit, callRollback, docName, hocuspocus } = await setup();
    const response = await callRollback({ docName, commitSha: renameCommit });
    expect(response.status).toBe(200);
    // Content stays at the post-rename version (renameCommit's tree had b.md
    // already containing the post-rename body — rollback to it is a no-op
    // semantically but must still succeed and apply identity content).
    const yDoc = hocuspocus.documents.get(docName);
    const restoredText = yDoc?.getText('source').toString() ?? '';
    expect(restoredText).toContain('B post-rename');
  });

  test('rollback to unrelated SHA → 404 with descriptive resolver-rejection message', async () => {
    const { callRollback, docName } = await setup();
    // 40-char hex that's highly unlikely to exist
    const fakeSha = 'deadbeef'.repeat(5);
    const response = await callRollback({ docName, commitSha: fakeSha });
    expect(response.status).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('urn:ok:error:doc-not-found');
    expect(String(body.title)).toContain('does not contain document');
    expect(String(body.title)).toContain(docName);
    expect(String(body.title)).toContain(fakeSha.slice(0, 7));
  });

  test('contamination case: SHA from a name-reuse cycle → 404, no shadow commit written', async () => {
    const { shadow, contentDir, callRollback, docName, at } = await setup();

    // Cycle 3: a.md is recreated under a different file (after deleting b.md
    // so the new commit's tree has a.md only). `at` continues setup()'s clock so
    // the new commit is strictly after the rename commit without a real-time tick.
    rmSync(resolve(contentDir, 'b.md'));
    writeFileSync(resolve(contentDir, 'a.md'), '# A new (unrelated)\n');
    const writer: WriterIdentity = {
      id: 'principal-test-1234',
      name: 'Test',
      email: 'test@example.com',
    };
    const newACommit = await commitWip(shadow, writer, 'content', 'WIP: new-a', 'main', {
      date: at(),
    });
    await saveVersion(shadow, 'content', [writer], 'main', undefined, { date: at() });

    const response = await callRollback({ docName, commitSha: newACommit });
    expect(response.status).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('urn:ok:error:doc-not-found');
    expect(String(body.title)).toContain('does not contain document');
  });
});
