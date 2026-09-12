import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { DocumentDurabilityStateError } from '../../../server/src/document-durability-state';
import { writeTracker } from '../../../server/src/file-watcher';
import { contentHash } from '../../../server/src/version-hash';
import {
  agentWriteMd,
  createTestClient,
  createTestServer,
  getServerState,
  pollUntil,
  readTestDoc,
  type TestServer,
  wait,
} from './test-harness';

const ACK_MARKER = 'ACK-APPEND-MARKER';
const STALE_WRITE_DELAY_MS = 200;

let server: TestServer | undefined;
let ownedProjectDir: string | undefined;

afterEach(async () => {
  if (server) {
    await server.cleanup();
    server = undefined;
  }
  if (ownedProjectDir) {
    rmSync(ownedProjectDir, { recursive: true, force: true });
    ownedProjectDir = undefined;
  }
});

async function acknowledgeWrite(
  target: TestServer,
  docName: string,
): Promise<{ stale: string; acknowledged: string }> {
  await agentWriteMd(
    target.port,
    '---\ntags: [stale-write-test]\n---\n\n# Doc\n\noriginal-body\n',
    { docName, position: 'replace' },
  );
  await pollUntil(() => readTestDoc(target.contentDir, docName).includes('original-body'));
  const stale = readTestDoc(target.contentDir, docName);
  await agentWriteMd(target.port, `${ACK_MARKER}\n`, { docName, position: 'append' });
  await pollUntil(() => readTestDoc(target.contentDir, docName).includes(ACK_MARKER));
  const file = join(target.contentDir, `${docName}.md`);
  await pollUntil(
    () => !writeTracker.get(file)?.some((entry) => entry.hash === contentHash(stale)),
  );
  return { stale, acknowledged: readTestDoc(target.contentDir, docName) };
}

async function restoreStale(target: TestServer, docName: string, stale: string): Promise<void> {
  writeFileSync(join(target.contentDir, `${docName}.md`), stale, 'utf-8');
  await pollUntil(
    () => target.instance.durabilityState.getStaleExternalWrite(docName) !== undefined,
  );
}

