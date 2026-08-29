/**
 * `useMirrorSource(src, anchor)` — resolves a `<Mirror>` reference to the
 * HTML of the matching `<MirrorSource id="…">` subtree in the source doc.
 *
 * Strategy: acquires a (collabUrl, src)-keyed `HocuspocusProvider` from the
 * shared `live-doc-pool`, observes the source's `Y.Text('source')` for live
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
 * Y.Text observer is debounced (`LIVE_DOC_OBSERVE_DEBOUNCE_MS`, 150ms trailing-edge)
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

import { mdastToHtml } from '@inkeep/open-knowledge-core';
import { useEffect, useRef, useState } from 'react';
import { useCollabUrl } from '@/lib/use-collab-url';
import { getSharedMarkdownManager } from '../utils/md-singleton.ts';
import {
  acquireLiveDocProvider,
  LIVE_DOC_OBSERVE_DEBOUNCE_MS,
  LIVE_DOC_SYNC_WATCHDOG_MS,
  releaseLiveDocProvider,
} from './live-doc-pool.ts';

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
  | { kind: 'empty-props' }
  /** The shared live-doc pool declined another connection — the source doc
   *  itself is fine. Rendered with capacity copy, never "removed". */
  | { kind: 'at-capacity' };

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

    const acquired = acquireLiveDocProvider(collabUrl, src);
    if (!acquired.ok) {
      // Honest terminal per cause: an inadmissible name (system/config
      // plane) is content-shaped and renders as "source removed"; a
      // capacity refusal is a client-side condition and must NOT claim the
      // doc is gone. Warn either way so the refusal is grep-able.
      console.warn('[Mirror] live-doc pool refused subscription', {
        src,
        reason: acquired.reason,
      });
      setStatus(
        acquired.reason === 'at-capacity' ? { kind: 'at-capacity' } : { kind: 'source-removed' },
      );
      return;
    }
    const { entry } = acquired;

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
      // Keep state identity when the rendered HTML is unchanged, so a
      // reconnect's onSynced replay doesn't re-render every Mirror for a
      // pixel-identical result.
      setStatus((prev) =>
        prev.kind === 'ready' && prev.html === html ? prev : { kind: 'ready', html },
      );
    };

    // Trailing-edge debounce. Y.Text observers fire on every keystroke in
    // the source doc; we only need a render after the user pauses.
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const recomputeDebounced = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        recomputeNow();
      }, LIVE_DOC_OBSERVE_DEBOUNCE_MS);
    };

    // Subscribe to the pool's shared observer + synced fan-out. `onUpdate`
    // hits the debounced path (keystroke storms); `onSynced` calls
    // `recomputeNow` directly so the first paint after WS handshake is
    // immediate. Anchor changes use `recomputeNow` via the ref (low-
    // frequency, want immediate feedback).
    const unsubscribe = entry.subscribe({
      onUpdate: recomputeDebounced,
      onSynced: () => {
        // Cancel any in-flight debounce; we're about to render synchronously.
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        recomputeNow();
      },
    });
    recomputeRef.current = recomputeNow;

    // Watchdog: if sync never completes (server unreachable / auth fail),
    // transition out of `loading` so the user sees an actionable state.
    // Deliberately RETAINS the entry (unlike `useLiveDocText`, which
    // releases): a Mirror has no retry affordance, so keeping the provider
    // lets a late sync recover it — at the cost of the retained entry
    // counting against the pool cap for the session.
    const watchdog = setTimeout(() => {
      if (!entry.synced) {
        setStatus({ kind: 'source-removed' });
      }
    }, LIVE_DOC_SYNC_WATCHDOG_MS);

    recomputeNow();

    return () => {
      clearTimeout(watchdog);
      if (debounceTimer) clearTimeout(debounceTimer);
      unsubscribe();
      recomputeRef.current = null;
      releaseLiveDocProvider(collabUrl, src);
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
