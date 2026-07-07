/**
 * `useMirrorSource(src, anchor)` — resolves a `<Mirror>` reference to the
 * HTML of the matching `<MirrorSource id="…">` subtree in the source doc.
 *
 * Strategy: acquires a (collabUrl, src)-keyed `HocuspocusProvider` from a
 * module-local cache, observes the source's `Y.Text('source')` for live
 * re-renders, and renders the matching MirrorSource subtree through the
 * shared `mdastToHtml` pipeline so a Mirror appears bit-equivalent to what
 * the docs site / preview produces for the same content.
 *
 * Why the cache: a single consumer doc can hold many Mirrors that reference
 * the same source. Each opening its own provider produces N redundant WS
 * connections to the same doc; the duplicates don't reliably receive the
 * initial state-sync, leaving Mirrors 2..N stuck on a stale empty Y.Text.
 * The cache keys on (collabUrl, src), refcounts mounts, and destroys the
 * provider on the last unmount.
 *
 * The cache lives OUTSIDE the editor's `ProviderPool`. Mirror references
 * are read-only consumers — folding them into the editor pool would compete
 * for the LRU cap (default 10) and evict docs the user has open for editing.
 *
 * `source-removed` is gated on the provider reaching `synced`. Until the
 * first state-sync arrives, an empty `Y.Text` is just the un-loaded initial
 * state, not a missing doc — surfacing "source removed" before sync would
 * flash a false negative on every slow network.
 *
 * Effect split: the provider-owning effect is keyed on `[collabUrl, src]`;
 * an anchor-only effect re-evaluates the current source against the latest
 * anchor without touching the WebSocket. Changing only the anchor (a very
 * common property-panel edit) no longer tears down + reopens the connection.
 *
 * Y.Text observer is debounced (`OBSERVE_DEBOUNCE_MS`, 150ms trailing-edge)
 * because every keystroke in the source doc fires the observer; a full
 * parse + mdast walk + hast render per keystroke is wasted work across N
 * Mirrors. CC1 broadcasts use the same 100ms-class debounce for the same
 * derived-view shape.
 *
 * Known: this hook attaches a Y.js observer inside a TipTap NodeView, which
 * lives inside the editor's `<Activity>` subtree. AGENTS.md STOP rule warns
 * against unbounded Y.js observers in Activity subtrees. The bound here is
 * indirect — `ACTIVITY_MOUNT_LIMIT=3` caps live editors, and the refcounted
 * pool collapses same-doc Mirrors to a single provider. Suspending the
 * observer on `Activity` flipping to hidden is deferred.
 */

import { HocuspocusProvider } from '@hocuspocus/provider';
import { mdastToHtml } from '@inkeep/open-knowledge-core';
import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { useCollabUrl } from '@/lib/use-collab-url';
import { getSharedMarkdownManager } from '../utils/md-singleton.ts';

// Note: this hook intentionally does NOT import `useDocumentContext` from
// `../DocumentContext.tsx`. DocumentContext transitively pulls in
// `provider-pool.ts` whose module-top `getSchema(sharedExtensions)`
// evaluation creates a temporal-dead-zone race when both this hook and
// provider-pool are crossing the same `sharedExtensions` import edge during
// a test-runner cold load. `useCollabUrl` lives outside `editor/` so it's
// safe to import here without re-entering the editor module graph.

// Structural type for the MirrorSource mdxJsxFlowElement we extract from
// the parsed mdast. Inlined (not imported from `mdast-util-mdx`) so the app
// package doesn't have to declare a direct dep on a transitive of core's.
interface MdxJsxAttrLike {
  type: string;
  name?: string;
  value?: unknown;
}
interface MdxJsxFlowElementLike {
  type: 'mdxJsxFlowElement';
  name?: string | null;
  attributes?: MdxJsxAttrLike[];
  children?: MdastNodeLike[];
}
interface MdastNodeLike {
  type: string;
  children?: MdastNodeLike[];
  [key: string]: unknown;
}
interface MdastRootLike extends MdastNodeLike {
  type: 'root';
  children: MdastNodeLike[];
}

