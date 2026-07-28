import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import simpleGit, { type SimpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { resolveUpstreamChanges } from './server-factory.ts';

/**
 * Unit coverage for the Timeline upstream-author recovery helper. A git pull
 * moves HEAD over an `oldHead..newHead` range; the helper maps each changed
 * `.md`/`.mdx` doc to the newest non-merge commit author that touched it, so the
 * reconcile can be attributed to a real author instead of the "File System"
 * writer.
 */
describe('resolveUpstreamChanges', () => {
  let dir: string;
  let git: SimpleGit;

  async function commitAs(name: string, email: string, file: string, body: string) {
    writeFileSync(join(dir, file), body);
    await git.add(file);
    await git
      .env({
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
      })
      .commit(`edit ${file}`);
    return (await git.revparse('HEAD')).trim();
  }

  beforeEach(async () => {
    dir = mkdtempSync(resolve(tmpdir(), 'ok-upstream-changes-'));
    git = simpleGit(dir);
    await git.init(['-b', 'main']);
    await git.addConfig('user.name', 'Seed');
    await git.addConfig('user.email', 'seed@example.com');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('maps a single incoming commit to its author', async () => {
    const oldHead = await commitAs('Seed', 'seed@example.com', 'bugs.md', 'v0');
    const newHead = await commitAs('Ana Dev', 'ana@example.com', 'bugs.md', 'v1');

    const changes = resolveUpstreamChanges(dir, dir, oldHead, newHead);
    expect(changes.get('bugs')).toEqual({ name: 'Ana Dev', email: 'ana@example.com' });
  });

  test('maps a non-ASCII (Unicode) filename to its author', async () => {
    // git quotes non-ASCII paths as "caf\303\251.md" under the default
    // core.quotePath=true; resolveUpstreamChanges must disable that so the
    // path maps to a real docName instead of falling back to file-system.
    const oldHead = await commitAs('Seed', 'seed@example.com', 'café.md', 'v0');
    const newHead = await commitAs('Ana Dev', 'ana@example.com', 'café.md', 'v1');

    const changes = resolveUpstreamChanges(dir, dir, oldHead, newHead);
    expect(changes.get('café')).toEqual({ name: 'Ana Dev', email: 'ana@example.com' });
  });

  test('maps each doc to the newest author that touched it', async () => {
    const oldHead = await commitAs('Seed', 'seed@example.com', 'bugs.md', 'v0');
    await commitAs('Ana Dev', 'ana@example.com', 'bugs.md', 'v1');
    const newHead = await commitAs('Ben Dev', 'ben@example.com', 'notes.md', 'n1');

    const changes = resolveUpstreamChanges(dir, dir, oldHead, newHead);
    expect(changes.get('bugs')).toEqual({ name: 'Ana Dev', email: 'ana@example.com' });
    expect(changes.get('notes')).toEqual({ name: 'Ben Dev', email: 'ben@example.com' });
  });

  test('skips the merge commit and attributes to the content author', async () => {
    const base = await commitAs('Seed', 'seed@example.com', 'bugs.md', 'v0');
    const startBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    await git.checkoutLocalBranch('feature');
    await commitAs('Ana Dev', 'ana@example.com', 'feature.md', 'f1');
    await git.checkout(startBranch);
    await git
      .env({
        GIT_AUTHOR_NAME: 'Merger',
        GIT_AUTHOR_EMAIL: 'merger@example.com',
        GIT_COMMITTER_NAME: 'Merger',
        GIT_COMMITTER_EMAIL: 'merger@example.com',
      })
      .merge(['--no-ff', 'feature']);
    const newHead = (await git.revparse('HEAD')).trim();

    const changes = resolveUpstreamChanges(dir, dir, base, newHead);
    expect(changes.get('feature')).toEqual({ name: 'Ana Dev', email: 'ana@example.com' });
  });

  test('ignores non-markdown files', async () => {
    const oldHead = await commitAs('Seed', 'seed@example.com', 'bugs.md', 'v0');
    const newHead = await commitAs('Ana Dev', 'ana@example.com', 'data.json', '{}');

    const changes = resolveUpstreamChanges(dir, dir, oldHead, newHead);
    expect(changes.has('data')).toBe(false);
    expect(changes.size).toBe(0);
  });

  test('returns an empty map when oldHead is absent', async () => {
    const newHead = await commitAs('Ana Dev', 'ana@example.com', 'bugs.md', 'v1');
    expect(resolveUpstreamChanges(dir, dir, null, newHead).size).toBe(0);
  });
});
