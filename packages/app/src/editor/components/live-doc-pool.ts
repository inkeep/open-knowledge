/**
 * Refcounted read-only provider pool for rendering ANOTHER doc's live
 * content inside the current one — the substrate `<Mirror>` established,
 * extracted so `<Excalidraw>` embeds (and future by-reference renderers)
 * share one connection per referenced doc instead of growing a second,
 * divergent pool.
 *
 * The pool lives OUTSIDE the editor's `ProviderPool`: these are read-only
 * consumers, and folding them into the editor pool would compete for its
 * LRU cap and evict docs the user has open for editing. Entries key on
 * (collabUrl, docName), refcount mounts, and destroy the provider on the
 * last unmount. Rename/delete recovery (ProviderPool's
 * `authenticationFailed` → rename-redirect / doc-deleted channel) is
 * deliberately out of scope for this pool's v1 — a re-pointed reference
 * arrives as a document edit, which re-runs the consumer with the new
 * docName.
 *
 * Admission is gated: `isSystemDoc`/`isConfigDoc` names are refused (STOP
 * rule — the docName arrives from document content, so this pool is a
 * documentName-keyed entry point), and the pool refuses NEW entries past a
 * hard cap. Refusal is a discriminated result so consumers can render
 * truthful copy per cause — an at-capacity refusal is NOT "this doc is
 * gone". The cap is a hard refusal rather than an LRU eviction on
 * purpose: eviction would silently blank an already-painted on-screen
 * embed, while refusal keeps painted content painted and lets the refused
 * card name the real condition. The cap counts every held entry,
 * including entries a consumer retains through a sync-watchdog timeout
 * (`useMirrorSource` retains; `useLiveDocText` releases — see each
 * watchdog's comment for the policy rationale).
 *
 * Known: subscribers attach a Y.js observer inside a TipTap NodeView, which
 * lives inside the editor's `<Activity>` subtree. AGENTS.md's STOP rule
 * warns against unbounded Y.js observers there. The cross-document bound is
 * real but indirect: `computeActivityMountList` caps the RENDER list at
 * `ACTIVITY_MOUNT_LIMIT` (docs beyond it fully unmount) and `<Activity
 * mode="hidden">` unmounts effects within it, so a hidden or evicted doc's
 * consumers run their effect cleanup and release their providers here.
 * WITHIN a visible doc nothing structural bounds the number of distinct
 * referenced docs — that is authored content — which is what the hard cap
 * exists for.
 */

import { HocuspocusProvider } from '@hocuspocus/provider';
import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { useCollabUrl } from '@/lib/use-collab-url';
import { isConfigDoc, isSystemDoc } from '../is-system-doc';

interface LiveDocSubscriber {
  /** Every `Y.Text` mutation — keystroke-frequency; debounce before work. */
  onUpdate: () => void;
  /** Every confirmed state-sync — initial handshake AND each reconnect. */
  onSynced: () => void;
}

export interface LiveDocPoolEntry {
  provider: HocuspocusProvider;
  ySource: Y.Text;
  readonly refcount: number;
  synced: boolean;
  /**
   * The only sanctioned way to observe an entry — returns the unsubscribe
   * closure. The subscriber set itself stays module-private so one
   * consumer cannot clear or replace another's fan-out.
   */
  subscribe: (subscriber: LiveDocSubscriber) => () => void;
}

interface InternalPoolEntry extends LiveDocPoolEntry {
  refcount: number;
}

const liveDocPool = new Map<string, InternalPoolEntry>();

/**
 * Hard cap on distinct pooled providers. One page can reference
 * arbitrarily many distinct sources across its visible documents, and each
 * entry is a live WebSocket plus a server-side Hocuspocus `Document`; past
 * the browser's per-host connection ceiling the excess would sit in
 * reconnect backoff forever. Acquire refuses (`at-capacity`) rather than
 * queueing or evicting — consumers render the refusal with copy that names
 * capacity, never "doc removed".
 */