type MirrorSourceStatus =
  | { kind: 'loading' }
  | { kind: 'ready'; html: string }
  | { kind: 'source-removed' }
  | { kind: 'anchor-not-found' }
  | { kind: 'empty-props' };

/**
 * Find the first `<MirrorSource>` node in the mdast tree whose `id`
 * attribute matches `anchor`. Walks recursively so MirrorSources nested
 * inside Callouts, Accordions, Tabs, etc. still resolve. Exported so the
 * unit tests can pin the tree-walking behavior independently of React.
 */
export function findMirrorSource(
  tree: MdastNodeLike,
  anchor: string,
): MdxJsxFlowElementLike | null {
  if (tree.type === 'mdxJsxFlowElement') {
    const node = tree as MdxJsxFlowElementLike;
    if (node.name === 'MirrorSource') {
      for (const attr of node.attributes ?? []) {
        if (
          attr.type === 'mdxJsxAttribute' &&
          attr.name === 'id' &&
          typeof attr.value === 'string' &&
          attr.value === anchor
        ) {
          return node;
        }
      }
    }
  }
  const children = tree.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findMirrorSource(child, anchor);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Render a MirrorSource's children directly through `mdastToHtml`. We feed
 * mdast straight into the hast pipeline (rather than serializing to markdown
 * first and re-parsing) because parsed source children can include
 * `mdxJsxFlowElement` nodes — GFM callouts, custom components, anything the
 * docs site renders — which the bare `mdast-util-to-markdown` round-trip
 * doesn't know how to stringify. `mdastToHtml` ships with the full handler
 * matrix the docs site uses, so a Mirror's appearance matches preview /
 * published rendering for the same source. Exported for unit-test coverage.
 */
export function renderMirrorSubtree(node: MdxJsxFlowElementLike): string {
  const synthRoot: MdastRootLike = {
    type: 'root',
    children: node.children ?? [],
  };
  // `mdastToHtml` accepts core's `MdastRoot` type; the structural local
  // `MdastRootLike` matches it where it matters (`type: 'root'` + `children`
  // array of mdast-like nodes). Cast at the boundary for compatibility.
  // biome-ignore lint/suspicious/noExplicitAny: structural type match across the core boundary
  return mdastToHtml(synthRoot as any);
}

/**
 * Refcounted entry per (collabUrl, src). The provider opens once on first
 * acquire and is destroyed when the last Mirror referencing it unmounts.
 *
 * Each subscriber registers two callbacks: `onUpdate` (fired on every
 * `Y.Text` mutation — high-frequency keystrokes; the hook wraps it with a
 * trailing-edge debounce) and `onSynced` (fired every time the provider
 * confirms state-sync — initial handshake AND every subsequent reconnect;
 * the hook calls `recomputeNow` directly so post-handshake paints don't
 * eat the 150ms debounce delay).
 */
interface MirrorSubscriber {
  onUpdate: () => void;
  onSynced: () => void;
}
interface MirrorPoolEntry {
  provider: HocuspocusProvider;
  ySource: Y.Text;
  refcount: number;
  synced: boolean;
  subscribers: Set<MirrorSubscriber>;
}
const mirrorPool = new Map<string, MirrorPoolEntry>();

// Soft warning threshold for pool growth. Refcounted cleanup keeps the
// upper bound proportional to live Mirror references, but a doc with many
// distinct sources could surface a perf bug here — warn so it surfaces
// during dev rather than browsers silently throttling the WS pool.
const MIRROR_POOL_WARN_AT = 30;
// Trailing-edge debounce on Y.Text observer. Source-doc keystrokes shouldn't
// trigger a full mdast parse + hast render per character.
const OBSERVE_DEBOUNCE_MS = 150;
// Watchdog timeout for never-synced providers (server down, bad src).
// Without this, a Mirror pointing at an unreachable doc stays in `loading`
// indefinitely while HocuspocusProvider retries with exponential backoff.
const SYNC_WATCHDOG_MS = 10_000;

function acquireMirrorProvider(collabUrl: string, src: string): MirrorPoolEntry {
  const key = `${collabUrl}|${src}`;
  const existing = mirrorPool.get(key);
  if (existing) {
    existing.refcount += 1;
    return existing;
  }
  const yDoc = new Y.Doc();
  // Reconnect cap lives on the underlying `HocuspocusProviderWebsocket`
  // config rather than the provider top-level config; we accept default
  // reconnect behavior here and rely on `SYNC_WATCHDOG_MS` to surface a
  // bad src (unreachable doc) by transitioning out of `loading` after
  // 10s. Read-only consumers don't have ergonomic value in fewer retries.
  const provider = new HocuspocusProvider({
    url: collabUrl,
    name: src,
    document: yDoc,
  });
  const subscribers = new Set<MirrorSubscriber>();
  const entry: MirrorPoolEntry = {
    provider,
    ySource: yDoc.getText('source'),
    refcount: 1,
    synced: false,
    subscribers,
  };
  provider.on('synced', () => {
    entry.synced = true;
    // Fan out to every subscriber's onSynced callback so pre-sync mounts
    // parked on `loading` move to `ready` / `source-removed` immediately.
    // Routing through onSynced (not onUpdate) bypasses the debounce — the
    // first content paint after WS handshake shouldn't eat 150ms of delay
    // just because synced and a Y.Text update happened to coincide.
    for (const sub of subscribers) sub.onSynced();
  });
  // Single shared Y.Text observer per provider. Mirrors join via the
  // `subscribers` set rather than each calling `ySource.observe` themselves —
  // keeps observer count tied to the source doc, not to mount count.
  entry.ySource.observe(() => {
    for (const sub of subscribers) sub.onUpdate();
  });
  mirrorPool.set(key, entry);
  if (mirrorPool.size > MIRROR_POOL_WARN_AT) {
    console.warn(
      `[Mirror] provider pool exceeded ${MIRROR_POOL_WARN_AT} entries (current=${mirrorPool.size}). Many Mirrors pointing at distinct source docs — investigate if this is a runaway pattern.`,
    );
  }
  return entry;
}

function releaseMirrorProvider(collabUrl: string, src: string): void {
  const key = `${collabUrl}|${src}`;
  const entry = mirrorPool.get(key);
  if (!entry) return;
  entry.refcount -= 1;
  if (entry.refcount <= 0) {
    try {
      entry.provider.destroy();
    } catch (err) {
      // Best-effort teardown — don't let a destroy failure leak the entry
      // and turn a future acquire into a zombie hand-off.
      console.warn('[Mirror] provider.destroy() failed during release', { src, err });
    }
    mirrorPool.delete(key);
  }
}

export function useMirrorSource(src: string, anchor: string): MirrorSourceStatus {
  const { collabUrl } = useCollabUrl();
  const [status, setStatus] = useState<MirrorSourceStatus>({ kind: 'loading' });
  // Anchor lives in a ref so the provider-owning effect's subscriber closure
  // always reads the latest anchor without re-running and tearing down the
  // WebSocket. The ref is assigned inside the anchor-only effect below (not
  // during render) so React Compiler's "no refs during render" rule is met.
  const anchorRef = useRef(anchor);
  // Stable handle to "recompute against current ySource + anchor" — set by
  // the provider-owning effect, read by the anchor-only effect.
  const recomputeRef = useRef<(() => void) | null>(null);

  // Provider-owning effect — keyed on (collabUrl, src) only. Anchor changes
  // do NOT tear down the WS; the anchor-only effect below just re-evaluates.
  useEffect(() => {
    if (!src) {
      setStatus({ kind: 'empty-props' });
      return;
    }
    if (!collabUrl) {
      setStatus({ kind: 'loading' });
      return;
    }

    const entry = acquireMirrorProvider(collabUrl, src);

    const recomputeNow = () => {
      const currentAnchor = anchorRef.current;
      if (!currentAnchor) {
        setStatus({ kind: 'empty-props' });
        return;
      }
      const markdown = entry.ySource.toString();
      if (!markdown) {
        // Empty Y.Text before initial sync is the un-loaded state, not a
        // missing doc. Stay on `loading` until `synced` flips true; then a
        // confirmed-empty source means the doc legitimately doesn't exist.
        setStatus(entry.synced ? { kind: 'source-removed' } : { kind: 'loading' });
        return;
      }
      let tree: MdastRootLike;
      try {
        // `parseToMdast` returns the core `MdastRoot` type; structurally
        // identical to our local `MdastRootLike` (children is an array of
        // mdast-like nodes). Cast at the boundary for compatibility.
        // biome-ignore lint/suspicious/noExplicitAny: structural type match across the core boundary
        tree = getSharedMarkdownManager().parseToMdast(markdown) as any;
      } catch (err) {
        // Surface the parse failure so it's diagnosable; classifying as
        // `source-removed` would otherwise silently swallow the cause.
        console.warn('[Mirror] parseToMdast failed', { src, anchor: currentAnchor, err });
        setStatus({ kind: 'source-removed' });
        return;
      }
      const node = findMirrorSource(tree, currentAnchor);
      if (!node) {
        setStatus({ kind: 'anchor-not-found' });
        return;
      }
      let html: string;
      try {
        html = renderMirrorSubtree(node);
      } catch (err) {
        // Subtree contains nodes the hast pipeline can't serialize. Fall
        // back to anchor-not-found rather than crashing the consumer doc;
        // log so the actual cause is debuggable from devtools.
        console.warn('[Mirror] renderMirrorSubtree failed', { src, anchor: currentAnchor, err });
        setStatus({ kind: 'anchor-not-found' });
        return;
      }
      setStatus({ kind: 'ready', html });
    };

    // Trailing-edge debounce. Y.Text observers fire on every keystroke in
    // the source doc; we only need a render after the user pauses.
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const recomputeDebounced = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        recomputeNow();
      }, OBSERVE_DEBOUNCE_MS);
    };

    // Subscribe to the pool's shared observer + synced fan-out. `onUpdate`
    // hits the debounced path (keystroke storms); `onSynced` calls
    // `recomputeNow` directly so the first paint after WS handshake is
    // immediate. Anchor changes use `recomputeNow` via the ref (low-
    // frequency, want immediate feedback).
    const subscriber: MirrorSubscriber = {
      onUpdate: recomputeDebounced,
      onSynced: () => {
        // Cancel any in-flight debounce; we're about to render synchronously.
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        recomputeNow();
      },
    };
    entry.subscribers.add(subscriber);
    recomputeRef.current = recomputeNow;

    // Watchdog: if sync never completes (server unreachable / auth fail),
    // transition out of `loading` so the user sees an actionable state.
    const watchdog = setTimeout(() => {
      if (!entry.synced) {
        setStatus({ kind: 'source-removed' });
      }
    }, SYNC_WATCHDOG_MS);

    recomputeNow();

    return () => {
      clearTimeout(watchdog);
      if (debounceTimer) clearTimeout(debounceTimer);
      entry.subscribers.delete(subscriber);
      recomputeRef.current = null;
      releaseMirrorProvider(collabUrl, src);
    };
  }, [collabUrl, src]);

  // Anchor-only effect — keep the ref in sync (so the observer closure sees
  // the latest anchor) and re-evaluate against the current source without
  // churning the provider. Drives the property-panel-edit case.
  useEffect(() => {
    anchorRef.current = anchor;
    recomputeRef.current?.();
  }, [anchor]);

  return status;
}
