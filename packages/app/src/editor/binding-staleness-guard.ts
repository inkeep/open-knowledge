import type { EditorState } from '@tiptap/pm/state';
import { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';
import { mark } from '../lib/perf/mark';

/**
 * Binding staleness guard.
 *
 * Defends the client-side bridge invariant: a y-prosemirror binding whose
 * Y→PM apply half has stopped (a "wedged" binding) must never re-publish its
 * stale PM replica wholesale over newer CRDT state. The ySyncPlugin's
 * `view.update` callback runs `_prosemirrorChanged(view.state.doc)` on EVERY
 * view-state update — selection-only transactions included — diffing the full
 * PM doc against the fragment and emitting ops for any difference
 * (y-tiptap.cjs:271-307, 737-745). With a frozen PM doc and a live provider,
 * one click resurrects minutes-old content as fresh edits.
 *
 * Three cooperating parts, per-EditorView closure state:
 *  - divergence counters: `externalSeq` bumps once per external
 *    fragment-changing Y transaction; `appliedSeq` catches up to it whenever
 *    a full-re-render y-sync apply lands (one apply derives from the CURRENT
 *    fragment, so it heals any backlog).
 *  - publication gate: while diverged, `filterTransaction` rejects every
 *    transaction without `ySyncPluginKey` meta, closing the
 *    `view.update → updateYFragment` resurrection channel while still
 *    admitting a late catch-up apply (which reopens the gate by itself).
 *  - wedge trigger: a deferred (microtask) check fires `onWedged` once per
 *    divergence episode (a catch-up apply ends the episode and re-arms the
 *    trigger), rate-capped per docName, so the caller can recycle the wedged
 *    editor through the existing pool machinery. Past the cap the gate keeps
 *    blocking — harm prevention never relaxes.
 *
 * Vendored-source line citations (`y-tiptap.cjs:N`) refer to
 * `@tiptap/y-tiptap` 3.0.3 — re-verify them when bumping that dependency.
 *
 * The external-bump hook is `doc.on('beforeObserverCalls')`, NOT
 * `fragment.observeDeep`: Y.js calls type observers in registration order,
 * and the binding's own deep observer may be registered before this plugin's
 * view init. `beforeObserverCalls` fires before ALL type observers
 * (yjs cleanupTransactions), so the bump strictly precedes any synchronous
 * binding apply in the same cascade — the counters are settled by cascade
 * end regardless of registration order, and a healthy binding can never be
 * observed as diverged from `filterTransaction`.
 */

export interface WedgeDetail {
  externalSeq: number;
  appliedSeq: number;
}

export interface BindingStalenessGuardOptions {
  fragment: Y.XmlFragment;
  docName: string;
  onWedged: (detail: WedgeDetail) => void;
}

/** A binding is diverged when external fragment changes outpace its applies. */
export function isDiverged(externalSeq: number, appliedSeq: number): boolean {
  return externalSeq > appliedSeq;
}

/**
 * True when a transaction's `ySyncPluginKey` meta marks a full re-render
 * from the CURRENT fragment — the only applies that heal the backlog:
 *  - `isChangeOrigin: true` — `_typeChanged` / `_forceRerender`
 *    (y-tiptap.cjs:724-730)
 *  - `snapshot: null, prevSnapshot: null` — the `unrenderSnapshot` exit
 *    re-render (y-tiptap.cjs:501-520)
 * Snapshot ENTER metas (non-null snapshot) render historical state, not the
 * current fragment, and must not count.
 */
export function isCatchUpApply(meta: unknown): boolean {
  if (typeof meta !== 'object' || meta === null) return false;
  const change = meta as Record<string, unknown>;
  if (change.isChangeOrigin === true) return true;
  return (
    'snapshot' in change &&
    'prevSnapshot' in change &&
    change.snapshot === null &&
    change.prevSnapshot === null
  );
}

const RATE_CAP_MAX_FIRINGS = 3;
const RATE_CAP_WINDOW_MS = 60_000;

/** At most 3 wedge firings per docName per rolling 60s window. */
export function rateCapAllows(priorFiringTimestampsMs: readonly number[], nowMs: number): boolean {
  let inWindow = 0;
  for (const ts of priorFiringTimestampsMs) {
    if (nowMs - ts < RATE_CAP_WINDOW_MS) inWindow += 1;
  }
  return inWindow < RATE_CAP_MAX_FIRINGS;
}

// Rate-cap registry survives plugin instances on purpose: a persistent wedge
// inducer re-wedges every recycled mount of the same doc, and the cap is what
// breaks that loop (mirrors the disconnect-recycle debounce discipline).
// FAILED recovery attempts (onWedged throws) consume cap slots exactly like
// successful ones, by design: the slot is recorded before dispatch so a
// persistently-throwing recycle path retries at most RATE_CAP_MAX_FIRINGS per
// window (sliding-window backoff) instead of at external-bump rate. The gate
// stays closed throughout either way; the catch emits
// `ok/editor/binding-wedge-recovery-error` so dashboards can tell
// capped-after-throws from capped-after-real-recycles.
const wedgeFiringsByDocName = new Map<string, number[]>();

/**
 * Whether a Y transaction changed `fragment` or anything inside it. Runs at
 * `beforeObserverCalls` time, when `transaction.changedParentTypes` is still
 * EMPTY (yjs populates it inside the observer phase, via callTypeObservers'
 * ancestor walk) — so this walks the same `_item.parent` chain from
 * `transaction.changed`, which Item.integrate/Item.delete populate during the
 * mutation itself.
 */
function transactionTouchesFragment(transaction: Y.Transaction, fragment: Y.XmlFragment): boolean {
  for (const changedType of transaction.changed.keys()) {
    let current: unknown = changedType;
    while (current != null) {
      if (current === fragment) return true;
      const item = (current as { _item?: { parent: unknown } | null })._item;
      current = item == null ? null : item.parent;
    }
  }
  return false;
}

function isSnapshotActive(state: EditorState): boolean {
  // Either field non-null means PM intentionally renders historical state and
  // the write-back channel is already closed (y-tiptap.cjs:187-190, 273-275)
  // — no harm channel, so neither the gate nor the trigger may act.
  const syncState = ySyncPluginKey.getState(state) as
    | { snapshot?: unknown; prevSnapshot?: unknown }
    | null
    | undefined;
  return syncState?.snapshot != null || syncState?.prevSnapshot != null;
}

export function bindingStalenessGuardPlugin(options: BindingStalenessGuardOptions): Plugin {
  const { fragment, docName, onWedged } = options;

  let externalSeq = 0;
  let appliedSeq = 0;
  let reported = false;
  let active = false;
  let checkQueued = false;
  let viewRef: EditorView | null = null;
  // One wrap per binding instance even across view() re-init (StrictMode
  // double-mount and park/revive re-run plugin views on the SAME plugin
  // instance, hence the same closure).
  const wrappedBindings = new WeakSet<object>();

  /**
   * Close the publication side-channel. `filterTransaction` is not enough:
   * a filtered transaction still reaches `view.updateState`, and ProseMirror
   * runs every pluginView `update` callback even when the state did not
   * change — the ySyncPlugin's update callback then unconditionally runs
   * `binding._prosemirrorChanged(view.state.doc)` (y-tiptap.cjs:271-307),
   * publishing the stale PM doc wholesale. The binding instance is exposed
   * on the y-sync plugin state (y-tiptap.cjs:201), so refuse publication at
   * the seam itself while diverged; healthy bindings never observe a
   * diverged window here because the counters settle synchronously within
   * the external transaction's observer cascade.
   */
  const wrapBindingWriteBack = (state: EditorState): void => {
    const syncState = ySyncPluginKey.getState(state) as
      | { binding?: { _prosemirrorChanged?: (doc: unknown) => void } | null }
      | null
      | undefined;
    const binding = syncState?.binding;
    // No binding in y-sync state at all (collab disabled, or no ySyncPlugin)
    // is benign — there is no write-back channel to gate.
    if (!binding) return;
    if (typeof binding._prosemirrorChanged !== 'function') {
      // Binding present but the seam is gone = the vendored y-tiptap contract
      // changed under us. Fail open (don't crash the editor) but loudly: half
      // the publication gate is disarmed.
      mark.count('ok/editor/binding-guard-disarmed', {
        docName,
        reason: 'no-prosemirror-changed',
      });
      console.warn(
        `[binding-staleness-guard] ySync binding on "${docName}" exposes no _prosemirrorChanged — write-back gate disarmed (vendored y-tiptap contract change?)`,
      );
      return;
    }
    if (wrappedBindings.has(binding)) return;
    wrappedBindings.add(binding);
    const original = binding._prosemirrorChanged.bind(binding);
    binding._prosemirrorChanged = (doc: unknown): void => {
      if (isDiverged(externalSeq, appliedSeq)) return;
      original(doc);
    };
  };

  const runWedgeCheck = (): void => {
    checkQueued = false;
    if (!active || reported) return;
    if (!isDiverged(externalSeq, appliedSeq)) return;
    if (viewRef !== null && isSnapshotActive(viewRef.state)) return;
    reported = true;
    const now = Date.now();
    // Prune registry keys whose timestamps have all aged out of the window —
    // they can no longer influence rateCapAllows (absent and all-stale are
    // equivalent through `get(...) ?? []` + the in-window filter), so
    // deleting them keeps the session-lifetime map bounded to
    // recently-wedged docs. In-window entries survive: the cap must keep
    // counting across recycled plugin instances.
    for (const [name, timestamps] of wedgeFiringsByDocName) {
      if (timestamps.every((ts) => now - ts >= RATE_CAP_WINDOW_MS)) {
        wedgeFiringsByDocName.delete(name);
      }
    }
    const prior = wedgeFiringsByDocName.get(docName) ?? [];
    const recent = prior.filter((ts) => now - ts < RATE_CAP_WINDOW_MS);
    if (!rateCapAllows(recent, now)) {
      wedgeFiringsByDocName.set(docName, recent);
      // Terminal state for this doc: the gate stays closed and no further
      // recycles occur until a catch-up apply ends the episode (un-latching
      // `reported`) AND the rate window has slid — the window sliding alone
      // never re-attempts. The success path's
      // `ok/editor/binding-wedge-recycle` mark never fires here, so emit a
      // dedicated counter — without it, dashboards show 3 recycle attempts
      // and nothing distinguishing "recovered" from "capped out".
      mark.count('ok/editor/binding-wedge-rate-capped', { docName });
      console.warn(
        `[binding-staleness-guard] wedge on "${docName}" rate-capped (externalSeq=${externalSeq}, appliedSeq=${appliedSeq}) — publication gate stays closed, no further recycle`,
      );
      return;
    }
    recent.push(now);
    wedgeFiringsByDocName.set(docName, recent);
    console.warn(
      `[binding-staleness-guard] wedged binding on "${docName}" — Y→PM apply missing (externalSeq=${externalSeq}, appliedSeq=${appliedSeq})`,
    );
    try {
      onWedged({ externalSeq, appliedSeq });
    } catch (err) {
      // onWedged runs caller recovery (pool recycle → provider teardown +
      // reconstruction) from a microtask, where a throw is unreachable by
      // React error boundaries. Containing it here is the only way a retry
      // ever happens: un-latch so the next external bump re-attempts. The
      // rate cap (timestamp recorded above) bounds the retry loop, and the
      // publication gate stays closed throughout.
      reported = false;
      mark.count('ok/editor/binding-wedge-recovery-error', { docName });
      console.error(`[binding-staleness-guard] wedge recovery threw for "${docName}":`, err);
    }
  };

  const handleBeforeObserverCalls = (transaction: Y.Transaction): void => {
    // The binding's own PM→Y write-backs transact with `ySyncPluginKey` as
    // origin (y-tiptap.cjs:300-303, 738-744) — they are not pending applies.
    if (transaction.origin === ySyncPluginKey) return;
    if (!transactionTouchesFragment(transaction, fragment)) return;
    externalSeq += 1;
    // Deferred past the observer cascade: the binding's apply dispatch is
    // synchronous within the same cascade, so checking here would always
    // observe a transient backlog on healthy bindings.
    if (!checkQueued) {
      checkQueued = true;
      queueMicrotask(runWedgeCheck);
    }
  };

  return new Plugin({
    state: {
      init: () => null,
      // Catch-up lives here, not in filterTransaction: filterTransaction may
      // run for transactions another plugin subsequently rejects, while
      // state.apply runs only for transactions that actually landed.
      apply: (tr) => {
        if (isCatchUpApply(tr.getMeta(ySyncPluginKey))) {
          appliedSeq = externalSeq;
          // A heal ends the divergence episode: a later re-wedge on this
          // same instance is a NEW episode and must be able to report again
          // (the per-docName rate cap still bounds recycle attempts).
          // Transition-gated counter (NOT per-apply — catch-up applies fire
          // on every healthy remote update): emitted only when a REPORTED
          // wedge episode ends, closing the recycle-initiated → recovered
          // observability loop next to `binding-wedge-recycle`.
          if (reported) {
            mark.count('ok/editor/binding-wedge-recovered', { docName });
          }
          reported = false;
        }
        return null;
      },
    },
    filterTransaction: (tr, state) => {
      if (!isDiverged(externalSeq, appliedSeq)) return true;
      if (isSnapshotActive(state)) return true;
      // Any y-sync-tagged transaction is admitted while diverged so a late
      // apply can land and reopen the gate; everything else is the
      // resurrection channel.
      return tr.getMeta(ySyncPluginKey) !== undefined;
    },
    view: (editorView) => {
      const doc = fragment.doc;
      if (doc == null) {
        // `provider.document.getXmlFragment(...)` always integrates the
        // fragment, so a null `.doc` means an unintegrated fragment — the
        // guard has no external-bump source and can never close the gate.
        // Fail open (the editor keeps working unguarded) but loudly: a
        // silent disarm here is the exact failure mode the guard exists to
        // surface.
        mark.count('ok/editor/binding-guard-disarmed', { docName, reason: 'no-ydoc' });
        console.error(
          `[binding-staleness-guard] fragment has no Y.Doc for "${docName}" — staleness guard disarmed`,
        );
        return {};
      }
      // view() can run again on the SAME plugin instance after destroy()
      // (StrictMode double-mount, parked-editor revive) — re-arm rather
      // than latch, and off-before-on so the handler never double-registers.
      active = true;
      viewRef = editorView;
      wrapBindingWriteBack(editorView.state);
      doc.off('beforeObserverCalls', handleBeforeObserverCalls);
      doc.on('beforeObserverCalls', handleBeforeObserverCalls);
      return {
        destroy: () => {
          active = false;
          viewRef = null;
          doc.off('beforeObserverCalls', handleBeforeObserverCalls);
        },
      };
    },
  });
}
