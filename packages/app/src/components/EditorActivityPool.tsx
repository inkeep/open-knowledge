/**
 * EditorActivityPool — bounded `<Activity>` rendering for the most-recently-active
 * pooled docs. `ACTIVITY_MOUNT_LIMIT = 3` decouples from `MAX_POOL = 10`;
 * `__system__` is filtered out as a defense-in-depth.
 *
 * Why `ACTIVITY_MOUNT_LIMIT < MAX_POOL`: `setupObservers` (provider-pool.ts)
 * wires Y.js bidirectional bridges that fire regardless of Activity mode —
 * they are NOT React effects and do not pause when Activity flips to hidden.
 * Bounding mounted editors at 3 caps the editor-instance memory cost (≈30-90MB
 * for TipTap + CodeMirror) without preventing the pool from holding warm
 * providers (≈5-10MB each) for fast Suspense-gated remount on revisit.
 *
 * `TiptapEditor` stays on the initial path; `SourceEditor` is lazy-loaded the
 * first time a doc actually enters source mode. Large docs additionally defer
 * the non-active editor until that mode is first visited. After the initial
 * visits, the doc keeps both editors mounted behind hidden-mode wrappers so
 * subsequent mode swaps stay CSS-only for that Activity.
 *
 * ERROR + SUSPENSE SCOPING (per-Activity, not global).
 *   Each `<Activity>` wraps its own `<DocumentErrorBoundary>` + `<Suspense>`.
 *   Rationale: `<Activity mode="hidden">` silences suspends in the hidden
 *   subtree (good) but does NOT intercept synchronous throws from
 *   `use(rejectedPromise)` (React 19.2 behavior). A single global boundary
 *   above the pool caused any hidden doc's cached rejection to re-throw
 *   into the visible UI when a healthy doc was active. Scoping per-Activity
 *   confines each error to its own subtree — hidden Activities' errors
 *   render into hidden DOM (`display:none`), and become visible again
 *   naturally when the user navigates back.
 *
 *   `resetKeys={[entry.docName]}` is intentionally stable for each Activity
 *   instance — auto-reset on navigation is not needed when the boundary is
 *   per-Activity (visibility is handled by Activity itself). Error clears
 *   only via (a) imperative "Try again" (recycle), (b) "Back to previous"
 *   (invalidate + nav), or (c) Activity eviction from the MRU mount list.
 */

