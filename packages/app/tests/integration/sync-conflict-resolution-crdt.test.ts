import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';
import { createTestClient, createTestServer, pollUntil, type TestServer } from './test-harness';

const BASE_CONTENT = '# Base\n\nBase paragraph.\n';
const THEIRS_CONTENT = '# Theirs\n\nTeam version.\n';
const CONFLICT_MARKERS =
  '<<<<<<< HEAD\n# Mine\n\nLocal version.\n=======\n# Theirs\n\nTeam version.\n>>>>>>> origin/main\n';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
}, 30_000);

async function setupServerWithDoc(docName: string, initial: string): Promise<TestServer> {
  const server = await createTestServer({ debounce: 100, maxDebounce: 500 });
  cleanups.push(() => server.cleanup());
  writeFileSync(join(server.contentDir, `${docName}.md`), initial, 'utf-8');
  await pollUntil(async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`).catch(() => null);
    if (!res?.ok) return false;
    const data = (await res.json()) as { documents?: Array<{ docName: string }> };
    return data.documents?.some((d) => d.docName === docName) ?? false;
  });
  return server;
}

describe('case "conflict" disk event -> CRDT lifecycle', () => {
  test('clears lifecycle.status after conflict resolves to theirs', async () => {
    const docName = `conflict-clear-${crypto.randomUUID()}`;
    const server = await setupServerWithDoc(docName, BASE_CONTENT);
    const client = await createTestClient(server.port, docName);
    cleanups.push(() => client.cleanup());

    await pollUntil(() => client.ytext.toString().includes('Base paragraph'));

    const lifecycle = client.doc.getMap('lifecycle');
    const filePath = join(server.contentDir, `${docName}.md`);

    writeFileSync(filePath, CONFLICT_MARKERS, 'utf-8');

    await pollUntil(() => lifecycle.get('status') === 'conflict', 10_000);

    writeFileSync(filePath, THEIRS_CONTENT, 'utf-8');

    await pollUntil(() => client.ytext.toString().includes('Team version'), 10_000);

    expect(client.ytext.toString()).toContain('Team version');
    expect(client.ytext.toString()).not.toContain('Base paragraph');

    await pollUntil(() => lifecycle.get('status') === undefined, 5000);
    expect(lifecycle.get('reason')).toBeUndefined();
  }, 30_000);

  test('clears lifecycle.status on noop reconcile (keep-mine path)', async () => {
    const docName = `conflict-noop-${crypto.randomUUID()}`;
    const server = await setupServerWithDoc(docName, BASE_CONTENT);
    const client = await createTestClient(server.port, docName);
    cleanups.push(() => client.cleanup());

    await pollUntil(() => client.ytext.toString().includes('Base paragraph'));

    const lifecycle = client.doc.getMap('lifecycle');
    const filePath = join(server.contentDir, `${docName}.md`);

    writeFileSync(filePath, CONFLICT_MARKERS, 'utf-8');
    await pollUntil(() => lifecycle.get('status') === 'conflict', 10_000);

    writeFileSync(filePath, BASE_CONTENT, 'utf-8');

    await pollUntil(() => lifecycle.get('status') === undefined, 5000);
    expect(lifecycle.get('reason')).toBeUndefined();
    expect(client.ytext.toString()).toContain('Base paragraph');
  }, 30_000);

  test('persistence does not overwrite conflict markers on disk during conflict', async () => {
    const docName = `conflict-persist-${crypto.randomUUID()}`;
    const server = await setupServerWithDoc(docName, BASE_CONTENT);
    const client = await createTestClient(server.port, docName);
    cleanups.push(() => client.cleanup());

    await pollUntil(() => client.ytext.toString().includes('Base paragraph'));

    const lifecycle = client.doc.getMap('lifecycle');
    const filePath = join(server.contentDir, `${docName}.md`);

    writeFileSync(filePath, CONFLICT_MARKERS, 'utf-8');
    await pollUntil(() => lifecycle.get('status') === 'conflict', 10_000);

    expect(readFileSync(filePath, 'utf-8')).toContain('<<<<<<<');

    client.doc.transact(() => {
      client.ytext.insert(client.ytext.length, '\n\nEdit during conflict.\n');
    });

    await pollUntil(() => {
      const serverDoc = server.instance.hocuspocus.documents.get(docName);
      return serverDoc?.getText('source').toString().includes('Edit during conflict') ?? false;
    }, 5000);

    await wait(1500);

    const diskNow = readFileSync(filePath, 'utf-8');
    expect(diskNow).toContain('<<<<<<<');
    expect(diskNow).toContain('=======');
    expect(diskNow).toContain('>>>>>>>');
    expect(diskNow).not.toContain('Edit during conflict');
  }, 30_000);
});

describe('case "conflicts" reconcile branch -> CRDT lifecycle', () => {
  test('case "conflicts" sets lifecycle.status="conflict" with reason "merged-with-markers"', async () => {
    const docName = `reconcile-conflicts-${crypto.randomUUID()}`;
    const baseContent = '# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n';
    const server = await createTestServer({ debounce: 60_000, maxDebounce: 60_000 });
    cleanups.push(() => server.cleanup());
    writeFileSync(join(server.contentDir, `${docName}.md`), baseContent, 'utf-8');
    await pollUntil(async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`).catch(() => null);
      if (!res?.ok) return false;
      const data = (await res.json()) as { documents?: Array<{ docName: string }> };
      return data.documents?.some((d) => d.docName === docName) ?? false;
    });

    const client = await createTestClient(server.port, docName);
    cleanups.push(() => client.cleanup());

    await pollUntil(() => client.ytext.toString().includes('First paragraph'));

    const lifecycle = client.doc.getMap('lifecycle');
    const filePath = join(server.contentDir, `${docName}.md`);

    const baseOffset = client.ytext.toString().indexOf('First paragraph.');
    const baseLen = 'First paragraph.'.length;
    client.doc.transact(() => {
      client.ytext.delete(baseOffset, baseLen);
      client.ytext.insert(baseOffset, 'Our version of first paragraph.');
    });

    await pollUntil(() => {
      const serverDoc = server.instance.hocuspocus.documents.get(docName);
      return serverDoc?.getText('source').toString().includes('Our version') ?? false;
    }, 5000);

    const theirsContent = '# Heading\n\nTheir version of first paragraph.\n\nSecond paragraph.\n';
    writeFileSync(filePath, theirsContent, 'utf-8');

    await pollUntil(() => lifecycle.get('status') === 'conflict', 10_000);

    expect(lifecycle.get('status')).toBe('conflict');
    expect(lifecycle.get('reason')).toBe('merged-with-markers');
  }, 30_000);
});

