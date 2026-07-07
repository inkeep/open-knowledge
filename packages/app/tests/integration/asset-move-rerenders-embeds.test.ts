/**
 * Asset-event-driven embed re-render — fallback path that runs INDEPENDENTLY
 * of the head-watcher's HEAD-change detection.
 *
 * Sister test to `branch-switched-with-stale-embed-resolution.test.ts`
 * but with no git involvement: a plain disk move (`photo.png` → `assets/photo.png`)
 * fires `asset-delete` + `asset-create` file-watcher events, which update
 * `basenameIndex` via `add`/`remove`. The fallback re-render path detects
 * that an open doc references the changed basename via `[[photo.png]]` and
 * re-applies the doc against the post-move `basenameIndex` so PM `props.src`
 * tracks the new resolved path.
 *
 * Why this matters: the sister test depends on the head-watcher firing for cross-branch
 * doc-reset. When the head-watcher misses the HEAD event (parcel-watcher
 * inotify event drop on Linux CI under high concurrent watch pressure),
 * The sister test fails because the test-doc's content is byte-identical across
 * branches → no `change` DiskEvent → no re-render. Asset events still
 * arrive, update basenameIndex correctly, but historically did not trigger
 * doc re-render. This test pins the asset-event-driven re-render contract
 * so the system is self-healing on the asset-event path even when the
 * head-watcher misses.
 *
 * Hermetic: per-test tmpdir + per-test docName + no git operations after
 * server boot. ensureProjectGit creates `.git/` (the harness does this
 * unconditionally) but the test never invokes `git` after boot — head-watcher
 * has nothing to detect, so we exercise the asset-event path in isolation.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { ensureProjectGit } from '@inkeep/open-knowledge-server';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { ProviderPool } from '../../src/editor/provider-pool';
import { createRestartableServer, getServerState, pollUntil, schema } from './test-harness';

// ── Local helpers (kept inline; small and not shared) ─────────────────

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

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DOC_BODY = '# Heading\n\n![[photo.png]]\n';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('asset-move embed re-resolution — head-watcher-independent fallback', () => {
  test('moving photo.png → assets/photo.png updates PM image src without git', async () => {
    // Layout pre-move:
    //   /photo.png         (root-level — basenameIndex maps photo.png → /photo.png)
    //   /assets/cover.md   (sibling md so ContentFilter admits assets/* on move)
    //   /test-doc.md       (the doc with `![[photo.png]]` we'll observe)
    //
    // Layout post-move:
    //   /assets/cover.md   (still there)
    //   /assets/photo.png  (moved here — basenameIndex must rebuild to /assets/photo.png)
    //   /test-doc.md       (PM image src must update from /photo.png to /assets/photo.png)
    const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-asset-move-')));
    cleanups.push(() => {
      try {
        rmSync(contentDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    });

    // Pre-write all initial files BEFORE server boot so seedBasenameIndex's
    // walk admits photo.png (root) and primes ContentFilter dirCount[assets]
    // via cover.md. This avoids the boot-time race where asset-create for
    // photo.png arrives at ContentFilter before assets/cover.md has
    // incremented dirCount, leaving photo.png unadmitted.
    writeRel(contentDir, 'test-doc.md', DOC_BODY);
    writeRel(contentDir, 'photo.png', PNG_BYTES);
    writeRel(contentDir, 'assets/cover.md', '# Cover\n');
    await ensureProjectGit(contentDir);

    // Boot server. seedBasenameIndex walks the tree → photo.png admits as
    // /photo.png, assets/cover.md primes dirCount[assets].
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

    // Pre-move sanity: PM image src reflects root-level photo.png.
    const preState = getServerState(server, 'test-doc');
    if (!preState) throw new Error('server has no test-doc loaded pre-move');
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

    // Move the asset. Two raw fs ops, no git → head-watcher never fires.
    // The file-watcher delivers `asset-delete photo.png` then `asset-create
    // assets/photo.png`. ContentFilter admits the new path because
    // assets/cover.md is a sibling md (dirCount[assets] > 0).
    rmSync(join(contentDir, 'photo.png'));
    writeRel(contentDir, 'assets/photo.png', PNG_BYTES);

    // Poll directly on the post-move invariant. Without the asset-event-
    // driven re-render fallback, this times out at 10s and the assertion
    // below fails with the pre-move src — naming the failure mode.
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
      10_000,
      100,
    );

    const postState = getServerState(server, 'test-doc');
    if (!postState) throw new Error('server has no test-doc loaded post-move');
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
  }, 30_000);

  test('deleting photo.png without replacement re-renders embed with null src', async () => {
    // Pure asset delete — no replacement file appears. Pins the contract that
    // basenameIndex.remove + scheduleAssetRerender produces a doc whose
    // wiki-embed reflects unresolved state (resolveEmbed returns null), not
    // the stale pre-delete src. Sister scenario to the move test above; the
    // delete-only path doesn't get the asset-create fallback rerender, so
    // the asset-delete handler's rerender is the only mechanism here.
    const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-asset-delete-')));
    cleanups.push(() => {
      try {
        rmSync(contentDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    });

    writeRel(contentDir, 'test-doc.md', DOC_BODY);
    writeRel(contentDir, 'photo.png', PNG_BYTES);
    await ensureProjectGit(contentDir);

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

    // Pre-delete: PM image src reflects root-level photo.png.
    const preState = getServerState(server, 'test-doc');
    if (!preState) throw new Error('server has no test-doc loaded pre-delete');
    const preJson = yXmlFragmentToProseMirrorRootNode(
      preState.fragment,
      schema,
    ).toJSON() as PmJsonNode;
    const preEmbeds = collectNodes(preJson, 'jsxComponent').filter(
      (n) => n.attrs?.componentName === 'WikiEmbedImage',
    );
    expect(preEmbeds.length).toBe(1);
    expect((preEmbeds[0]?.attrs?.props as Record<string, unknown> | undefined)?.src).toBe(
      '/photo.png',
    );

    await wait(300);

    // Delete the asset with no replacement. file-watcher fires `asset-delete
    // photo.png`; basenameIndex.remove leaves no entry, so resolveEmbed
    // returns null. The post-delete rerender re-applies the same Y.Text
    // source through `applyDiskContentToDoc` and the wiki-embed renders
    // with whatever the resolveEmbed-returns-null code path produces.
    rmSync(join(contentDir, 'photo.png'));

    // Poll until PM reflects the unresolved state. The exact unresolved-
    // src shape (null vs '' vs the bare basename) is owned by resolveEmbed;
    // pinning the contract here = "src is no longer the pre-delete value".
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
        const src = (embeds[0]?.attrs?.props as Record<string, unknown> | undefined)?.src;
        return src !== '/photo.png';
      },
      10_000,
      100,
    );

    const postState = getServerState(server, 'test-doc');
    if (!postState) throw new Error('server has no test-doc loaded post-delete');
    const postJson = yXmlFragmentToProseMirrorRootNode(
      postState.fragment,
      schema,
    ).toJSON() as PmJsonNode;
    const postEmbeds = collectNodes(postJson, 'jsxComponent').filter(
      (n) => n.attrs?.componentName === 'WikiEmbedImage',
    );
    expect(postEmbeds.length).toBe(1);
    const postPropsRecord = postEmbeds[0]?.attrs?.props as Record<string, unknown> | undefined;
    // Pre-delete src was `/photo.png`; the rerender must have moved off it.
    expect(postPropsRecord?.src).not.toBe('/photo.png');
    // The wiki-link target itself is preserved on the embed (markdown text
    // is unchanged) — only the resolved src changed.
    expect(postPropsRecord?.target).toBe('photo.png');

    // Source markdown is unchanged across the delete — only resolution shifted.
    const postSource = postState.fragment.doc?.getText('source').toString() ?? '';
    expect((postSource.match(/!\[\[photo\.png\]\]/g) ?? []).length).toBe(1);
  }, 30_000);
});
