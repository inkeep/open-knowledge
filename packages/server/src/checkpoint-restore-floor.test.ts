import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { extensionlessDocTreePath } from './doc-extensions.ts';
import {
  batchCheckExistence,
  createAncestorShaSetCache,
  createEmptyIndex,
  resolveDocPathAtCommit,
} from './rename-log.ts';
import {
  commitWip,
  initShadowRepo,
  type ShadowHandle,
  saveInMemoryCheckpoint,
  saveVersion,
  shadowGit,
  type WriterIdentity,
} from './shadow-repo.ts';
import { getDocumentHistory } from './timeline-query.ts';

const CONTENT_ROOT = 'content/docs';

const human: WriterIdentity = {
  id: 'human-ada',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
};

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-restore-floor-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function setup(): Promise<{ contentDir: string; shadow: ShadowHandle }> {
  const projectRoot = resolve(tmpDir, 'project');
  const contentDir = resolve(projectRoot, CONTENT_ROOT);
  mkdirSync(contentDir, { recursive: true });
  const git = simpleGit(projectRoot);
  await git.init();
  await git.raw('config', 'user.name', 'Test');
  await git.raw('config', 'user.email', 'test@test.com');
  writeFileSync(resolve(contentDir, 'intro.md'), '# Hello\n');
  await git.add('.');
  await git.commit('Initial commit');
  const shadow = await initShadowRepo(projectRoot);
  return { contentDir, shadow };
}

/**
 * The restore probe the API handlers build: extension-full disk path first
 * (full-tree checkpoints), then the extension-less docName tree path (the
 * single-blob trees `saveInMemoryCheckpoint` writes). Mirrors the handler
 * closures so this suite exercises the same two-shape resolution production
 * uses.
 */
function candidatesFor(name: string): readonly string[] {
  const full = `${CONTENT_ROOT}/${name}.md`;
  const extless = extensionlessDocTreePath(full, name);
  return extless ? [full, extless] : [full];
}

describe('extension-less silent checkpoint restore floor', () => {
  test('getDocumentHistory surfaces a silent bridge-merge-loss checkpoint row', async () => {
    const { contentDir, shadow } = await setup();
    writeFileSync(resolve(contentDir, 'intro.md'), '# Edited\n');
    await commitWip(shadow, human, CONTENT_ROOT, 'WIP: edit');

    // Production callers pass the extension-LESS Hocuspocus docName, so the
    // blob lands at `content/docs/intro` (no `.md`).
    const silentSha = await saveInMemoryCheckpoint(shadow, CONTENT_ROOT, {
      kind: 'bridge-merge-loss',
      docName: 'intro',
      contents: '# Pre-loss baseline\n',
      label: 'Before concurrent merge @ 2026-05-05T12:00:00Z',
      branch: 'main',
      metadata: { lostSubstrings: ['a lost keystroke'] },
    });

    const hist = await getDocumentHistory(shadow, { docName: 'intro' }, CONTENT_ROOT);
    const cpRow = hist.entries.find((e) => e.sha === silentSha);
    expect(cpRow).toBeDefined();
    expect(cpRow?.type).toBe('checkpoint');
    expect(cpRow?.checkpoint?.kind).toBe('bridge-merge-loss');
    expect(cpRow?.message).toContain('Before concurrent merge');
  });

  test('resolveDocPathAtCommit resolves the extension-less blob and git show reads the content', async () => {
    const { contentDir, shadow } = await setup();
    writeFileSync(resolve(contentDir, 'intro.md'), '# Edited\n');
    await commitWip(shadow, human, CONTENT_ROOT, 'WIP: edit');

    const silentSha = await saveInMemoryCheckpoint(shadow, CONTENT_ROOT, {
      kind: 'producer-guard-loss',
      docName: 'intro',
      contents: '# Rescued content\n',
      label: 'Before producer-guard content-loss @ 2026-05-05T12:00:00Z',
      branch: 'main',
      metadata: { construct: 'paragraph' },
    });

    const index = createEmptyIndex();
    const cache = createAncestorShaSetCache();
    const resolved = await resolveDocPathAtCommit(
      shadow,
      'intro',
      silentSha,
      'main',
      index,
      candidatesFor,
      cache,
    );
    expect(resolved).toBe(`${CONTENT_ROOT}/intro`);

    const content = (await shadowGit(shadow).raw('show', `${silentSha}:${resolved}`)).toString();
    expect(content).toBe('# Rescued content\n');
  });

  test('both shapes resolve: a full-tree Save Version still resolves via the extension-full path', async () => {
    const { contentDir, shadow } = await setup();
    writeFileSync(resolve(contentDir, 'intro.md'), '# Current disk state\n');
    const sv = await saveVersion(shadow, CONTENT_ROOT, [human], 'main');
    const svSha = sv.checkpointRef.match(/([0-9a-f]{40})$/)?.[1] ?? '';
    expect(svSha).toMatch(/^[0-9a-f]{40}$/);

    const index = createEmptyIndex();
    const cache = createAncestorShaSetCache();
    const resolved = await resolveDocPathAtCommit(
      shadow,
      'intro',
      svSha,
      'main',
      index,
      candidatesFor,
      cache,
    );
    // Full-tree snapshots mirror disk (extension-full); the extension-full
    // candidate is probed first, so it wins — no extension-less regression.
    expect(resolved).toBe(`${CONTENT_ROOT}/intro.md`);
  });

  test('batchCheckExistence counts only blobs — a directory sharing the doc name does not resolve', async () => {
    const { contentDir, shadow } = await setup();
    writeFileSync(resolve(contentDir, 'intro.md'), '# Current\n');
    const sv = await saveVersion(shadow, CONTENT_ROOT, [human], 'main');
    const svSha = sv.checkpointRef.match(/([0-9a-f]{40})$/)?.[1] ?? '';

    const res = await batchCheckExistence(shadow, [
      { sha: svSha, path: CONTENT_ROOT }, // a directory (tree), not the doc blob
      { sha: svSha, path: `${CONTENT_ROOT}/intro.md` }, // the doc blob
    ]);
    expect(res).toEqual([false, true]);
  });
});
