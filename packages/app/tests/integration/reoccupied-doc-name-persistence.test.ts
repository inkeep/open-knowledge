import { execSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureProjectGit } from '@inkeep/open-knowledge-server';
import { afterEach, describe, expect, test } from 'vitest';
import { configureTestGitRepository } from '../../../../test-support/configure-git-fixture.test-helper.ts';
import { post } from './rename-rebinding.test-helper.ts';
import {
  awaitFileWatcherIndexed,
  createInspectableServer,
  createTestClient,
  createTestServer,
  pollUntil,
  readTestDoc,
  type TestClient,
  type TestServer,
} from './test-harness.ts';

const BODY = [
  '# Index',
  '',
  '| Name | Note |',
  '| --- | --- |',
  '| alpha | one |',
  '| omega | two |',
  '',
].join('\n');

const RECREATED_BODY = [
  '# Index',
  '',
  '| Name | Note |',
  '| --- | --- |',
  '| recreated | new |',
  '| omega | two |',
  '',
].join('\n');

let server: TestServer | undefined;
const clients: TestClient[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (clients.length > 0)
    await clients
      .pop()
      ?.cleanup()
      .catch(() => {});
  await server?.cleanup().catch(() => {});
  server = undefined;
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function startWithOpenDoc(
  docName: string,
  otherDocs: Record<string, string> = {},
): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'ok-reoccupied-name-'));
  writeFileSync(join(dir, `${docName}.md`), BODY, 'utf-8');
  for (const [name, body] of Object.entries(otherDocs)) {
    writeFileSync(join(dir, `${name}.md`), body, 'utf-8');
  }
  const started = await createTestServer({ contentDir: dir });
  await awaitFileWatcherIndexed(started, docName);
  const client = await createTestClient(started.port, docName, { skipInvariantWatcher: true });
  clients.push(client);
  await pollUntil(() => client.ytext.toString().includes('| omega |'), 15_000);
  return started;
}

function diskPath(docName: string): string {
  if (!server) throw new Error('server not started');
  return join(server.contentDir, `${docName}.md`);
}

function lifecycleStatus(docName: string): unknown {
  return server?.instance.hocuspocus.documents.get(docName)?.getMap('lifecycle').get('status');
}

function residentSource(docName: string): string | undefined {
  return server?.instance.hocuspocus.documents.get(docName)?.getText('source').toString();
}

async function renameAwayOnDisk(docName: string, movedTo: string): Promise<void> {
  renameSync(diskPath(docName), diskPath(movedTo));
  await pollUntil(() => lifecycleStatus(docName) === 'renamed', 30_000, 100, 'the rename freeze');
}

async function expectOnDisk(contentDir: string, docName: string, text: string): Promise<void> {
  await pollUntil(
    () => readTestDoc(contentDir, docName).includes(text),
    30_000,
    100,
    `${docName}.md on disk to contain ${JSON.stringify(text)}`,
  );
}

function writeAsAgent(port: number, docName: string, markdown: string) {
  return post(port, '/api/agent-write-md', {
    docName,
    markdown,
    position: 'replace',
    agentId: 'reoccupied-name-test',
  });
}

function insertRowBeforeOmega(port: number, docName: string, row: string) {
  return post(port, '/api/agent-patch', {
    docName,
    find: '| omega |',
    replace: `${row}\n| omega |`,
    agentId: 'reoccupied-name-test',
  });
}

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test.local',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test.local',
    },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

describe('a document name re-occupied after an on-disk rename keeps persisting edits', () => {
  test('a file re-created on disk replaces the frozen content and takes agent edits (PRD-9321)', async () => {
    server = await startWithOpenDoc('Index');

    await renameAwayOnDisk('Index', 'Index-backup');
    writeFileSync(diskPath('Index'), RECREATED_BODY, 'utf-8');
    await pollUntil(
      () => residentSource('Index') === RECREATED_BODY,
      30_000,
      100,
      'the re-created file to replace the frozen content',
    );

    const edit = await insertRowBeforeOmega(server.port, 'Index', '| after-recreate | b |');
    expect(edit.status).toBe(200);
    await expectOnDisk(server.contentDir, 'Index', '| after-recreate | b |');
    expect(readTestDoc(server.contentDir, 'Index')).toContain('| recreated | new |');
  }, 120_000);

  test('a page re-created through create-page starts from its new file and persists edits (PRD-9329)', async () => {
    server = await startWithOpenDoc('Post');

    await renameAwayOnDisk('Post', 'Post-moved');
    const created = await post(server.port, '/api/create-page', { path: 'Post.md' });
    expect(created.status).toBeLessThan(300);
    expect(residentSource('Post')).toBe('');

    const write = await writeAsAgent(server.port, 'Post', '# Typed after re-create\n');
    expect(write.status).toBe(200);
    await expectOnDisk(server.contentDir, 'Post', '# Typed after re-create');
  }, 120_000);

  test('a managed rename onto the frozen name takes over that name and persists edits', async () => {
    server = await startWithOpenDoc('Note', { Draft: RECREATED_BODY });

    await renameAwayOnDisk('Note', 'Note-moved');
    const renamed = await post(server.port, '/api/rename-path', {
      kind: 'file',
      fromPath: 'Draft.md',
      toPath: 'Note.md',
    });
    expect(renamed.status).toBe(200);
    await pollUntil(
      () => residentSource('Note') === RECREATED_BODY,
      15_000,
      100,
      'the renamed file to replace the frozen content',
    );

    const edit = await insertRowBeforeOmega(server.port, 'Note', '| after-managed-rename | c |');
    expect(edit.status).toBe(200);
    await expectOnDisk(server.contentDir, 'Note', '| after-managed-rename | c |');
  }, 120_000);

  test('an agent write to a renamed-away name that is still absent is refused with its new path', async () => {
    server = await startWithOpenDoc('Gone');

    await renameAwayOnDisk('Gone', 'Gone-moved');

    const write = await writeAsAgent(server.port, 'Gone', '# Written to the old name\n');
    expect(write.status).toBe(409);
    expect(write.body).toMatchObject({
      type: 'urn:ok:error:doc-removed',
      title: 'Edit applied in memory; disk write refused because the document was renamed.',
      detail: expect.stringContaining('re-read the document at Gone-moved'),
    });
    expect(readTestDoc(server.contentDir, 'Gone')).toBe('');
  }, 120_000);
});

