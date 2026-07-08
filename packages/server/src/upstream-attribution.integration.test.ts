import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import simpleGit, { type SimpleGit } from 'simple-git';
import { __resetContributorsForTests as resetContributorsForTest } from './contributor-tracker.ts';
import { createServer, type ServerInstance } from './server-factory.ts';
import { initShadowRepo, type ShadowHandle, shadowGit } from './shadow-repo.ts';
import { getDocumentHistory } from './timeline-query.ts';

/**
 * End-to-end: a git merge (stand-in for `git pull`) that moves HEAD while a doc
 * is open should attribute the reconcile to the incoming commit's author, not
 * "File System". Drives the real createServer + head-watcher + file-watcher path.
 */
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
  // The pending-contributor accumulator is module-level and shared across every
  // test file in the process. A stale `file-system` entry leaked by an earlier
  // file would be drained into THIS test's shadow repo — and recordContributor's
  // last-subject-wins merge can stamp it with this test's `reconcile:` subject,
  // making the body assertions below match the wrong commit.
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

  // Load the doc so it is a live Y.Doc when the merge lands.
  const conn = await server.hocuspocus.openDirectConnection('bugs');

  // Merge the incoming branch — moves HEAD + rewrites bugs.md on disk.
  await git.merge(['--no-ff', '-m', 'merge incoming', 'incoming']);

  // Poll the shadow log for a reconcile commit whose git author is the incoming
  // commit's author (display name). The writer-bucket email is synthetic
  // (git-upstream@…) by design — the real email rides along as the ok-actor
  // color seed, asserted separately below.
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

  // The recovered git identity (real email) is carried on the ok-actor body line
  // as the color seed, not as the git-author email. Read the body by the SHA of
  // the commit found above — a `--grep` here can race a sibling drain commit
  // whose subject also says `reconcile: bugs` (e.g. the provisional file-system
  // entry) and return the wrong body.
  const body = reconcileSha ? await sg.raw('log', '-1', '--format=%b', reconcileSha) : '';

  await conn.disconnect?.();

  expect(reconcileLine).toMatch(/^Ana Dev \| reconcile: bugs$/);
  expect(body).toContain('ana@example.com');
}, 20_000);

test('a multi-author pull attributes each doc to its own author', async () => {
  // Add a second incoming commit by a different author touching a different doc,
  // so the merge range spans two authors (Ana → bugs, Ben → notes).
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
  // Each author gets their own reconcile commit — no collapse onto one name.
  expect(lines).toContain('Ana Dev | reconcile: bugs');
  expect(lines).toContain('Ben Dev | reconcile: notes');

  // The real fix: the per-doc Timeline query must attribute each doc to its own
  // author. Per-author writer refs make each commit diff against its own base,
  // so `bugs` surfaces Ana and `notes` surfaces Ben — not the collapse where a
  // shared ref's identical trees pinned both docs onto the oldest commit.
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