export const LIVE_DOC_POOL_MAX = 30;
/** Trailing-edge debounce for `onUpdate` consumers (keystroke storms). */
export const LIVE_DOC_OBSERVE_DEBOUNCE_MS = 150;
/** Watchdog for never-synced providers (server unreachable, bad docName). */
export const LIVE_DOC_SYNC_WATCHDOG_MS = 10_000;

export type AcquireLiveDocResult =
  | { ok: true; entry: LiveDocPoolEntry }
  | { ok: false; reason: 'inadmissible' | 'at-capacity' };

/**
 * Acquire the shared read-only provider for `docName`. Refusals are
 * discriminated: `inadmissible` (system/config plane — a terminal,
 * content-shaped condition) vs `at-capacity` (this client declined to open
 * another connection; the doc itself is fine). A refusal MUST NOT be
 * released.
 */
export function acquireLiveDocProvider(collabUrl: string, docName: string): AcquireLiveDocResult {
  if (isSystemDoc(docName) || isConfigDoc(docName)) return { ok: false, reason: 'inadmissible' };
  const key = `${collabUrl}|${docName}`;
  const existing = liveDocPool.get(key);
  if (existing) {
    existing.refcount += 1;
    return { ok: true, entry: existing };
  }
  if (liveDocPool.size >= LIVE_DOC_POOL_MAX) {
    console.warn(
      `[LiveDoc] provider pool at capacity (${LIVE_DOC_POOL_MAX}); refusing "${docName}". Live by-reference embeds and mirrors across all visible documents share this pool.`,
    );
    return { ok: false, reason: 'at-capacity' };
  }
  const yDoc = new Y.Doc();
  // Default reconnect behavior is fine for read-only consumers; the sync
  // watchdog is what surfaces an unreachable doc as an actionable state.
  const provider = new HocuspocusProvider({
    url: collabUrl,
    name: docName,
    document: yDoc,
  });
  const subscribers = new Set<LiveDocSubscriber>();
  const entry: InternalPoolEntry = {
    provider,
    ySource: yDoc.getText('source'),
    refcount: 1,
    synced: false,
    subscribe: (subscriber) => {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
  };
  provider.on('synced', () => {
    entry.synced = true;
    // Fan out through onSynced (not onUpdate) so the first paint after the
    // WS handshake doesn't eat the consumer's debounce delay.
    for (const sub of subscribers) sub.onSynced();
  });
  // Single shared Y.Text observer per provider — subscriber count tracks
  // referenced docs, not mount count.
  entry.ySource.observe(() => {
    for (const sub of subscribers) sub.onUpdate();
  });
  liveDocPool.set(key, entry);
  return { ok: true, entry };
}

export function releaseLiveDocProvider(collabUrl: string, docName: string): void {
  const key = `${collabUrl}|${docName}`;
  const entry = liveDocPool.get(key);
  if (!entry) return;
  entry.refcount -= 1;
  if (entry.refcount <= 0) {
    try {
      entry.provider.destroy();
    } catch (err) {
      // Best-effort teardown — don't let a destroy failure leak the entry
      // and turn a future acquire into a zombie hand-off.
      console.warn('[LiveDoc] provider.destroy() failed during release', { docName, err });
    }
    liveDocPool.delete(key);
  }
}

/** Test-only visibility into pool occupancy (never mutate through this). */
export function __liveDocPoolSize(): number {
  return liveDocPool.size;
}

/**
 * Tear down every pooled provider. Called from this module's own HMR
 * dispose hook so editing pool consumers in dev doesn't strand the old
 * module instance's WebSockets/observers — the same contract
 * `ProviderPool.dispose()` keeps for the editor pool.
 */
export function disposeLiveDocPool(): void {
  for (const [key, entry] of liveDocPool) {
    try {
      entry.provider.destroy();
    } catch (err) {
      console.warn('[LiveDoc] provider.destroy() failed during dispose', { key, err });
    }
  }
  liveDocPool.clear();
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeLiveDocPool();
  });
}