describe('switching back to a branch that has a tombstoned document', () => {
  test.runIf(process.platform !== 'win32')(
    'lets edits to that document reach disk again',
    async () => {
      const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-branch-switch-revive-')));
      cleanups.push(() => rmSync(contentDir, { recursive: true, force: true }));
      await ensureProjectGit(contentDir);
      configureTestGitRepository(contentDir);
      mkdirSync(join(contentDir, '.ok', 'local'), { recursive: true });
      writeFileSync(join(contentDir, '.ok', 'local', 'private.md'), '# Private\n', 'utf-8');
      writeFileSync(join(contentDir, 'note.md'), '# Note\n\nOn main.\n', 'utf-8');
      writeFileSync(join(contentDir, 'other.md'), '# Other\n\nOn main.\n', 'utf-8');
      git(contentDir, 'add note.md other.md');
      git(contentDir, 'commit -m main');
      git(contentDir, 'checkout -b feature');
      git(contentDir, 'rm -q note.md');
      symlinkSync('.ok/local/private.md', join(contentDir, 'note.md'));
      writeFileSync(join(contentDir, 'other.md'), '# Other\n\nOn feature.\n', 'utf-8');
      git(contentDir, 'add note.md other.md');
      git(contentDir, 'commit -m feature');
      git(contentDir, 'checkout main');

      const inspectable = await createInspectableServer({
        contentDir,
        keepContentDir: true,
        gitEnabled: true,
        commitDebounceMs: 500,
      });
      cleanups.push(() => inspectable.shutdown());
      const opened = new Map<string, TestClient>();
      for (const docName of ['note', 'other']) {
        const client = await createTestClient(inspectable.port, docName, {
          skipInvariantWatcher: true,
        });
        clients.push(client);
        opened.set(docName, client);
        await pollUntil(() => client.ytext.toString().includes('On main.'), 10_000, 50);
      }
      const serverDoc = (docName: string) => inspectable.instance.hocuspocus.documents.get(docName);
      const serverText = (docName: string): string =>
        serverDoc(docName)?.getText('source').toString() ?? '';

      git(contentDir, 'checkout feature');
      const noteStatus = () => serverDoc('note')?.getMap('lifecycle').get('status');
      await pollUntil(() => serverText('other').includes('On feature.'), 15_000, 50);
      await pollUntil(() => noteStatus() === 'deleted-upstream', 15_000, 50, 'the tombstone');
      const noteText = opened.get('note')?.ytext;
      noteText?.insert(noteText.length, '\nTyped while tombstoned.\n');
      await pollUntil(
        () => serverText('note').includes('Typed while tombstoned.'),
        15_000,
        50,
        'the tombstoned edit to reach the server',
      );

      git(contentDir, 'checkout main');
      await pollUntil(() => serverText('other').includes('On main.'), 15_000, 50);
      await pollUntil(
        () =>
          !inspectable.instance.durabilityState.isBatchInProgress() &&
          noteStatus() === undefined &&
          serverText('note') === '# Note\n\nOn main.\n',
        15_000,
        50,
        'the branch switch to finish with note revived to its file content',
      );
      expect(readTestDoc(contentDir, 'note')).toBe('# Note\n\nOn main.\n');

      const edit = await post(inspectable.port, '/api/agent-patch', {
        docName: 'note',
        find: 'On main.',
        replace: 'Edited after switching back.',
        agentId: 'reoccupied-name-test',
      });
      expect(edit.status).toBe(200);
      await expectOnDisk(contentDir, 'note', 'Edited after switching back.');
    },
    120_000,
  );
});