async function resolveConflict(
  target: TestServer,
  file: string,
  strategy: string,
  content?: string,
): Promise<Response> {
  return fetch(`${target.baseUrl}/api/sync/resolve-conflict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file, strategy, content }),
  });
}

async function unloadDocument(target: TestServer, docName: string): Promise<void> {
  await target.instance.sessionManager.closeAllForDoc(docName);
  const hocuspocus = target.instance.hocuspocus;
  const document = hocuspocus.documents.get(docName);
  if (!document) throw new Error(`document ${docName} not loaded`);
  const shouldUnload = hocuspocus.shouldUnloadDocument;
  hocuspocus.shouldUnloadDocument = (candidate) =>
    candidate === document || shouldUnload.call(hocuspocus, candidate);
  try {
    await hocuspocus.unloadDocument(document);
  } finally {
    hocuspocus.shouldUnloadDocument = shouldUnload;
  }
}

function lifecycleOf(target: TestServer, docName: string): { status?: unknown; reason?: unknown } {
  const document = target.instance.hocuspocus.documents.get(docName);
  if (!document) throw new Error(`document ${docName} not loaded`);
  const lifecycle = document.getMap('lifecycle');
  return { status: lifecycle.get('status'), reason: lifecycle.get('reason') };
}

describe('stale external write does not roll back an acknowledged agent write', () => {
  test.each([false, true])(
    'resolves nonempty stale sides to an explicit empty file (unloaded=%s)',
    async (unloaded) => {
      server = await createTestServer();
      const docName = 'explicit-empty';
      const { stale } = await acknowledgeWrite(server, docName);
      await restoreStale(server, docName, stale);
      if (unloaded) await unloadDocument(server, docName);
      const response = await resolveConflict(server, `${docName}.md`, 'content', '');
      expect(response.status).toBe(200);
      expect(existsSync(join(server.contentDir, `${docName}.md`))).toBe(true);
      expect(readTestDoc(server.contentDir, docName)).toBe('');
      expect(server.instance.durabilityState.getStaleExternalWrite(docName)).toBeUndefined();
      const client = await createTestClient(server.port, docName);
      try {
        expect(client.ytext.toString()).toBe('');
      } finally {
        await client.cleanup();
      }
    },
  );
  test('a corrupt recovery snapshot stops startup with actionable diagnostics and preserves bytes', async () => {
    ownedProjectDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-stale-boot-')));
    const snapshot = join(ownedProjectDir, '.ok', 'local', 'stale-external-writes.json');
    mkdirSync(join(ownedProjectDir, '.ok', 'local'), { recursive: true });
    const raw = '{protected edits, truncated';
    writeFileSync(snapshot, raw);
    await expect(
      createTestServer({ contentDir: ownedProjectDir, configHomedirOverride: ownedProjectDir }),
    ).rejects.toThrow(DocumentDurabilityStateError);
    expect(readFileSync(snapshot, 'utf-8')).toBe(raw);
  });

  test('a shareable template stale conflict can be listed, read and resolved', async () => {
    server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    const docName = '.ok/templates/stale-template';
    const file = `${docName}.md`;
    mkdirSync(join(server.contentDir, '.ok', 'templates'), { recursive: true });
    writeFileSync(join(server.contentDir, file), 'rejected\n');
    const state = server.instance.durabilityState;
    state.setReconciledBase(docName, 'acknowledged\n');
    state.recordStaleExternalWrite(docName, 'rejected\n');
    const list = await (await fetch(`${server.baseUrl}/api/sync/conflicts`)).json();
    expect(list.conflicts).toContainEqual(expect.objectContaining({ file }));
    const response = await fetch(
      `${server.baseUrl}/api/sync/conflict-content?file=${encodeURIComponent(file)}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ours: 'acknowledged\n', theirs: 'rejected\n' });
    expect((await resolveConflict(server, file, 'mine')).status).toBe(200);
    expect(readFileSync(join(server.contentDir, file), 'utf-8')).toBe('acknowledged\n');
    expect(state.getStaleExternalWrite(docName)).toBeUndefined();
  });

  test('an unloaded late-write snapshot exposes and restores the retained candidate', async () => {
    server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    const docName = `retained-${randomUUID()}`;
    const state = server.instance.durabilityState;
    const retained = 'acknowledged\n\nnext edit retained\n';
    writeFileSync(join(server.contentDir, `${docName}.md`), 'rejected\n');
    state.setReconciledBase(docName, 'acknowledged\n');
    state.recordStaleExternalWrite(docName, 'rejected\n', retained);
    const sides = await (
      await fetch(`${server.baseUrl}/api/sync/conflict-content?file=${docName}.md`)
    ).json();
    expect(sides.ours).toBe(retained);
    expect((await resolveConflict(server, `${docName}.md`, 'mine')).status).toBe(200);
    expect(readTestDoc(server.contentDir, docName)).toBe(retained);
  });
  test.each(['mine', 'content'])(
    'a repeated stale save after %s remains protected',
    async (strategy) => {
      server = await createTestServer({ debounce: 50, maxDebounce: 200 });
      const docName = `repeat-${randomUUID()}`;
      const { stale, acknowledged } = await acknowledgeWrite(server, docName);
      await restoreStale(server, docName, stale);
      expect((await resolveConflict(server, `${docName}.md`, strategy, acknowledged)).status).toBe(
        200,
      );
      expect(lifecycleOf(server, docName).status).toBeUndefined();
      await restoreStale(server, docName, stale);
      expect(lifecycleOf(server, docName).status).toBe('conflict');
      expect(getServerState(server, docName)?.ytext.toString()).toBe(acknowledged);
    },
  );

  test.each(['theirs', 'delete'])(
    '%s resolves the stale conflict and updates disk and lifecycle',
    async (strategy) => {
      server = await createTestServer({ debounce: 50, maxDebounce: 200 });
      const docName = `resolve-${randomUUID()}`;
      const { stale } = await acknowledgeWrite(server, docName);
      await restoreStale(server, docName, stale);
      expect((await resolveConflict(server, `${docName}.md`, strategy)).status).toBe(200);
      expect(server.instance.durabilityState.listStaleExternalWrites()).toEqual([]);
      expect(server.instance.durabilityState.isDisplacedVersion(docName, stale)).toBe(false);
      if (strategy === 'delete') {
        expect(existsSync(join(server.contentDir, `${docName}.md`))).toBe(false);
        expect(lifecycleOf(server, docName).status).toBe('deleted-upstream');
        const tags = await (await fetch(`${server.baseUrl}/api/tags/stale-write-test`)).json();
        expect(tags.docs.map((entry: { docName: string }) => entry.docName)).not.toContain(docName);
      } else {
        expect(readTestDoc(server.contentDir, docName)).toBe(stale);
        expect(getServerState(server, docName)?.ytext.toString()).toBe(stale);
        expect(lifecycleOf(server, docName).status).toBeUndefined();
      }
    },
  );

  test('an unloaded stale write is listed, and delete then restore starts fresh', async () => {
    server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    const docName = `unloaded-${randomUUID()}`;
    const { stale, acknowledged } = await acknowledgeWrite(server, docName);
    await unloadDocument(server, docName);
    await restoreStale(server, docName, stale);
    expect(server.instance.hocuspocus.documents.has(docName)).toBe(false);
    const conflicts = await (await fetch(`${server.baseUrl}/api/sync/conflicts`)).json();
    expect(conflicts.conflicts).toContainEqual(expect.objectContaining({ file: `${docName}.md` }));
    const sides = await (
      await fetch(`${server.baseUrl}/api/sync/conflict-content?file=${docName}.md`)
    ).json();
    expect(sides.ours).toBe(acknowledged);
    unlinkSync(join(server.contentDir, `${docName}.md`));
    await pollUntil(
      () => server?.instance.durabilityState.getReconciledBase(docName) === undefined,
    );
    expect(server.instance.durabilityState.listStaleExternalWrites()).toEqual([]);
    writeFileSync(join(server.contentDir, `${docName}.md`), stale, 'utf-8');
    const client = await createTestClient(server.port, docName);
    try {
      expect(client.ytext.toString()).toBe(stale);
      expect(lifecycleOf(server, docName).status).toBeUndefined();
      expect(server.instance.durabilityState.getReconciledBase(docName)).toBe(stale);
      await pollUntil(async () => {
        const tags = await (await fetch(`${server?.baseUrl}/api/tags/stale-write-test`)).json();
        return tags.docs.some((entry: { docName: string }) => entry.docName === docName);
      });
    } finally {
      await client.cleanup();
    }
  });

  test('conflict paths round-trip when content is a project subdirectory', async () => {
    ownedProjectDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-stale-subdir-')));
    const contentDir = join(ownedProjectDir, 'notes');
    mkdirSync(contentDir);
    server = await createTestServer({
      contentDir,
      projectDir: ownedProjectDir,
      debounce: 50,
      maxDebounce: 200,
    });
    const docName = `subdir-${randomUUID()}`;
    const { stale } = await acknowledgeWrite(server, docName);
    await restoreStale(server, docName, stale);
    const list = await (await fetch(`${server.baseUrl}/api/sync/conflicts`)).json();
    const file = `notes/${docName}.md`;
    expect(list.conflicts).toContainEqual(expect.objectContaining({ file }));
    const response = await fetch(
      `${server.baseUrl}/api/sync/conflict-content?file=${encodeURIComponent(file)}`,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).ours).toContain(ACK_MARKER);
    expect((await resolveConflict(server, file, 'mine')).status).toBe(200);
    expect(readTestDoc(contentDir, docName)).toContain(ACK_MARKER);
  });

  test('resolution preserves an in-tree symlink and restores a missing file from recorded theirs', async () => {
    server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    const docName = `alias-${randomUUID()}`;
    const target = join(server.contentDir, `${docName}-target.md`);
    const alias = join(server.contentDir, `${docName}.md`);
    writeFileSync(target, 'stale\n');
    symlinkSync(target, alias);
    const state = server.instance.durabilityState;
    state.setReconciledBase(docName, 'acknowledged\n');
    state.recordDisplacedVersion(docName, 'stale\n');
    state.recordStaleExternalWrite(docName, 'stale\n');
    expect((await resolveConflict(server, `${docName}.md`, 'mine')).status).toBe(200);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe('acknowledged\n');
    const missingDoc = `missing-${randomUUID()}`;
    state.setReconciledBase(missingDoc, 'acknowledged\n');
    state.recordStaleExternalWrite(missingDoc, 'stale\n');
    expect((await resolveConflict(server, `${missingDoc}.md`, 'theirs')).status).toBe(200);
    expect(readTestDoc(server.contentDir, missingDoc)).toBe('stale\n');
    const danglingDoc = `dangling-${randomUUID()}`;
    const danglingTarget = join(server.contentDir, `${danglingDoc}-target.md`);
    const danglingAlias = join(server.contentDir, `${danglingDoc}.md`);
    symlinkSync(danglingTarget, danglingAlias);
    state.setReconciledBase(danglingDoc, 'acknowledged\n');
    state.recordStaleExternalWrite(danglingDoc, 'stale\n');
    expect((await resolveConflict(server, `${danglingDoc}.md`, 'theirs')).status).toBe(200);
    expect(lstatSync(danglingAlias).isSymbolicLink()).toBe(true);
    expect(readFileSync(danglingTarget, 'utf-8')).toBe('stale\n');
    expect(state.listStaleExternalWrites()).toEqual([]);
  });

  test('a failed disk write leaves the acknowledged document and conflict unchanged', async () => {
    server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    const docName = `directory-${randomUUID()}`;
    const file = join(server.contentDir, `${docName}.md`);
    mkdirSync(file);
    const state = server.instance.durabilityState;
    state.setReconciledBase(docName, 'acknowledged\n');
    state.recordStaleExternalWrite(docName, 'stale\n');
    const failed = await resolveConflict(server, `${docName}.md`, 'content', 'replacement\n');
    expect(failed.status).toBe(500);
    expect(state.getReconciledBase(docName)).toBe('acknowledged\n');
    expect(state.getStaleExternalWrite(docName)?.diskContent).toBe('stale\n');
    expect(lstatSync(file).isDirectory()).toBe(true);
    rmSync(file, { recursive: true });
    expect((await resolveConflict(server, `${docName}.md`, 'mine')).status).toBe(200);
    expect(readTestDoc(server.contentDir, docName)).toBe('acknowledged\n');
  });

  test.each(['mine', 'delete'])(
    'a durability filesystem failure during %s keeps the conflict retryable',
    async (strategy) => {
      server = await createTestServer({ debounce: 50, maxDebounce: 200 });
      const docName = `retry-${randomUUID()}`;
      const { stale, acknowledged } = await acknowledgeWrite(server, docName);
      await restoreStale(server, docName, stale);
      const statePath = join(server.instance.lockDir, 'stale-external-writes.json');
      renameSync(statePath, `${statePath}.backup`);
      mkdirSync(statePath);
      const failed = await resolveConflict(server, `${docName}.md`, strategy);
      expect(failed.status).toBe(500);
      expect((await failed.json()).detail).toBeTruthy();
      expect(server.instance.durabilityState.getStaleExternalWrite(docName)).toBeDefined();
      expect(lifecycleOf(server, docName).status).toBe('conflict');
      if (strategy === 'mine') expect(readTestDoc(server.contentDir, docName)).toBe(acknowledged);
      else expect(existsSync(join(server.contentDir, `${docName}.md`))).toBe(false);
      rmSync(statePath, { recursive: true });
      renameSync(`${statePath}.backup`, statePath);
      expect((await resolveConflict(server, `${docName}.md`, 'mine')).status).toBe(200);
      expect(server.instance.durabilityState.getStaleExternalWrite(docName)).toBeUndefined();
      expect(lifecycleOf(server, docName).status).toBeUndefined();
    },
  );

  test('resolution refuses an escaping symlink without modifying its target', async () => {
    ownedProjectDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-stale-outside-')));
    server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    const docName = `escape-${randomUUID()}`;
    const outside = join(ownedProjectDir, 'outside.md');
    writeFileSync(outside, 'outside\n');
    symlinkSync(outside, join(server.contentDir, `${docName}.md`));
    const state = server.instance.durabilityState;
    state.setReconciledBase(docName, 'acknowledged\n');
    state.recordStaleExternalWrite(docName, 'stale\n');
    for (const strategy of ['mine', 'theirs', 'content', 'delete']) {
      const response = await resolveConflict(server, `${docName}.md`, strategy, 'replacement\n');
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        status: 400,
        type: 'urn:ok:error:path-escape',
      });
      expect(readFileSync(outside, 'utf-8')).toBe('outside\n');
      expect(state.getStaleExternalWrite(docName)).toBeDefined();
    }
  });
  test('exact pre-write bytes restored on disk keep the acknowledged append and conflict the doc', async () => {
    server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    const { port, contentDir } = server;
    const docName = `stale-rollback-${randomUUID()}`;

    await agentWriteMd(port, '# Doc\n\noriginal-body\n', { docName, position: 'replace' });
    await pollUntil(() => readTestDoc(contentDir, docName).includes('original-body'));
    const staleBytes = readTestDoc(contentDir, docName);

    await agentWriteMd(port, `${ACK_MARKER}\n`, { docName, position: 'append' });
    await pollUntil(() => readTestDoc(contentDir, docName).includes(ACK_MARKER));

    await wait(STALE_WRITE_DELAY_MS);
    writeFileSync(join(contentDir, `${docName}.md`), staleBytes, 'utf-8');

    await pollUntil(
      () => lifecycleOf(server as TestServer, docName).status === 'conflict',
      10_000,
      100,
      'stale-write lifecycle conflict',
    );

    expect(lifecycleOf(server, docName).reason).toBe('stale-external-write');
    expect(getServerState(server, docName)?.ytext.toString()).toContain(ACK_MARKER);

    const retry = await fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, markdown: 'retry\n', position: 'append' }),
    });
    expect(retry.status).toBe(409);

    const conflictsResponse = await fetch(`http://127.0.0.1:${port}/api/sync/conflicts`);
    const conflicts = (await conflictsResponse.json()) as {
      conflicts: Array<{
        file: string;
        detectedAt: string;
        conflictKind?: 'git' | 'stale-external-write';
      }>;
    };
    expect(conflicts.conflicts).toContainEqual({
      file: `${docName}.md`,
      detectedAt: expect.any(String),
      conflictKind: 'stale-external-write',
    });

    const contentResponse = await fetch(
      `http://127.0.0.1:${port}/api/sync/conflict-content?file=${docName}.md&source=ytext`,
    );
    const sides = (await contentResponse.json()) as {
      ours: string;
      theirs: string;
      conflictKind?: 'git' | 'stale-external-write';
    };
    expect(sides.ours).toContain(ACK_MARKER);
    expect(sides.theirs).toBe(staleBytes);
    expect(sides.conflictKind).toBe('stale-external-write');

    for (const request of [
      { file: docName, strategy: 'mine' },
      {
        file: docName,
        strategy: 'content',
        content: '<<<<<<< current\ndraft\n=======\nstill unresolved\n>>>>>>> incoming\n',
      },
    ]) {
      const aliasResolution = await fetch(`http://127.0.0.1:${port}/api/sync/resolve-conflict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      expect(aliasResolution.status).toBe(404);
      expect(await aliasResolution.json()).toMatchObject({
        type: 'urn:ok:error:no-conflict-tracked',
      });
      expect(lifecycleOf(server, docName).status).toBe('conflict');
      expect(readTestDoc(contentDir, docName)).toBe(staleBytes);
      expect(getServerState(server, docName)?.ytext.toString()).toContain(ACK_MARKER);
    }

    const markerResolution = await fetch(`http://127.0.0.1:${port}/api/sync/resolve-conflict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file: `${docName}.md`,
        strategy: 'content',
        content: '<<<<<<< current\ndraft\n=======\nstill unresolved\n>>>>>>> incoming\n',
      }),
    });
    expect(markerResolution.status).toBe(422);
    expect(lifecycleOf(server, docName).status).toBe('conflict');

    const resolution = await fetch(`http://127.0.0.1:${port}/api/sync/resolve-conflict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file: `${docName}.md`,
        strategy: 'content',
        content: sides.ours,
      }),
    });
    expect(resolution.status).toBe(200);
    expect(readTestDoc(contentDir, docName)).toContain(ACK_MARKER);
    expect(lifecycleOf(server, docName).status).toBeUndefined();

    writeFileSync(join(contentDir, `${docName}.md`), staleBytes, 'utf-8');
    await pollUntil(
      () => lifecycleOf(server as TestServer, docName).status === 'conflict',
      10_000,
      100,
      'repeated stale-write lifecycle conflict',
    );

    const repeatedResolution = await fetch(`http://127.0.0.1:${port}/api/sync/resolve-conflict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file: `${docName}.md`,
        strategy: 'mine',
      }),
    });
    expect(repeatedResolution.status).toBe(200);

    await agentWriteMd(port, 'retry-after-resolution\n', { docName, position: 'append' });
    await pollUntil(() => readTestDoc(contentDir, docName).includes('retry-after-resolution'));
  });

  test('content resolution accepts a Setext heading and preserves the submitted bytes', async () => {
    server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    const docName = `setext-resolution-${randomUUID()}`;
    const { stale, acknowledged } = await acknowledgeWrite(server, docName);
    await restoreStale(server, docName, stale);

    const content = `Release notes\n=======\n\n${acknowledged}`;
    const response = await resolveConflict(server, `${docName}.md`, 'content', content);

    expect(response.status).toBe(200);
    expect(readTestDoc(server.contentDir, docName)).toBe(content);
    expect(getServerState(server, docName)?.ytext.toString()).toBe(content);
    expect(lifecycleOf(server, docName).status).toBeUndefined();
    expect(server.instance.durabilityState.getStaleExternalWrite(docName)).toBeUndefined();
  });

  test('an unrelated external edit still reconciles into the Y.Doc', async () => {
    server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    const { port, contentDir } = server;
    const docName = `unrelated-external-${randomUUID()}`;

    await agentWriteMd(port, '# Doc\n\noriginal-body\n', { docName, position: 'replace' });
    await pollUntil(() => readTestDoc(contentDir, docName).includes('original-body'));

    await agentWriteMd(port, `${ACK_MARKER}\n`, { docName, position: 'append' });
    await pollUntil(() => readTestDoc(contentDir, docName).includes(ACK_MARKER));

    await wait(STALE_WRITE_DELAY_MS);
    const settled = readTestDoc(contentDir, docName);
    writeFileSync(join(contentDir, `${docName}.md`), `${settled}\nEXTERNAL-EDIT-LINE\n`, 'utf-8');

    await pollUntil(
      () =>
        getServerState(server as TestServer, docName)
          ?.ytext.toString()
          .includes('EXTERNAL-EDIT-LINE') === true,
      10_000,
      100,
      'unrelated external edit applied',
    );

    expect(lifecycleOf(server, docName).status).toBeUndefined();
  });

  test('a restart keeps the acknowledged content and stale-write conflict', async () => {
    server = await createTestServer({
      debounce: 50,
      maxDebounce: 200,
      keepContentDir: true,
    });
    const docName = `stale-restart-${randomUUID()}`;
    const contentDir = server.contentDir;

    await agentWriteMd(server.port, '# Doc\n\noriginal-body\n', {
      docName,
      position: 'replace',
    });
    await pollUntil(() => readTestDoc(contentDir, docName).includes('original-body'));
    const staleBytes = readTestDoc(contentDir, docName);
    await agentWriteMd(server.port, `${ACK_MARKER}\n`, { docName, position: 'append' });
    await pollUntil(() => readTestDoc(contentDir, docName).includes(ACK_MARKER));
    await wait(STALE_WRITE_DELAY_MS);
    writeFileSync(join(contentDir, `${docName}.md`), staleBytes, 'utf-8');
    await pollUntil(
      () => lifecycleOf(server as TestServer, docName).status === 'conflict',
      10_000,
      100,
      'pre-restart stale-write lifecycle conflict',
    );

    await server.cleanup();
    server = undefined;
    server = await createTestServer({ contentDir, debounce: 50, maxDebounce: 200 });
    const client = await createTestClient(server.port, docName);
    try {
      expect(client.ytext.toString()).toContain(ACK_MARKER);
      expect(lifecycleOf(server, docName)).toEqual({
        status: 'conflict',
        reason: 'stale-external-write',
      });
    } finally {
      await client.cleanup();
    }
  });
});