export type LiveDocTextStatus =
  | { kind: 'loading' }
  /** Confirmed-synced with content. */
  | { kind: 'ready'; text: string }
  /** Confirmed-synced and empty — a real, expected state (a board with
   *  nothing drawn yet), NOT an error. Empty-before-sync stays `loading`. */
  | { kind: 'empty' }
  /** The doc could not be subscribed for a doc-shaped reason: the name is
   *  unresolvable or inadmissible, or sync never arrived within the
   *  watchdog (nonexistent doc / unreachable server — that path releases
   *  the provider so a never-syncing entry stops retrying; recovery is an
   *  explicit re-acquire via `retryToken`). */
  | { kind: 'unreachable' }
  /** The client's shared pool declined another connection. The doc itself
   *  is fine; retrying cannot succeed until other references release. */
  | { kind: 'at-capacity' };

/** Preserve state identity across recomputes that produce an equal status,
 *  so a reconnect's `onSynced` replay doesn't re-render every consumer and
 *  re-run their parse/export chains for a pixel-identical result. */
function reuseIfSame(prev: LiveDocTextStatus, next: LiveDocTextStatus): LiveDocTextStatus {
  if (prev.kind !== next.kind) return next;
  if (prev.kind === 'ready' && next.kind === 'ready' && prev.text !== next.text) return next;
  return prev;
}

/**
 * Live `Y.Text('source')` of another doc, debounced against keystroke
 * storms. The straight-line consumer of the pool for renderers that want
 * the raw source rather than Mirror's parsed-subtree resolution.
 *
 * `retryToken` re-runs the acquire cycle when bumped — the caller's "try
 * again" affordance after an `unreachable` verdict.
 */
export function useLiveDocText(docName: string | null, retryToken = 0): LiveDocTextStatus {
  const { collabUrl } = useCollabUrl();
  const [status, setStatus] = useState<LiveDocTextStatus>({ kind: 'loading' });

  useEffect(() => {
    // A bumped retryToken must re-enter the acquire path below; it carries
    // no other meaning.
    void retryToken;
    if (!docName) {
      setStatus({ kind: 'unreachable' });
      return;
    }
    if (!collabUrl) {
      setStatus({ kind: 'loading' });
      return;
    }
    setStatus((prev) => reuseIfSame(prev, { kind: 'loading' }));

    const acquired = acquireLiveDocProvider(collabUrl, docName);
    if (!acquired.ok) {
      setStatus({ kind: acquired.reason === 'at-capacity' ? 'at-capacity' : 'unreachable' });
      return;
    }
    const { entry } = acquired;

    const recomputeNow = () => {
      const text = entry.ySource.toString();
      const next: LiveDocTextStatus = !text
        ? entry.synced
          ? { kind: 'empty' }
          : { kind: 'loading' }
        : { kind: 'ready', text };
      setStatus((prev) => reuseIfSame(prev, next));
    };

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = entry.subscribe({
      onUpdate: () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          recomputeNow();
        }, LIVE_DOC_OBSERVE_DEBOUNCE_MS);
      },
      onSynced: () => {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        recomputeNow();
      },
    });

    // Idempotent so the watchdog and the effect cleanup can both call it —
    // the watchdog releases early to stop a never-syncing provider's
    // reconnect loop (this hook's deliberate policy; `useMirrorSource`
    // retains its entry instead, keeping a late sync able to recover a
    // Mirror that has no retry affordance), after which the cleanup must
    // not double-decrement.
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      unsubscribe();
      releaseLiveDocProvider(collabUrl, docName);
    };

    const watchdog = setTimeout(() => {
      if (!entry.synced) {
        setStatus({ kind: 'unreachable' });
        releaseOnce();
      }
    }, LIVE_DOC_SYNC_WATCHDOG_MS);

    recomputeNow();

    return () => {
      clearTimeout(watchdog);
      releaseOnce();
    };
  }, [collabUrl, docName, retryToken]);

  return status;
}