describe('FR7 + FR9: mutating handlers refuse with RFC 9457 slim 409 during conflict', () => {
  async function seedConflictedDoc(): Promise<{ docName: string; server: TestServer }> {
    const docName = `gate-${crypto.randomUUID()}`;
    const server = await setupServerWithDoc(docName, BASE_CONTENT);
    const client = await createTestClient(server.port, docName);
    cleanups.push(() => client.cleanup());
    await pollUntil(() => client.ytext.toString().includes('Base paragraph'));

    const filePath = join(server.contentDir, `${docName}.md`);
    writeFileSync(filePath, CONFLICT_MARKERS, 'utf-8');
    const lifecycle = client.doc.getMap('lifecycle');
    await pollUntil(() => lifecycle.get('status') === 'conflict', 10_000);
    return { docName, server };
  }

  async function expectDocInConflict409(
    res: Response,
    expectedFile: string,
  ): Promise<Record<string, unknown>> {
    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:doc-in-conflict');
    expect(body.title).toBe('Document is in conflict.');
    expect(body.status).toBe(409);
    expect(body.file).toBe(expectedFile);
    expect(body.resolutionOptions).toEqual(['mine', 'theirs', 'content', 'delete']);
    expect(body.base).toBeUndefined();
    expect(body.ours).toBeUndefined();
    expect(body.theirs).toBeUndefined();
    return body;
  }

  test('POST /api/agent-write returns 409 doc-in-conflict', async () => {
    const { docName, server } = await seedConflictedDoc();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        content: 'new content',
        agentId: 'a',
        agentName: 'A',
      }),
    });
    await expectDocInConflict409(res, `${docName}.md`);
  }, 30_000);

  test('POST /api/agent-write-md returns 409 doc-in-conflict', async () => {
    const { docName, server } = await seedConflictedDoc();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        markdown: '# Replacement\n',
        position: 'replace',
        agentId: 'a',
        agentName: 'A',
      }),
    });
    await expectDocInConflict409(res, `${docName}.md`);
  }, 30_000);

  test('POST /api/agent-patch returns 409 doc-in-conflict', async () => {
    const { docName, server } = await seedConflictedDoc();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-patch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        find: 'Base paragraph.',
        replace: 'Patched paragraph.',
        agentId: 'a',
        agentName: 'A',
      }),
    });
    await expectDocInConflict409(res, `${docName}.md`);
  }, 30_000);

  test('POST /api/agent-undo returns 409 doc-in-conflict', async () => {
    const { docName, server } = await seedConflictedDoc();
    await server.instance.sessionManager.getSession(docName, 'agent-undo-gate', {
      displayName: 'Undo Gate',
      colorSeed: 'u',
    });

    const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        connectionId: 'agent-undo-gate',
        agentId: 'agent-undo-gate',
        agentName: 'Undo Gate',
        scope: 'last',
      }),
    });
    await expectDocInConflict409(res, `${docName}.md`);
  }, 30_000);

  test('POST /api/rollback returns 409 doc-in-conflict', async () => {
    const { docName, server } = await seedConflictedDoc();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        commitSha: '0123456789abcdef0123456789abcdef01234567',
      }),
    });
    await expectDocInConflict409(res, `${docName}.md`);
  }, 30_000);

  test('POST /api/rename-path returns 409 doc-in-conflict when source is conflicted', async () => {
    const { docName, server } = await seedConflictedDoc();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/rename-path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'file',
        fromPath: `${docName}.md`,
        toPath: `renamed-${docName}.md`,
      }),
    });
    await expectDocInConflict409(res, `${docName}.md`);
  }, 30_000);

  test('POST /api/delete-path returns 409 doc-in-conflict when target is conflicted', async () => {
    const { docName, server } = await seedConflictedDoc();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/delete-path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'file',
        path: `${docName}.md`,
      }),
    });
    await expectDocInConflict409(res, `${docName}.md`);
  }, 30_000);

  async function seedConflictedDocInFolder(): Promise<{
    folder: string;
    childDocName: string;
    server: TestServer;
  }> {
    const folder = `folder-${crypto.randomUUID()}`;
    const childBase = `child-${crypto.randomUUID()}`;
    const childDocName = `${folder}/${childBase}`;
    const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-test-folderconflict-')));
    mkdirSync(join(contentDir, folder), { recursive: true });
    writeFileSync(join(contentDir, folder, `${childBase}.md`), BASE_CONTENT, 'utf-8');
    const server = await createTestServer({
      contentDir,
      keepContentDir: false,
      debounce: 100,
      maxDebounce: 500,
    });
    cleanups.push(() => server.cleanup());
    await pollUntil(async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`).catch(() => null);
      if (!res?.ok) return false;
      const data = (await res.json()) as { documents?: Array<{ docName: string }> };
      return data.documents?.some((d) => d.docName === childDocName) ?? false;
    }, 15_000);

    const client = await createTestClient(server.port, childDocName);
    cleanups.push(() => client.cleanup());
    await pollUntil(() => client.ytext.toString().includes('Base paragraph'));

    writeFileSync(join(server.contentDir, folder, `${childBase}.md`), CONFLICT_MARKERS, 'utf-8');
    const lifecycle = client.doc.getMap('lifecycle');
    await pollUntil(() => lifecycle.get('status') === 'conflict', 10_000);
    return { folder, childDocName, server };
  }

  test('POST /api/rename-path (folder) returns 409 when subtree contains a conflicted doc', async () => {
    const { folder, childDocName, server } = await seedConflictedDocInFolder();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/rename-path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'folder',
        fromPath: folder,
        toPath: `${folder}-renamed`,
      }),
    });
    await expectDocInConflict409(res, `${childDocName}.md`);
  }, 30_000);
});

describe('GET /api/sync/conflict-content?source=ytext', () => {
  test('returns Y.Text snapshot when source=ytext and snapshot is marker-free', async () => {
    const docName = `fr3-source-ytext-${crypto.randomUUID()}`;
    const server = await setupServerWithDoc(docName, BASE_CONTENT);
    const client = await createTestClient(server.port, docName);
    cleanups.push(() => client.cleanup());

    await pollUntil(() => client.ytext.toString().includes('Base paragraph'));

    const lifecycle = client.doc.getMap('lifecycle');
    const filePath = join(server.contentDir, `${docName}.md`);

    writeFileSync(filePath, CONFLICT_MARKERS, 'utf-8');
    await pollUntil(() => lifecycle.get('status') === 'conflict', 10_000);

    const midConflictMarker = '## Mid-conflict authored content\n';
    client.doc.transact(() => {
      client.ytext.insert(client.ytext.toString().length, midConflictMarker);
    });

    await pollUntil(() => {
      const serverDoc = server.instance.hocuspocus.documents.get(docName);
      return serverDoc?.getText('source').toString().includes(midConflictMarker) ?? false;
    }, 5000);

    const ytextRes = await fetch(
      `http://127.0.0.1:${server.port}/api/sync/conflict-content?file=${docName}.md&source=ytext`,
    );
    expect(ytextRes.ok).toBe(true);
    const ytextBody = (await ytextRes.json()) as {
      file: string;
      base: string;
      ours: string;
      theirs: string;
      lifecycleStatus: string | null;
    };
    expect(ytextBody.file).toBe(`${docName}.md`);
    expect(ytextBody.ours).toContain(midConflictMarker);
    expect(ytextBody.lifecycleStatus).toBe('conflict');

    const defaultRes = await fetch(
      `http://127.0.0.1:${server.port}/api/sync/conflict-content?file=${docName}.md`,
    );
    expect(defaultRes.ok).toBe(true);
    const defaultBody = (await defaultRes.json()) as { ours: string };
    expect(defaultBody.ours).not.toContain(midConflictMarker);
  }, 30_000);

  test('falls back to git-index ours when Y.Text snapshot contains conflict markers', async () => {
    const docName = `fr3-marker-fallback-${crypto.randomUUID()}`;
    const server = await setupServerWithDoc(docName, BASE_CONTENT);
    const client = await createTestClient(server.port, docName);
    cleanups.push(() => client.cleanup());

    await pollUntil(() => client.ytext.toString().includes('Base paragraph'));

    const lifecycle = client.doc.getMap('lifecycle');
    const filePath = join(server.contentDir, `${docName}.md`);

    writeFileSync(filePath, CONFLICT_MARKERS, 'utf-8');
    await pollUntil(() => lifecycle.get('status') === 'conflict', 10_000);

    client.doc.transact(() => {
      client.ytext.delete(0, client.ytext.toString().length);
      client.ytext.insert(0, CONFLICT_MARKERS);
    });
    await pollUntil(() => {
      const serverDoc = server.instance.hocuspocus.documents.get(docName);
      return serverDoc?.getText('source').toString().includes('<<<<<<<') ?? false;
    }, 5000);

    const ytextRes = await fetch(
      `http://127.0.0.1:${server.port}/api/sync/conflict-content?file=${docName}.md&source=ytext`,
    );
    expect(ytextRes.ok).toBe(true);
    const ytextBody = (await ytextRes.json()) as { ours: string; lifecycleStatus: string | null };
    expect(ytextBody.ours).not.toContain('<<<<<<<');
    expect(ytextBody.ours).not.toContain('=======');
    expect(ytextBody.ours).not.toContain('>>>>>>>');
    expect(ytextBody.lifecycleStatus).toBe('conflict');
  }, 30_000);
});
