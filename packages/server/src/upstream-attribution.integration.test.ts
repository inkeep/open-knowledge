import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import simpleGit, { type SimpleGit } from 'simple-git';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { __resetContributorsForTests as resetContributorsForTest } from './contributor-tracker.ts';
import { createServer, type ServerInstance } from './server-factory.ts';
import { initShadowRepo, type ShadowHandle, shadowGit } from './shadow-repo.ts';
import { getDocumentHistory } from './timeline-query.ts';

let dir: string;
let git: SimpleGit;
let shadow: ShadowHandle;
let server: ServerInstance | null = null;

async function commitAs(name: string, email: string, file: string, body: string) {
  writeFileSync(resolve(dir, file), body);
  await git.add(file);
  await git
    .env({
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    })
    .commit(`edit ${file}`);
}

beforeEach(async () => {
  resetContributorsForTest();
  dir = mkdtempSync(resolve(tmpdir(), 'ok-upstream-attr-int-'));
  git = simpleGit(dir);
  await git.init(['-b', 'main']);
  await git.addConfig('user.name', 'Seed');
  await git.addConfig('user.email', 'seed@example.com');
  await commitAs('Seed', 'seed@example.com', 'bugs.md', '# Bugs\n\ninitial\n');
  await git.checkoutLocalBranch('incoming');
  await commitAs(
    'Ana Dev',
    'ana@example.com',
    'bugs.md',
    '# Bugs\n\ninitial\n\nAna added this line\n',
  );
  await git.checkout('main');
  shadow = await initShadowRepo(dir);
});

afterEach(async () => {
  await server?.destroy().catch(() => {});
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

test('merge while doc is open attributes the reconcile to the incoming author', async () => {
  server = createServer({
    contentDir: dir,
    projectDir: dir,
    contentRoot: '.',
    quiet: true,
    debounce: 200,
    shadowRepo: shadow,
  });
  await server.ready;

  const conn = await server.hocuspocus.openDirectConnection('bugs');

  await git.merge(['--no-ff', '-m', 'merge incoming', 'incoming']);

  const sg = shadowGit(shadow);
  let reconcileLine = '';
  let reconcileSha = '';
  for (let i = 0; i < 40; i++) {
    const log = (await sg.raw('log', '--all', '--format=%H %an | %s')).trim();
    const match = log.split('\n').find((l) => l.slice(41).startsWith('Ana Dev | reconcile:'));
    if (match) {
      reconcileSha = match.slice(0, 40);
      reconcileLine = match.slice(41);
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  const body = reconcileSha ? await sg.raw('log', '-1', '--format=%b', reconcileSha) : '';

  await conn.disconnect?.();

  expect(reconcileLine).toMatch(/^Ana Dev \| reconcile: bugs$/);
  expect(body).toContain('ana@example.com');
}, 20_000);

test('a multi-author pull attributes each doc to its own author', async () => {
  await git.checkout('incoming');
  await commitAs('Ben Dev', 'ben@example.com', 'notes.md', '# Notes\n\nBen wrote this\n');
  await git.checkout('main');

  server = createServer({
    contentDir: dir,
    projectDir: dir,
    contentRoot: '.',
    quiet: true,
    debounce: 200,
    shadowRepo: shadow,
  });
  await server.ready;

  await git.merge(['--no-ff', '-m', 'merge incoming', 'incoming']);

  const sg = shadowGit(shadow);
  let log = '';
  for (let i = 0; i < 40; i++) {
    log = (await sg.raw('log', '--all', '--format=%an | %s')).trim();
    if (/Ana Dev \| reconcile:/.test(log) && /Ben Dev \| reconcile:/.test(log)) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const lines = log.split('\n');
  expect(lines).toContain('Ana Dev | reconcile: bugs');
  expect(lines).toContain('Ben Dev | reconcile: notes');

  const authorsFor = async (docName: string) => {
    const hist = await getDocumentHistory(shadow, { docName, limit: 20 }, '.');
    return hist.entries.flatMap((e) => e.contributors.map((c) => c.name));
  };
  const bugsAuthors = await authorsFor('bugs');
  const notesAuthors = await authorsFor('notes');
  expect(bugsAuthors).toContain('Ana Dev');
  expect(bugsAuthors).not.toContain('Ben Dev');
  expect(notesAuthors).toContain('Ben Dev');
  expect(notesAuthors).not.toContain('Ana Dev');
}, 20_000);