import { isManagedArtifactDocName } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';
import { Loader2, RefreshCw } from 'lucide-react';
import {
  Activity,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { type PoolEntrySnapshot, useDocumentContext } from '@/editor/DocumentContext';
import { peekRenameSnapshot, setActivityMountList } from '@/editor/editor-cache';
import { isSystemDoc } from '@/editor/is-system-doc';
import { clearMountId, getMountId, setMountId } from '@/editor/mount-id-registry';
import type { ServerRestartRecoveryState } from '@/editor/provider-pool';
import { TiptapEditor } from '@/editor/TiptapEditor';
import { useLifecycleStatus } from '@/hooks/use-lifecycle-status';
import { parseProjectSkillContentDocName } from '@/lib/managed-artifact-doc-name';
import { mark, ProfilerBoundary } from '@/lib/perf';
import { readNumericOverride } from '@/lib/perf/env-override';
import { DiffViewBoundary } from './DiffViewBoundary';
import { DocumentBoundary } from './DocumentBoundary';
import { DocumentErrorBoundary } from './DocumentErrorBoundary';
import { EditorSkeleton } from './EditorSkeleton';
import { PageHeader } from './PageHeader';
import { usePageList } from './PageListContext';
import { PropertyPanel } from './PropertyPanel';
import { Button } from './ui/button';

// Lazy-loaded: the skill/template identity panel (+ SkillProperties /
// TemplateProperties + their rename/move APIs) only mounts for managed-artifact
// docs, so it stays out of the eager editor bundle (same rationale as the
// lazy SourceEditor).
const ManagedArtifactProperties = lazy(async () => ({
  default: (await import('./ManagedArtifactProperties')).ManagedArtifactProperties,
}));

/**
 * Large-doc threshold in Y.Text characters. Above this, the non-active editor
 * is defer-mounted on cold load instead of pre-mounting both per
 * precedent #18(b)'s small-to-medium-doc default. Once the user toggles to
 * the deferred mode, that editor mounts and stays mounted — so subsequent
 * toggles remain CSS-only and cost nothing.
 *
 * Value rationale (500_000 chars ≈ 500 KB plain text):
 *   - README.md / AGENTS.md / CLAUDE.md (≤150 KB) — BELOW. No change from
 *     pre-mount-both default; toggle stays instant.
 *   - PROJECT.md (multi-MB) — ABOVE. Cold load skips the non-active
 *     editor's initial mount+parse; first toggle pays the cost; subsequent
 *     toggles are instant.
 *
 * The threshold is a tuning knob, not a contract. Moving it UP regresses
 * the fix for smaller "large" docs; moving it DOWN unnecessarily delays
 * first-toggle UX for medium docs where pre-mount-both was already fast
 * enough.
 *
 * FIRST-TOGGLE COST: On a 3.25 MB doc, the first mode toggle after cold
 * load pays the deferred editor's cold mount — measured at
 * `toSourceMs ≈ 223 ms`. Proportional scaling to a ~9.7 MB doc puts first
 * toggle in the 500–800 ms range. Perceptible but well below the ~1 s
 * hang threshold. Subsequent toggles remain CSS-only. Future engineers:
 * do not assume defer-mount is free at the toggle boundary; it trades
 * cold-load latency for one-time first-toggle latency on the deferred
 * mode. See `ACTIVITY_MOUNT_LIMIT` — both constants are parts of
 * the same Activity-mount hygiene pattern.
 */
export const LARGE_DOC_CHAR_THRESHOLD = readNumericOverride('LARGE_DOC_CHAR_THRESHOLD', 500_000);

/**
 * Pure helper — given the doc size and the current mode-visit history,
 * compute which editors should be rendered.
 *
 * Below the threshold: always both (pre-mount-both, precedent #18(b) default).
 * Above the threshold: only modes that have been visited at least once.
 * Active mode is ALWAYS considered visited for the purpose of this computation,
 * so the call site never sees `renderSource=false && renderVisual=false`.
 *
 * `isLarge` surfaces the threshold branch taken so the caller can emit an
 * `ok/activity/defer-mount` mark for observability. It is NOT load-bearing
 * for the gating decision itself — always derive render flags from this
 * helper's output.
 */
interface EditorMountGateArgs {
  ytextLength: number;
  isSourceMode: boolean;
  visitedSource: boolean;
  visitedVisual: boolean;
  threshold?: number;
}

interface EditorMountGate {
  renderSource: boolean;
  renderVisual: boolean;
  isLarge: boolean;
}

export function computeEditorMountGate(args: EditorMountGateArgs): EditorMountGate {
  const threshold = args.threshold ?? LARGE_DOC_CHAR_THRESHOLD;
  const isLarge = args.ytextLength > threshold;
  if (!isLarge) {
    return { renderSource: true, renderVisual: true, isLarge: false };
  }
  // Large doc: active mode is always rendered (OR-ed with visited history);
  // non-active only if visited at least once.
  const renderSource = args.isSourceMode || args.visitedSource;
  const renderVisual = !args.isSourceMode || args.visitedVisual;
  return { renderSource, renderVisual, isLarge: true };
}

/**
 * Pure gate for the `ok/cold/first-toggle` mark emission. The mark is the
 * first-toggle latency anchor — fires EXACTLY ONCE per ActivityEntry, only
 * when the defer-mount path was active (`isLarge`) and the deferred editor
 * has now mounted (both `renderSource` and `renderVisual` are true). For
 * small docs whose default is pre-mount-both, the mark must NEVER fire —
 * there is no defer-mount transition to measure.
 */
interface ShouldEmitFirstToggleArgs {
  isLarge: boolean;
  renderSource: boolean;
  renderVisual: boolean;
  hasEmittedFirstToggle: boolean;
}

export function shouldEmitFirstToggle(args: ShouldEmitFirstToggleArgs): boolean {
  if (args.hasEmittedFirstToggle) return false;
  if (!args.isLarge) return false;
  return args.renderSource && args.renderVisual;
}

/**
 * Maximum number of editors mounted concurrently inside `<Activity>` boundaries.
 * Decoupled from `MAX_POOL` (exported from `provider-pool.ts`, default 10) per
 * precedent #18(c) — pool-resident-but-not-Activity-mounted docs keep their
 * warm provider (so revisiting is fast via Suspense-gated remount with
 * `syncPromise` resolving immediately from `hasSynced=true`) but skip the
 * per-editor memory + observer-CPU cost of keeping the TipTap + CodeMirror
 * instances alive.
 *
 * 3 covers the "alt-tab between recent docs" pattern dominant for the
 * primary personas.
 *
 * Changing either this value or `MAX_POOL` is an ASK_FIRST boundary — they're
 * coupled by design. If one moves, audit the other for sympathetic impact.
 *
 * **LIMIT=3 is a stable decision, not a temporary holdpoint.** Both the
 * TipTap-editor-cost argument (LIMIT=1 doesn't avoid `createEditor` cost
 * because `@tiptap/react`'s `useEditor` destroys on effect-cleanup anyway)
 * and the scroll-state argument (scroll preservation requires refs to
 * survive, which requires Activity hidden not full unmount) stand
 * independently of the V2 editor cache. A module-level editor cache changes
 * the first argument's mechanics but not the second — LIMIT stays at 3 to
 * keep ScrollPreservingContainer's `useRef` alive across navigation.
 *
 * Reducing this value to 1 was attempted as a warm-switch fix, then
 * REVERTED — LIMIT=1 broke scroll-position survival across A→B→A because
 * `ScrollPreservingContainer` stores its saved scrollTop in a `useRef`, and
 * refs persist across `<Activity>` mode flips but are lost on full unmount.
 * With LIMIT=3, ScrollPreservingContainer stays mounted for non-active docs
 * (effects paused via Activity-hidden; ref state preserved), so revisiting
 * restores scroll position. With LIMIT=1, the container unmounts on nav and
 * the ref is destroyed. TipTap editor state WAS being destroyed regardless
 * (its `useEditor` schedules destroy on effect-cleanup, so LIMIT=3 + hidden
 * transition = same destroy path as LIMIT=1 + unmount), but scroll state was
 * load-bearing. Conclusion: warm-switch latency is architecturally bounded
 * by TipTap's `createEditor` overhead (~350 ms schema + Yjs bind + DOM attach,
 * fixed cost regardless of doc size or `ACTIVITY_MOUNT_LIMIT`); unlocking
 * <100 ms warm-switch requires a module-level Editor cache outside React's
 * lifecycle.
 *
 * See `LARGE_DOC_CHAR_THRESHOLD` — both constants are parts of the same
 * Activity-mount hygiene pattern (precedent #18(c) / precedent #24).
 */
export const ACTIVITY_MOUNT_LIMIT = readNumericOverride('ACTIVITY_MOUNT_LIMIT', 3);

export function loadSourceEditorModule() {
  return import('@/editor/SourceEditor');
}

const LazySourceEditor = lazy(async () => {
  const mod = await loadSourceEditorModule();
  return { default: mod.SourceEditor };
});

interface EditorActivityPoolProps {
  activeDocName: string;
  isSourceMode: boolean;
  editorPlaceholder?: string;
  /**
   * Forwarded to each per-Activity `DocumentErrorBoundary` so the
   * "Back to previous document" affordance in a fallback UI knows where
   * to send the user. Global navigation concern — tracked once at the
   * `EditorArea` level and threaded down through every Activity.
   */
  previousDocName?: string;
  /**
   * Navigation callback for the "Back to previous document" button. Shared
   * across every per-Activity boundary; only the visible Activity's button
   * is ever clickable, so routing is unambiguous.
   */
  onNavigateBack?: (previousDocName: string) => void;
  /**
   * "Try again" recovery for any errored Activity — destroys + recreates
   * the pool entry for the doc that errored (per-Activity boundary passes
   * its own `entry.docName` to the callback, not the globally-active one).
   */
  onRecycle: (docName: string) => void;
}

/**
 * Pure helper — selects the LRU-bounded subset of pool entries to Activity-mount.
 *
 * Invariants:
 * 1. System docs (`__system__`) are filtered out — defense-in-depth even though
 *    `ProviderPool.open` rejects them at admission.
 * 2. The active doc is always present in the result if it exists in `entries` —
 *    even if its `lastAccessedAt` would put it outside the top `limit` (this can
 *    happen transiently between `pool.open` and `pool.setActive`, or in tests).
 * 3. Otherwise: top `limit` entries by `lastAccessedAt` descending (MRU first).
 */
export function computeActivityMountList<T extends { docName: string; lastAccessedAt: number }>(
  entries: ReadonlyArray<T>,
  activeDocName: string | null,
  limit: number,
): ReadonlyArray<T> {
  if (limit <= 0) return [];
  const filtered = entries.filter((e) => !isSystemDoc(e.docName));
  // Stable MRU sort. Caller (`takeSnapshot`) already sorts but we re-sort here so
  // the helper is correct for any input order — keeps test scenarios independent
  // of upstream snapshot ordering decisions.
  const sorted = [...filtered].sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
  const top = sorted.slice(0, limit);

  if (activeDocName === null) return top;
  if (top.some((e) => e.docName === activeDocName)) return top;

  // Active doc exists but didn't make the top-N by lastAccessedAt — force-include it
  // by displacing the LRU member of `top`. Preserves invariant #2 without growing
  // beyond `limit`.
  const active = filtered.find((e) => e.docName === activeDocName);
  if (!active) return top;
  return [...top.slice(0, limit - 1), active];
}

type ServerRestartRecoveryView =
  | {
      kind: 'recovering';
      title: string;
      summary: string;
    }
  | {
      kind: 'failed';
      title: string;
      summary: string;
      actionLabel: string;
    };

export function getServerRestartRecoveryView(
  docName: string,
  state: ServerRestartRecoveryState,
): ServerRestartRecoveryView | null {
  if (state.kind === 'idle') return null;

  if (state.kind === 'failed' && state.failedDocNames.includes(docName)) {
    return {
      kind: 'failed',
      title: t`Couldn't reconnect after server restart`,
      summary:
        state.reason === 'clear-data-timeout'
          ? t`Local collaboration data for "${docName}" could not be cleared in time. Reload to retry.`
          : t`Local collaboration data for "${docName}" could not be cleared. Reload to retry.`,
      actionLabel: t`Reload`,
    };
  }

  if (state.kind === 'recovering' && state.docNames.includes(docName)) {
    return {
      kind: 'recovering',
      title: t`Reconnecting after server restart`,
      summary:
        state.phase === 'clearing-local-cache'
          ? t`Clearing local collaboration data for "${docName}" before reconnecting.`
          : t`Reopening "${docName}" with a fresh local collaboration cache.`,
    };
  }

  return null;
}

export function EditorActivityPool(props: EditorActivityPoolProps) {
  return (
    <ProfilerBoundary name="activity-pool">
      <EditorActivityPoolInner {...props} />
    </ProfilerBoundary>
  );
}

function EditorActivityPoolInner({
  activeDocName,
  isSourceMode,
  editorPlaceholder,
  previousDocName,
  onNavigateBack,
  onRecycle,
}: EditorActivityPoolProps) {
  const { poolEntries, serverRestartRecovery } = useDocumentContext();
  const { pages, loading } = usePageList();

  const mountList = computeActivityMountList(poolEntries, activeDocName, ACTIVITY_MOUNT_LIMIT);

  // Track prior mount list by a stringified doc-name key so we emit
  // `ok/activity/mount-list-change` once per real change (not once per render).
  // The prior key is stored in a ref (not state) so the effect fires only when
  // the composition of mounted docs actually shifts. Mount lists are bounded
  // at ACTIVITY_MOUNT_LIMIT (3), so the string + diff is trivial.
  const priorMountKeyRef = useRef<string>('');
  const mountKey = mountList.map((e) => e.docName).join(',');
  // Mirror poolEntries into a ref so the layout effect below can read the
  // latest reference without listing it as a dep. takeSnapshot() in
  // DocumentContext returns a fresh array on every pool-state notification
  // (sync transitions, LRU touches), so listing poolEntries in the deps
  // would re-run the layout effect on the commit phase for every pool
  // notification — even though the effect's body is a no-op when
  // mountKey is unchanged. Reading via ref makes mountKey the only signal
  // that drives the expensive effect; the poolEventId lookup
  // is gated by `newlyMounted` being non-empty (which is itself gated by
  // mountKey changing).
  //
  // The ref-sync runs in its own useLayoutEffect (one-line write, runs in
  // commit phase) so the React Compiler doesn't flag a render-phase ref
  // mutation. The pair — cheap sync + gated expensive logic — keeps the
  // hot path (per-pool-notification re-render) at one ref write.
  const poolEntriesRef = useRef(poolEntries);
  useLayoutEffect(() => {
    poolEntriesRef.current = poolEntries;
  }, [poolEntries]);
  // Single-writer push of the activity mount list to the V2 editor cache.
  // Uses `useLayoutEffect` (not `useEffect`) so the provider
  // connect/disconnect fires BEFORE children's mount effects. Passive
  // effects run bottom-up, which means `ActivityEntry`'s
  // `mountTiptapEditor` would reparent + restore focus before the provider
  // is reconnected — leaving a window where keystrokes commit locally but
  // don't sync to peers. Layout effects run parent-first, closing the race.
  useLayoutEffect(() => {
    if (priorMountKeyRef.current === mountKey) return;
    const prior = priorMountKeyRef.current ? priorMountKeyRef.current.split(',') : [];
    const mounted = mountKey ? mountKey.split(',') : [];
    const evicted = prior.filter((d) => !mounted.includes(d));
    const newlyMounted = mounted.filter((d) => !prior.includes(d));
    // Mint or adopt a mountId for each docName entering the mount list,
    // and clear the registry entry on demote. Prefer the pool entry's
    // poolEventId (adoption invariant) so prewarm → mount → cache / sync
    // / cold marks all share one deterministic ID. Demote first so the
    // next promote-cycle for the same docName re-derives from a clean
    // slate (reset per cycle — supports first-toggle repeatability).
    for (const docName of evicted) {
      clearMountId(docName);
    }
    for (const docName of newlyMounted) {
      const entry = poolEntriesRef.current.find((e) => e.docName === docName);
      const adopted = entry?.poolEventId;
      const mountId = adopted && adopted.length > 0 ? adopted : crypto.randomUUID();
      setMountId(docName, mountId);
    }
    mark('ok/activity/mount-list-change', {
      active: activeDocName,
      mounted,
      evicted,
    });
    priorMountKeyRef.current = mountKey;
    // The cache uses this list to drive provider connect/disconnect for
    // cached-but-not-Activity-mounted editors (precedent #27(b)). Bounds
    // remote-peer CRDT load to the top ACTIVITY_MOUNT_LIMIT editors
    // regardless of how many docs are pool-resident.
    setActivityMountList(mounted);
  }, [mountKey, activeDocName]);

  return (
    <>
      {mountList.map((entry) => (
        <ActivityEntry
          key={entry.docName}
          entry={entry}
          isActive={entry.docName === activeDocName}
          isSourceMode={isSourceMode}
          editorPlaceholder={editorPlaceholder}
          isNewDoc={
            !loading && !pages.has(entry.docName) && !isManagedArtifactDocName(entry.docName)
          }
          previousDocName={previousDocName}
          onNavigateBack={onNavigateBack}
          onRecycle={onRecycle}
          serverRestartRecovery={serverRestartRecovery}
        />
      ))}
    </>
  );
}

interface ActivityEntryProps {
  entry: PoolEntrySnapshot;
  isActive: boolean;
  isSourceMode: boolean;
  editorPlaceholder?: string;
  isNewDoc: boolean;
  previousDocName?: string;
  onNavigateBack?: (previousDocName: string) => void;
  onRecycle: (docName: string) => void;
  serverRestartRecovery: ServerRestartRecoveryState;
}

/**
 * Per-Activity scroll container that (a) owns its own scroller so scrollTop
 * is DOM-local to this doc's subtree and (b) saves/restores scrollTop across
 * `<Activity>` visibility flips.
 *
 * Why both:
 *   Per-Activity scrollers are necessary but not sufficient. When `<Activity
 *   mode="hidden">` applies `display:none` to the subtree, the browser
 *   removes layout for the hidden element — `scrollTop` reads as 0, and
 *   TipTap's effect cleanup unmounts the ProseMirror DOM so `scrollHeight`
 *   collapses. By the time `isActive` flips to `false` in a layout effect,
 *   `display:none` has already been applied and `ref.current.scrollTop` is
 *   0. To capture the real scroll position, we install a `scroll` listener
 *   that records `scrollTop` on every change, so the last-non-zero value is
 *   preserved in a ref independently of Activity state transitions.
 *
 *   On the restore side, a layout effect runs a bounded per-frame poll
 *   that re-applies `scrollTop = target` whenever the browser has clamped
 *   it below target. The poll is required because the Suspense swap from
 *   warm-fallback to real-editor collapses scrollHeight transiently
 *   (re-clamping scrollTop to 0), and the editor hydrates content
 *   asynchronously after `'create'` — neither a single synchronous write
 *   nor a one-shot ResizeObserver retry survives that race. The poll
 *   ends on the first user-scroll-intent signal (wheel / touchstart) or
 *   a 2 s safety timeout.
 */
function ScrollPreservingContainer({
  isActive,
  initialScrollTop,
  children,
}: {
  isActive: boolean;
  /**
   * Seed value for `savedScrollTop` at mount. Used by the warm-skeleton
   * rename-restore path: when the new ActivityEntry mounts post-rename
   * with a captured scrollTop, we plumb it here so BOTH the Stage 1
   * synchronous write AND the Stage 2 bounded rAF re-apply target the
   * captured value (rather than the fresh-mount default of 0, which would
   * short-circuit the restore — see the early-return at the target===0
   * check). Defaults to 0 for non-rename mounts (regular doc opens,
   * recovery).
   */
  initialScrollTop?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Lazy initializer ensures the seed is captured at first render only —
  // subsequent re-renders that re-pass a stale or zero `initialScrollTop`
  // do NOT overwrite a saved value the user has since scrolled away from.
  const savedScrollTop = useRef<number>(initialScrollTop ?? 0);

  // Continuously track scrollTop via scroll listener so we always have the
  // latest user position — independent of Activity mode transitions.
  // `display:none` zeros scrollTop before any layout effect could read it,
  // so we MUST capture via scroll events to have a real value to restore.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      // Only record non-zero values — a content collapse under display:none
      // can fire a spurious scroll event with scrollTop=0 that we must NOT
      // persist (it would overwrite the real saved value).
      if (el.scrollTop > 0) savedScrollTop.current = el.scrollTop;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Restore scrollTop when `isActive` flips to true. Two stages:
  //   1. Synchronous best-effort write — cheap when content is already
  //      mounted, but NON-TERMINAL: even if it lands, the Suspense swap
  //      from warm-fallback to real-editor will collapse scrollHeight
  //      transiently and re-clamp scrollTop to 0.
  //   2. Bounded per-frame poll that re-applies scrollTop whenever the
  //      browser has clamped it below target AND scrollHeight is
  //      sufficient. Survives the warm-fallback → real-editor swap by
  //      re-applying after content hydrates back to full height.
  //
  // rAF-poll, not ResizeObserver: `ResizeObserver(el)` observes the
  // container's OWN content-box, which is sized by its parent (h-full)
  // and does not change when scrollHeight grows inside it. Polling reads
  // scrollHeight directly each frame — the signal we actually need.
  //
  // Stop conditions: wheel / touchstart from the user (unambiguous
  // scroll-intent signals — click-to-place-caret produces neither), or
  // a 2 s safety timeout that covers the large-doc cold-mount + CRDT
  // hydration window in dev.
  useLayoutEffect(() => {
    if (!isActive) return;
    const el = ref.current;
    if (!el) return;
    const target = savedScrollTop.current;
    if (target === 0) return;

    const startTs = performance.now();
    let phase2Marked = false;

    // Stage 1 — synchronous best-effort write. Mark phase1-success when it
    // lands AND content is sized; do NOT short-circuit: the Suspense
    // warm-fallback → real-editor swap can still collapse scrollHeight and
    // re-clamp scrollTop, so Stage 2's poll must remain armed.
    el.scrollTop = target;
    if (el.scrollTop === target && el.scrollHeight > target) {
      mark('ok/scroll-restore/phase1-success', {
        target,
        elapsedMs: performance.now() - startTs,
      });
    }

    // Stage 2 — bounded per-frame re-apply.
    let done = false;
    let raf = 0;
    const finish = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      clearTimeout(safetyTimer);
      el.removeEventListener('wheel', onUserInterrupt);
      el.removeEventListener('touchstart', onUserInterrupt);
    };
    const onUserInterrupt = () => finish();
    el.addEventListener('wheel', onUserInterrupt, { passive: true });
    el.addEventListener('touchstart', onUserInterrupt, { passive: true });
    const tick = () => {
      if (done) return;
      if (el.scrollTop !== target && el.scrollHeight > target) {
        el.scrollTop = target;
        if (el.scrollTop === target && !phase2Marked) {
          // At-most-once per restore session: phase2-success fires on the
          // first re-apply that lands, not every frame thereafter.
          mark('ok/scroll-restore/phase2-success', {
            target,
            elapsedMs: performance.now() - startTs,
          });
          phase2Marked = true;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const safetyTimer = setTimeout(() => {
      if (done) return;
      // Fire `abandoned` based on final DOM state, not a historical
      // success flag. The Phase 1 sync write can land then later be
      // re-clamped to 0 by the Suspense warm-fallback → real-editor
      // swap; if Stage 2 doesn't recover from that re-clamp within the
      // 2 s window, the final state is wrong and the production
      // telemetry must surface it. Also gated on
      // `scrollHeight > target` so we don't emit `abandoned` when the
      // doc legitimately shrunk below the saved target (content
      // changed; restoration was not possible). User-scroll exits via
      // `onUserInterrupt → finish` which clears the timer, so a
      // scroll-away cannot trigger a false `abandoned` here.
      if (el.scrollTop !== target && el.scrollHeight > target) {
        mark('ok/scroll-restore/abandoned', {
          target,
          elapsedMs: performance.now() - startTs,
          scrollHeight: el.scrollHeight,
          finalScrollTop: el.scrollTop,
        });
      }
      finish();
    }, 2000);

    return finish;
  }, [isActive]);

  return (
    <div
      ref={ref}
      data-testid="editor-scroll-container"
      // Toolbar exclusion zone = 3.5rem (EditorToolbar's rendered height). Four
      // load-bearing constants must move together if the toolbar height changes:
      //   - `pt-14` (here): initial-paint content reserve so doc content doesn't
      //     start behind the absolute-positioned EditorToolbar overlay.
      //   - `scroll-pt-14` (here): scroll-padding-top for native
      //     Element.scrollIntoView alignment — TiptapEditor outline-click +
      //     wiki-link anchor navigation, and editor/extensions/footnote-anchor-scroll.ts.
      //   - TOOLBAR_HEIGHT in editor/extensions/frozen-table-headers.ts: the
      //     plane frozen table header rows pin to (and the occluder block in
      //     globals.css must stay at least this tall).
      //   - TOOLBAR_OVERLAP_PX in editor/SourceEditor.tsx: CM6 ignores ancestor
      //     scroll-padding-top, so full-page source mode restates the inset via
      //     EditorView.scrollMargins. Deliberately scope-limited to source-mode —
      //     nested CM consumers of `createNestedCMExtensions` (e.g.,
      //     RawMdxFallbackCMView) are content-sized with no internal scrollport
      //     and have no programmatic scroll-into-view call sites today; adding
      //     a `scrollMargins` contribution in the shared factory would mis-align
      //     nested CM scrolls if they ever become scrollable.
      // The toolbar itself: components/EditorToolbar.tsx.
      className="editor-doc-scroll subtle-scrollbar h-full overflow-y-auto pt-14 scroll-pt-14"
      style={{ overflowAnchor: 'auto' }}
    >
      {children}
    </div>
  );
}

function SourceEditorSlot({
  entry,
  isActive,
  isSourceMode,
  editorPlaceholder,
}: {
  entry: PoolEntrySnapshot;
  isActive: boolean;
  isSourceMode: boolean;
  editorPlaceholder?: string;
}) {
  const sourceModeRequested = isActive && isSourceMode;
  const [hasLoadedSourceEditor, setHasLoadedSourceEditor] = useState(sourceModeRequested);

  useEffect(() => {
    if (sourceModeRequested) {
      setHasLoadedSourceEditor(true);
    }
  }, [sourceModeRequested]);

  if (!hasLoadedSourceEditor && !sourceModeRequested) {
    return null;
  }

  return (
    <Suspense fallback={<EditorSkeleton />}>
      <LazySourceEditor
        docName={entry.docName}
        ytext={entry.provider.document.getText('source')}
        provider={entry.provider}
        placeholder={editorPlaceholder}
        isSourceModeActive={sourceModeRequested}
      />
    </Suspense>
  );
}

function ServerRestartRecoveryPanel({ view }: { view: ServerRestartRecoveryView }) {
  const isFailed = view.kind === 'failed';
  return (
    <div
      data-slot="server-restart-recovery"
      role={isFailed ? 'alert' : 'status'}
      aria-busy={!isFailed}
      className="flex h-full flex-col items-center justify-center gap-6 p-8 text-center"
    >
      <div className="flex size-12 items-center justify-center rounded-full border bg-muted text-muted-foreground">
        {isFailed ? (
          <RefreshCw className="size-5" aria-hidden="true" />
        ) : (
          <Loader2 className="size-5 animate-spin" aria-hidden="true" />
        )}
      </div>
      <div className="flex flex-col items-center gap-1">
        <h2 className="text-lg font-medium">{view.title}</h2>
        <p className="max-w-md text-sm text-muted-foreground">{view.summary}</p>
      </div>
      {isFailed ? (
        <Button type="button" onClick={() => window.location.reload()}>
          <RefreshCw className="size-4" aria-hidden="true" />
          {view.actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

function WarmContentFallback({ html }: { html: string }) {
  return (
    <div className="tiptap-editor h-full pointer-events-none" aria-hidden="true">
      <div
        className="tiptap ProseMirror tiptap-editor-portal-content"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: editor.getHTML() routes through DOMSerializer.serializeFragment — attribute values via setAttribute(), text via createTextNode(); both escape correctly
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function ActivityEntry({
  entry,
  isActive,
  isSourceMode,
  editorPlaceholder,
  isNewDoc,
  previousDocName,
  onNavigateBack,
  onRecycle,
  serverRestartRecovery,
}: ActivityEntryProps) {
  const recoveryView = getServerRestartRecoveryView(entry.docName, serverRestartRecovery);

  // When the doc's `lifecycle.status === 'conflict'`, swap the editor
  // children for `<DiffViewBoundary>` inside the same DocumentBoundary
  // (preserving precedent #18(b)'s hybrid render tree — Suspense + error
  // scoping + sync-promise gate stay on the editor path; the swap is the
  // children, not the boundaries). The hook re-renders this Activity entry
  // when the per-doc lifecycle Y.Map changes.
  const lifecycleStatus = useLifecycleStatus(entry.docName);
  const isConflict = lifecycleStatus === 'conflict';

  // Per-Activity portal target for <EditorContent>. Stable DOM element
  // exclusively owned by THIS ActivityEntry — `useState` with a lazy
  // initializer ensures the same `HTMLDivElement` reference survives across
  // every render of this entry, including the inner TiptapEditor remount
  // triggered by the `${docName}-${isNewDoc}` key change.
  //
  // Why imperative (createElement) over JSX-rendered (<div ref={...} />):
  // JSX-rendered elements are owned by React's reconciler, which is free to
  // re-create DOM nodes under StrictMode synthetic double-invoke or future
  // reconciler rewrites. The cross-doc DOM bleed fires
  // when two editors' `view.dom` instances briefly share a parent at the
  // moment `@tiptap/react`'s `PureEditorContent.componentDidMount.init()`
  // runs — its `element.append(...editor.view.dom.parentNode.childNodes)`
  // vacuums every sibling, including foreign editors. An imperatively-held
  // div bypasses the reconciler for this one DOM node, guaranteeing the
  // portal target is exclusively this Activity's editor's parent for the
  // entire ActivityEntry lifetime.
  //
  // TiptapEditorChrome appends this target as a DOM child of its wrapper
  // (`.tiptap-editor h-full` grid container) via useLayoutEffect, then
  // renders <EditorContent> into the target via React.createPortal — so
  // editor.view.dom ends up inside an `EditorContent` refDiv inside this
  // per-Activity target, and `view.dom.parentNode.childNodes` can only
  // contain THIS editor's own nodes.
  const [portalTarget] = useState<HTMLDivElement>(() => {
    const target = document.createElement('div');
    target.setAttribute('data-ok-editor-portal', entry.docName);
    // `display: contents` removes the portal target from layout entirely
    // — its single child (`<EditorContent>`'s refDiv) becomes the effective
    // grid item of `.tiptap-editor`. The refDiv carries `grid-column:
    // content` via the explicit `.tiptap-editor-portal-content` class that
    // `TiptapEditor` passes to `<EditorContent>` (see `TiptapEditor.tsx`).
    // That class is required because `.tiptap-editor > *` selects DOM
    // direct children only — with `display: contents` on this target and
    // on the JSX `portalSlot` above it, the refDiv is a great-grandchild
    // in the DOM tree (even though it acts as a grid item for layout),
    // and the descendant selector does not match it. Result: scroll
    // geometry is identical to the pre-portal inline `<EditorContent>`
    // mount.
    target.style.display = 'contents';
    return target;
  });

  // Defer-mount gating for large docs.
  //
  // Small/medium docs keep pre-mount-both (precedent #18(b) default): mode swap
  // stays CSS-only, neither editor's effect lifecycle re-runs.
  //
  // Large docs skip the non-active editor on cold load — its initial mount
  // (CodeMirror Lezer parse for SourceEditor, ProseMirror construction for
  // TiptapEditor) runs on first toggle instead. Subsequent toggles are
  // instant because both are mounted from then on (refs track visited modes).
  //
  // The size reads from Y.Text because it's cheap O(1) post-sync (synchronous
  // length access on the CRDT). Y.Text is the markdown source representation
  // so its length reliably signals "this doc will be expensive to render".
  const ytextLength = entry.provider.document.getText('source').length;

  // Track which modes have been visited. useState (not useRef) because React
  // Compiler's Babel plugin rejects render-phase ref mutation — even though the
  // mutation here is idempotent and safe, the compiler can't prove it. State
  // with a lazy initializer + a post-commit effect is the compiler-approved
  // shape.
  //
  // Correctness note: on the render where `isSourceMode` first flips from
  // `false → true`, we need the newly-visited SourceEditor to render in THAT
  // render (not wait for an effect + rerender). `computeEditorMountGate`
  // handles this by OR-ing with `isSourceMode` directly, so even when the
  // `visitedSource` state is still false at the flipped render, the gate
  // returns `renderSource=true`. The effect then flips state, and subsequent
  // renders stay consistent.
  //
  // Activity mode=hidden preserves state across visibility flips (just like
  // refs would), so alt-tab between docs doesn't reset the visit history.
  const [visitedSource, setVisitedSource] = useState(isSourceMode);
  const [visitedVisual, setVisitedVisual] = useState(!isSourceMode);

  useEffect(() => {
    if (isSourceMode && !visitedSource) setVisitedSource(true);
    else if (!isSourceMode && !visitedVisual) setVisitedVisual(true);
  }, [isSourceMode, visitedSource, visitedVisual]);

  const gate = computeEditorMountGate({
    ytextLength,
    isSourceMode,
    visitedSource,
    visitedVisual,
  });

  // Emit a mark ONCE per real defer decision for observability — subsequent
  // renders of the same Activity don't re-emit. A `seen` key captures both
  // the decision outcome and which modes are rendered; when it changes, that's
  // a real transition worth a mark.
  const priorGateKeyRef = useRef<string>('');
  const gateKey = `${gate.isLarge}-${gate.renderSource}-${gate.renderVisual}`;
  useEffect(() => {
    if (priorGateKeyRef.current === gateKey) return;
    priorGateKeyRef.current = gateKey;
    if (gate.isLarge) {
      mark('ok/activity/defer-mount', {
        docName: entry.docName,
        ytextLength,
        isSourceMode,
        renderSource: gate.renderSource,
        renderVisual: gate.renderVisual,
      });
    }
  }, [
    gateKey,
    gate.isLarge,
    gate.renderSource,
    gate.renderVisual,
    entry.docName,
    ytextLength,
    isSourceMode,
  ]);

  // Rename-induced cold-mount carries forward the PRIOR editor's HTML + scrollTop
  // + selection so the user lands approximately where they left off. The snapshot
  // is PEEKed (not consumed-and-deleted) at lazy init time so StrictMode's
  // dev double-invoke of `useState` initializers returns the same value on both
  // invocations — a consume-and-delete here would return the snapshot on call 1
  // and null on call 2 (the committed state), which silently broke the scroll
  // restore path. The store entry is released by TiptapEditor's
  // `editor.on('create')` hook (one-shot consume) so future mounts of the
  // same docName don't see stale data.
  //
  // scrollTop is plumbed into ScrollPreservingContainer as `initialScrollTop`
  // so the container's Stage 1 (synchronous write) + Stage 2 (bounded rAF
  // re-apply until scrollHeight stabilizes past target) machinery handles
  // the warm-fallback layout race. A direct write here lost to the Stage-2
  // poll not engaging on fresh mount (savedScrollTop = 0 short-circuit) —
  // the browser clamps the synchronous write to 0 when scrollHeight is
  // still ≈ clientHeight at write-time, and the rename Suspense swap from
  // warm-fallback to real-editor re-clamps shortly after.
  //
  // Selection is NOT threaded as a prop — TiptapEditor reads it directly from
  // the snapshot store inside its `editor.on('create')` handler, applies it
  // once, then clears the store entry. Reading from the one-shot store (rather
  // than a mount-captured prop) means a later composite-key remount does NOT
  // re-apply a now-stale caret over the user's current position.
  const [warmSnapshot] = useState(() => peekRenameSnapshot(entry.docName));
  const warmHtml = warmSnapshot?.html ?? null;

  // Note: clearing of the rename-snapshot store entry lives in
  // TiptapEditor's `editor.on('create')` hook (see editor-cache.ts ↔
  // TiptapEditor.tsx). Clearing here from a useEffect would race the
  // StrictMode dev double-invoke: mount 1's effect would delete the
  // store entry before mount 2's `useState` lazy initializer re-peeks
  // it, causing the warm fallback to flash empty in dev. The 'create'
  // event fires once per editor instance, after StrictMode has settled,
  // so it's the safe consumption point.

  // Emit `ok/cold/first-toggle` exactly once per ActivityEntry, when the
  // deferred editor mounts for the first time on a large doc. For small
  // docs (pre-mount-both default) and for large docs that never get
  // toggled, this never fires.
  //
  // The effect runs AFTER React's commit phase — by which time the newly-
  // mounted editor's `ok/cold/ec-init` mark has already fired (PureEditorContent
  // initializes synchronously during render; cold-mount-instrumentation wraps
  // the method so the mark fires inside the wrapped finally block).
  const [hasEmittedFirstToggle, setHasEmittedFirstToggle] = useState(false);
  useEffect(() => {
    if (
      !shouldEmitFirstToggle({
        isLarge: gate.isLarge,
        renderSource: gate.renderSource,
        renderVisual: gate.renderVisual,
        hasEmittedFirstToggle,
      })
    ) {
      return;
    }
    mark('ok/cold/first-toggle', {
      docName: entry.docName,
      mountId: getMountId(entry.docName),
      ytextLength,
      modeEnteredFirst: isSourceMode ? 'source' : 'visual',
    });
    setHasEmittedFirstToggle(true);
  }, [
    hasEmittedFirstToggle,
    gate.isLarge,
    gate.renderSource,
    gate.renderVisual,
    entry.docName,
    ytextLength,
    isSourceMode,
  ]);

  return (
    <Activity mode={isActive ? 'visible' : 'hidden'} name={`editor:${entry.docName}`}>
      {/* Per-Activity scroll container with save/restore across Activity
          visibility flips. See ScrollPreservingContainer for the full
          rationale. Hoisting the scroller to EditorArea would make scroll
          state cross-document and collapse scrollHeight on hidden-mode
          effect cleanup. */}
      <ScrollPreservingContainer isActive={isActive} initialScrollTop={warmSnapshot?.scrollTop}>
        {recoveryView ? (
          <ServerRestartRecoveryPanel view={recoveryView} />
        ) : (
          <>
            {/* Per-Activity error + suspense scoping — see file-level docstring
            "ERROR + SUSPENSE SCOPING" for rationale. `activeDocName` passed
            to the boundary is this Activity's OWN docName (entry.docName),
            not the globally-active doc. This keeps the error state tied to
            the Activity instance: a healthy doc becoming active does not
            reset an errored doc's boundary, and revisiting an errored doc
            re-reveals the same error UI. */}
            <DocumentErrorBoundary
              activeDocName={entry.docName}
              previousDocName={previousDocName}
              onNavigateBack={onNavigateBack}
              onRecycle={onRecycle}
            >
              {/*
            Suspense fallback = `EditorSkeleton`. A static mdast→React
            preview fallback (reading disk bytes, rendered as a
            fumadocs-style tree) was tried and dropped — the visual jump
            from preview to the real editor (different typography + spacing)
            was jarring, so the neutral skeleton won. The
            perceived-first-paint budget (<500ms P95) still applies — the
            skeleton meets it trivially.
          */}
              <Suspense
                fallback={warmHtml ? <WarmContentFallback html={warmHtml} /> : <EditorSkeleton />}
              >
                <DocumentBoundary docName={entry.docName} provider={entry.provider}>
                  {isConflict ? (
                    /* While `lifecycle.status === 'conflict'` the
                       DiffViewBoundary replaces the editor children. The
                       outer DocumentBoundary's syncPromise gate + the
                       Suspense/error scopes above stay intact (precedent
                       #18(b) hybrid render tree preserved — we swap children,
                       not boundaries). Y.Doc identity is unchanged across
                       the swap, so Y.Text content + undo history survive. */
                    <DiffViewBoundary docName={entry.docName} provider={entry.provider} />
                  ) : (
                    /* Dual-editor mount with size-gated defer for large docs. Small
                  docs render both (pre-mount-both default — mode swap stays
                  CSS-only after first source visit). SourceEditor itself is
                  lazy-loaded the first time this doc is shown in source mode.
                  Large docs (>LARGE_DOC_CHAR_THRESHOLD) also defer the non-
                  active editor until its mode is visited at least once — see
                  computeEditorMountGate.

                  Stacking: the wrapper is position:relative + h-full. The
                  non-active child carries `.ok-mode-hidden`, which sets
                  `position:absolute; inset:0; pointer-events:none` alongside
                  `content-visibility:hidden + contain-intrinsic-size`. That
                  takes the hidden editor out of normal flow so its 8000px
                  reserved intrinsic size doesn't size the wrapper or any
                  shared grid row (earlier grid-based stacking sized rows to
                  the MAX intrinsic size across children, stretching the
                  visible editor to 8000px and creating bottom whitespace on
                  short docs — see globals.css §.ok-mode-hidden). */
                    <div className="flex h-full flex-col">
                      {/* Property region (WYSIWYG only — source mode surfaces the
                        raw YAML directly in CodeMirror). Managed-artifact docs
                        (skills/templates) render their own identity panel in
                        place of the document PageHeader + PropertyPanel: `name`
                        (and a skill's `scope`) are identity, not free-form
                        frontmatter, and they have no cover/icon. Regular docs get
                        PageHeader (decorative cover+icon, null when unset) +
                        PropertyPanel (frontmatter table, null when empty). */}
                      {!isSourceMode &&
                        (isManagedArtifactDocName(entry.docName) ||
                        parseProjectSkillContentDocName(entry.docName) ? (
                          <Suspense fallback={null}>
                            <ManagedArtifactProperties
                              docName={entry.docName}
                              provider={entry.provider}
                            />
                          </Suspense>
                        ) : (
                          <>
                            <PageHeader provider={entry.provider} />
                            <PropertyPanel provider={entry.provider} />
                          </>
                        ))}
                      <div className="relative flex-1">
                        {gate.renderSource ? (
                          <div className={isSourceMode ? 'h-full' : 'ok-mode-hidden h-full'}>
                            <SourceEditorSlot
                              entry={entry}
                              isActive={isActive}
                              isSourceMode={isSourceMode}
                              editorPlaceholder={editorPlaceholder}
                            />
                          </div>
                        ) : null}
                        {gate.renderVisual ? (
                          <div className={isSourceMode ? 'ok-mode-hidden h-full' : 'h-full'}>
                            <TiptapEditor
                              // The isNewDoc segment forces TipTap remount on the draft → saved
                              // transition (the flip changes the page list's membership of this
                              // docName).
                              // poolEventId ties the mount to pool-entry identity: an in-place
                              // recycle of a mounted doc (the binding staleness guard's wedge
                              // recovery) swaps entry.provider under a stable docName, and
                              // TiptapEditor's construct closure captures `provider` once
                              // (provider-stability invariant, TiptapEditor.tsx) — without a
                              // remount the rebuilt editor would bind the destroyed provider
                              // and silently write into an orphaned Y.Doc.
                              key={`${entry.docName}-${String(isNewDoc)}-${entry.poolEventId}`}
                              provider={entry.provider}
                              placeholder={editorPlaceholder}
                              isSourceMode={isSourceMode}
                              // Per-Activity exclusive portal target — see the
                              // `portalTarget` useState declaration for
                              // the bleed-prevention rationale. The target's
                              // identity is stable across this TiptapEditor's remount.
                              portalTarget={portalTarget}
                            />
                          </div>
                        ) : null}
                      </div>
                    </div>
                  )}
                </DocumentBoundary>
              </Suspense>
            </DocumentErrorBoundary>
          </>
        )}
      </ScrollPreservingContainer>
    </Activity>
  );
}
