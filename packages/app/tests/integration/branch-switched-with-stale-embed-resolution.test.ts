/**
 * Branch-switched cross-branch reseed-ordering regression gate.
 *
 * The cross-branch path in `server-factory.ts`'s `onBatchEnd` callback runs:
 *   1. Discard buffered file-watcher events.
 *   2. Reset every open Y.Doc from the new branch's disk via `applyToDoc` →
 *      `applyExternalChange` → mdast→PM with `resolveEmbed`.
 *   3. Then `basenameIndex.clear()` + `seedBasenameIndex()` for the new branch.
 *
 * The reseed at step 3 is the only mechanism by which post-batch
 * `basenameIndex` reflects the new branch's content (step 1 discards the
 * file-watcher's buffered create/delete events — they're "wrong-branch" state).
 * But the doc-reset at step 2 calls `resolveEmbed` against the STALE pre-switch
 * `basenameIndex`, so PM image `src` for `![[photo.png]]` carries the
 * pre-switch resolved path. The disk markdown is untouched (`![[photo.png]]`
 * round-trips byte-identical), but the rendered preview is stale until the
 * user edits the doc.
 *
 * Fix: move the reseed (step 3) to run BEFORE the doc-reset loop (step 2). The
 * test asserts the post-fix invariant: post-switch PM image `src` matches the
 * NEW branch's resolved path, not the pre-switch one.
 *
 * Composition boundary: head-watcher × git-batch detection × basenameIndex ×
 * applyToDoc × resolveEmbed. Not reachable from unit tests alone (would
 * require mocking 4+ collaborators). Not duplicated by the cross-branch
 * live-client test (which exercises cross-branch convergence on Y.Text
 * content but doesn't touch embeds) or by the restart-with-embed test
 * (server-restart × resolveEmbed, no branch switch).
 *
 * Hermetic: per-test tmpdir + per-test git repo + per-test docName.
 *
 * @see packages/server/src/server-factory.ts onBatchEnd cross-branch path
 * @see packages/app/tests/integration/branch-switch-live-client.test.ts
 * @see packages/app/tests/integration/restart-with-embed-doc.test.ts
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { ensureProjectGit } from '@inkeep/open-knowledge-server';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { ProviderPool } from '../../src/editor/provider-pool';
import { createRestartableServer, getServerState, pollUntil, schema } from './test-harness';

// ── Local helpers ─────────────────────────────────────────────────────

interface PmJsonNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: PmJsonNode[];
}

function collectNodes(json: PmJsonNode, type: string, out: PmJsonNode[] = []): PmJsonNode[] {
  if (json.type === type) out.push(json);
  for (const child of json.content ?? []) collectNodes(child, type, out);
  return out;
}

function writeRel(root: string, rel: string, body: string | Uint8Array): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
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

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DOC_BODY = '# Heading\n\n![[photo.png]]\n';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('T17: branch switch with `![[photo.png]]` doc — reseed-before-reset', () => {
  test('post-switch PM image src reflects NEW branch resolved path, not pre-switch', async () => {
    // Layout:
    //   main:    test-doc.md (root, `![[photo.png]]`) + photo.png (root, sibling)
    //   feature: test-doc.md (root, `![[photo.png]]`) + assets/photo.png +
    //            assets/cover.md (sibling so ContentFilter admits the asset)
    //
    // basenameIndex resolution differs between branches:
    //   main    → photo.png  → '/photo.png'
    //   feature → photo.png  → '/assets/photo.png'
    //
    // The cross-branch reseed in server-factory.ts IS the only mechanism by
    // which the post-switch basenameIndex reflects 'assets/photo.png'
    // (the file-watcher's buffered events are discarded). Before the
    // fix, the doc-reset runs with the stale main-branch
    // basenameIndex; after the fix, the reseed runs first and the doc-reset
    // sees the new branch's mapping.
    const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-t17-')));
    cleanups.push(() => {
      try {
        rmSync(contentDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    });

    // Build initial main-branch state on disk.
    writeRel(contentDir, 'test-doc.md', DOC_BODY);
    writeRel(contentDir, 'photo.png', PNG_BYTES);
    await ensureProjectGit(contentDir);
    git(contentDir, 'config user.name test');
    git(contentDir, 'config user.email test@test.local');
    git(contentDir, 'add .');
    git(contentDir, 'commit -m main-state');

    // Build feature-branch state: photo.png moved into assets/, sibling
    // assets/cover.md added so ContentFilter's sibling-asset rule admits.
    git(contentDir, 'checkout -b feature');
    rmSync(join(contentDir, 'photo.png'));
    writeRel(contentDir, 'assets/cover.md', '# Cover\n');
    writeRel(contentDir, 'assets/photo.png', PNG_BYTES);
    git(contentDir, 'add -A');
    git(contentDir, 'commit -m feature-state');
    git(contentDir, 'checkout main');

    // Boot the server on main. seedBasenameIndex runs at boot and walks the
    // root-level photo.png; PM image src on first onLoadDocument carries
    // '/photo.png'.
    const server = await createRestartableServer({
      contentDir,
      keepContentDir: false,
      gitEnabled: true,
      commitDebounceMs: 500,
    });
    cleanups.push(() => server.shutdown());

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());

    pool.open('test-doc');
    pool.setActive('test-doc');
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);

    // Pre-switch sanity: server-side jsxComponent(WikiEmbedImage) carries
    // main-branch resolved src on its props bag.
    const preState = getServerState(server, 'test-doc');
    if (!preState) throw new Error('server has no test-doc loaded pre-switch');
    const preJson = yXmlFragmentToProseMirrorRootNode(
      preState.fragment,
      schema,
    ).toJSON() as PmJsonNode;
    const preEmbeds = collectNodes(preJson, 'jsxComponent').filter(
      (n) => n.attrs?.componentName === 'WikiEmbedImage',
    );
    expect(preEmbeds.length).toBe(1);
    const prePropsRecord = preEmbeds[0]?.attrs?.props as Record<string, unknown> | undefined;
    expect(prePropsRecord?.src).toBe('/photo.png');

    await wait(300);

    // Execute the branch switch externally (simulates user `git checkout`).
    git(contentDir, 'checkout feature');

    // Wait for the cross-branch path to settle. The post-switch invariant we
    // care about is that PM image `src` reflects the NEW branch's resolved
    // path; poll directly on that (rather than `embeds.length === 1`, which
    // is true both pre- and post-switch and would let the assertion fire
    // before the doc-reset loop has run). 15s timeout absorbs CI contention.
    //
    // RED case behavior: if the cross-branch path never runs (head-watcher
    // missed the HEAD event), props.src stays at '/photo.png' indefinitely
    // and pollUntil times out — the assertion below then fails with the
    // pre-switch value, naming the actual failure mode.
    await pollUntil(
      () => {
        const state = getServerState(server, 'test-doc');
        if (!state) return false;
        const json = yXmlFragmentToProseMirrorRootNode(
          state.fragment,
          schema,
        ).toJSON() as PmJsonNode;
        const embeds = collectNodes(json, 'jsxComponent').filter(
          (n) => n.attrs?.componentName === 'WikiEmbedImage',
        );
        if (embeds.length !== 1) return false;
        const props = embeds[0]?.attrs?.props as Record<string, unknown> | undefined;
        return props?.src === '/assets/photo.png';
      },
      15_000,
      100,
    );

    // Post-switch assertion (the regression gate): the wiki-embed
    // component's props.src reflects the FEATURE branch's resolved path.
    // Under the bug, the doc-reset runs BEFORE the
    // basenameIndex reseed, so resolveEmbed returns
    // 'photo.png' (stale main-branch path) and props.src is '/photo.png'
    // instead of '/assets/photo.png'.
    const postState = getServerState(server, 'test-doc');
    if (!postState) throw new Error('server has no test-doc loaded post-switch');
    const postJson = yXmlFragmentToProseMirrorRootNode(
      postState.fragment,
      schema,
    ).toJSON() as PmJsonNode;
    const postEmbeds = collectNodes(postJson, 'jsxComponent').filter(
      (n) => n.attrs?.componentName === 'WikiEmbedImage',
    );
    expect(postEmbeds.length).toBe(1);
    const postPropsRecord = postEmbeds[0]?.attrs?.props as Record<string, unknown> | undefined;
    expect(postPropsRecord?.src).toBe('/assets/photo.png');
    expect(postPropsRecord?.target).toBe('photo.png');

    // Disk markdown round-trips identically — the storage layer sees no
    // change. Only the rendered preview's src changes.
    const postSource = postState.fragment.doc?.getText('source').toString() ?? '';
    expect((postSource.match(/!\[\[photo\.png\]\]/g) ?? []).length).toBe(1);
  }, 45_000);
});
