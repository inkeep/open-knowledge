/**
 * Restart-with-embed-doc — composition test for `resolveEmbed` (asset-embed
 * surface) × `server-instance-mismatch` buffer-and-replay (client-persistence
 * surface).
 *
 * Asserts that a server restart preserves the single-image invariant for a
 * doc containing `![[photo.png]]`:
 *
 *   1. Server `onLoadDocument` runs `parseWithFallback(body, {resolveEmbed,
 *      sourcePath})`. The PM image lands with `src="/assets/photo.png"` under
 *      server clientID S1.
 *   2. Server restarts (new serverInstanceId S2). Client's auth-token rejects;
 *      `ProviderPool.handleServerInstanceMismatch` fires
 *      buffer→clearData→recycle.
 *   3. Buffered delta is structurally empty (the load-only baseline equals the
 *      doc clock; `Y.encodeStateAsUpdate(doc, baseline)` returns ~2 bytes of
 *      header). `Y.applyUpdate` of an empty update is a no-op.
 *   4. Fresh server `onLoadDocument` rebuilds the PM image under S2.
 *   5. Client doc has EXACTLY ONE PM image with `src="/assets/photo.png"`.
 *
 * Regression gate. Will fail if any of:
 *   - `provider-pool.ts` baseline selection changes such that `unsynced`
 *     includes pre-restart Y.Items.
 *   - `client-persistence.ts:computeUnsyncedUpdate` returns full state instead
 *     of diff-against-baseline.
 *   - `resolveEmbed` plumbing breaks in `persistence.ts:onLoadDocument`.
 *
 * Sequencing in the embed-doc track post-T14. (`disk-ack-missed-frame.test.ts`
 * already labels itself "T15" in a parallel CC1-disk-ack track — different
 * sequence; this file disambiguates via descriptive `describe()` label.)
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { ProviderPool } from '../../src/editor/provider-pool';
import {
  createRestartableServer,
  getServerState,
  pollUntil,
  schema,
  seedPoolServerInstanceId,
} from './test-harness';

// ── Local helpers ──────────────────────────────────────────────────

interface PmJsonNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: PmJsonNode[];
}

/** Collect every PM JSON node of a given type, recursive. */
function collectNodes(json: PmJsonNode, type: string, out: PmJsonNode[] = []): PmJsonNode[] {
  if (json.type === type) out.push(json);
  for (const child of json.content ?? []) collectNodes(child, type, out);
  return out;
}

/** Write a file relative to `root`, creating parent dirs as needed. */
function writeRel(root: string, rel: string, body: string | Uint8Array): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('restart-with-embed-doc: server restart preserves single PM image with resolved src', () => {
  test('![[photo.png]] doc survives restart-recycle with exactly one image and /assets/ src', async () => {
    // Pre-populate contentDir before boot. This guarantees `seedBasenameIndex`
    // (which runs synchronously inside `srv.ready`) walks the asset on first
    // load, so the basenameIndex contains `photo.png` BEFORE any client
    // triggers `onLoadDocument` + `parseWithFallback({resolveEmbed})`. Seeding
    // after boot would race the file watcher's `'create'` event, which is
    // async and can land after the pool's first sync.
    //
    // Co-locate the asset with the markdown doc in the same dir. ContentFilter's
    // sibling-asset rule (content-filter.ts) only admits an asset when
    // its parent dir contains an included `.md` — placing the asset in a
    // standalone `assets/` dir without a sibling `.md` would exclude it from
    // both `seedBasenameIndex` and the file watcher.
    const contentDir = mkdtempSync(join(tmpdir(), 'ok-embed-restart-'));
    writeRel(contentDir, 'photo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    writeRel(contentDir, 'test-doc.md', '# Heading\n\n![[photo.png]]\n');

    let server = await createRestartableServer({ contentDir });
    cleanups.push(() => server.shutdown());

    const pool = new ProviderPool(3, `ws://127.0.0.1:${server.port}/collab`);
    cleanups.push(() => pool.dispose());
    await seedPoolServerInstanceId(server, pool);

    pool.open('test-doc');
    pool.setActive('test-doc');
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 10_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 10_000, 50);

    // Pre-restart: server's Y.XmlFragment carries one resolved-src
    // jsxComponent(WikiEmbedImage) PM node (block-context wiki-embed → compat
    // descriptor; renders through the canonical Image.tsx React component).
    const preState = getServerState(server, 'test-doc');
    if (!preState) throw new Error('server has no test-doc loaded pre-restart');
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
    expect(prePropsRecord?.target).toBe('photo.png');

    await wait(500);

    // Kill + restart same port; downtime well below RECYCLE_DEBOUNCE_MS so the
    // bug-class `authenticationFailed` path fires cleanly. Cleanups go LIFO via
    // `unshift` so the new handle's shutdown cascades through retired
    // predecessors.
    server = await server.killAndRestartOnSamePort({ downtimeMs: 400 });
    cleanups.unshift(() => server.shutdown());
    await pollUntil(() => pool.getActive()?.provider.isSynced === true, 15_000, 50);
    await pollUntil(() => pool.getActive()?.provider.unsyncedChanges === 0, 15_000, 50);

    // Post-restart, client side: exactly ONE jsxComponent(WikiEmbedImage)
    // with the resolved src.
    const entry = pool.getActive();
    if (!entry) throw new Error('pool has no active entry after recycle');
    const clientFragment = entry.provider.document.getXmlFragment('default');
    const clientJson = yXmlFragmentToProseMirrorRootNode(
      clientFragment,
      schema,
    ).toJSON() as PmJsonNode;
    const clientEmbeds = collectNodes(clientJson, 'jsxComponent').filter(
      (n) => n.attrs?.componentName === 'WikiEmbedImage',
    );
    expect(clientEmbeds.length).toBe(1);
    const clientPropsRecord = clientEmbeds[0]?.attrs?.props as Record<string, unknown> | undefined;
    expect(clientPropsRecord?.src).toBe('/photo.png');

    // Markdown source surface (Y.Text 'source') should still emit the literal
    // `![[photo.png]]` exactly once — the storage shape is unchanged through
    // the round trip; only the rendered PM image carries the resolved src.
    const clientSource = entry.provider.document.getText('source').toString();
    expect((clientSource.match(/!\[\[photo\.png\]\]/g) ?? []).length).toBe(1);

    // Post-restart, server side: same shape (defense in depth — confirms the
    // fresh `onLoadDocument` rebuilt the resolved image under the new
    // serverInstanceId without dup, not just that the client masked dup state).
    const postState = getServerState(server, 'test-doc');
    if (!postState) throw new Error('server has no test-doc loaded post-restart');
    const postJson = yXmlFragmentToProseMirrorRootNode(
      postState.fragment,
      schema,
    ).toJSON() as PmJsonNode;
    const postEmbeds = collectNodes(postJson, 'jsxComponent').filter(
      (n) => n.attrs?.componentName === 'WikiEmbedImage',
    );
    expect(postEmbeds.length).toBe(1);
    const postPropsRecord = postEmbeds[0]?.attrs?.props as Record<string, unknown> | undefined;
    expect(postPropsRecord?.src).toBe('/photo.png');
  }, 30_000);
});
