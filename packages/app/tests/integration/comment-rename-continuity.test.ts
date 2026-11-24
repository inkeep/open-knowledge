import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HocuspocusProvider } from '@hocuspocus/provider';
import {
  CC1DerivedViewPayloadSchema,
  CommentThreadMetaSchema,
  RenamePathSuccessSchema,
  SYSTEM_DOC_NAME,
  ThreadListSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { expect, test } from 'vitest';
import * as Y from 'yjs';
import { removeAllStrictDuringTeardown, runTeardownPhases } from '../stress/_helpers/teardown-fs';
import {
  createTestClient,
  createTestServer,
  pollUntil,
  type TestServer,
  waitForSync,
} from './test-harness';

const SOURCE = 'source-note';
const DESTINATION = 'moved-note';
const PASSAGE = 'A passage in the note.';
const CONTENT = `# Note\n\n${PASSAGE}\n`;
const COMMENT = 'Keep this comment with the note.';

function post(server: TestServer, path: string, body: unknown, signal: AbortSignal) {
  return fetch(`${server.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

function watchCommentSignals(port: number) {
  const doc = new Y.Doc();
  const seqs: number[] = [];
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}/collab`,
    name: SYSTEM_DOC_NAME,
    document: doc,
    onStateless: ({ payload }) => {
      const signal = CC1DerivedViewPayloadSchema.safeParse(JSON.parse(payload));
      if (signal.success && signal.data.ch === 'comments') seqs.push(signal.data.seq);
    },
  });
  const destroy = async () => {
    provider.destroy();
    doc.destroy();
  };
  return { provider, seqs, destroy };
}

async function listThreads(server: TestServer, docName: string, signal: AbortSignal) {
  const response = await fetch(
    `${server.baseUrl}/api/comments?doc=${encodeURIComponent(docName)}`,
    {
      signal,
    },
  );
  expect(response.status).toBe(200);
  const { threads } = ThreadListSuccessSchema.parse(await response.json());
  return threads.map(({ threadId, docName, latestComment }) => ({
    threadId,
    docName,
    latestComment,
  }));
}

test.for(['filesystem', 'managed'] as const)(
  'keeps the same comment thread after a %s rename and server restart',
  async (method, { onTestFinished, signal }) => {
    const contentDir = mkdtempSync(join(tmpdir(), 'ok-comment-rename-'));
    const cleanups: Array<() => Promise<void>> = [];
    const stopServer = () => runTeardownPhases(...cleanups.splice(0).reverse());
    onTestFinished(() =>
      runTeardownPhases(stopServer, () => removeAllStrictDuringTeardown(contentDir)),
    );

    mkdirSync(join(contentDir, '.ok'));
    writeFileSync(join(contentDir, '.ok', 'config.yml'), '');
    writeFileSync(join(contentDir, `${SOURCE}.md`), CONTENT);

    const server = await createTestServer({ contentDir, keepContentDir: true });
    cleanups.push(server.cleanup);
    const commentSignals = watchCommentSignals(server.port);
    cleanups.push(commentSignals.destroy);
    await waitForSync(commentSignals.provider);
    const created = await post(
      server,
      '/api/comments',
      { docName: SOURCE, quote: PASSAGE, body: COMMENT },
      signal,
    );
    expect(created.status).toBe(201);
    const { threadId } = CommentThreadMetaSchema.parse(await created.json());
    expect(await listThreads(server, SOURCE, signal)).toEqual([
      { threadId, docName: SOURCE, latestComment: COMMENT },
    ]);

    if (method === 'filesystem') {
      const client = await createTestClient(server.port, SOURCE, {
        resetOnCleanup: false,
        skipInvariantWatcher: true,
      });
      cleanups.push(client.cleanup);
      expect(client.ytext.toString()).toBe(CONTENT);
      expect(client.provider.isAuthenticated).toBe(true);
      await pollUntil(
        () => commentSignals.seqs.length > 0,
        10_000,
        25,
        'the comments signal for the new thread',
      );
      const seqBeforeRename = Math.max(...commentSignals.seqs);

      renameSync(join(contentDir, `${SOURCE}.md`), join(contentDir, `${DESTINATION}.md`));
      await pollUntil(
        () => {
          signal.throwIfAborted();
          const lifecycle = server.instance.hocuspocus.documents.get(SOURCE)?.getMap('lifecycle');
          return (
            lifecycle?.get('status') === 'renamed' &&
            lifecycle.get('newPath') === DESTINATION &&
            !client.provider.isAuthenticated
          );
        },
        10_000,
        25,
        'the watcher to recognize the move and close the source connection',
      );
      await pollUntil(
        () => commentSignals.seqs.some((seq) => seq > seqBeforeRename),
        10_000,
        25,
        'a comments signal for the renamed thread',
      );
    } else {
      const moved = await post(
        server,
        '/api/rename-path',
        { kind: 'file', fromPath: SOURCE, toPath: DESTINATION },
        signal,
      );
      expect(moved.status).toBe(200);
      expect(RenamePathSuccessSchema.parse(await moved.json()).renamed).toEqual([
        { fromDocName: SOURCE, toDocName: DESTINATION },
      ]);
    }

    const live = await listThreads(server, DESTINATION, signal);
    await stopServer();
    signal.throwIfAborted();
    const restarted = await createTestServer({ contentDir, keepContentDir: true });
    cleanups.push(restarted.cleanup);
    const afterRestart = await listThreads(restarted, DESTINATION, signal);

    const expected = [{ threadId, docName: DESTINATION, latestComment: COMMENT }];
    expect({ live, afterRestart }).toEqual({ live: expected, afterRestart: expected });
  },
);
