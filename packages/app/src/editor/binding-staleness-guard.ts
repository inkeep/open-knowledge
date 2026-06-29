import type { EditorState } from '@tiptap/pm/state';
import { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';
import { mark } from '../lib/perf/mark';


export interface WedgeDetail {
  externalSeq: number;
  appliedSeq: number;
}

export interface BindingStalenessGuardOptions {
  fragment: Y.XmlFragment;
  docName: string;
  onWedged: (detail: WedgeDetail) => void;
}

export function isDiverged(externalSeq: number, appliedSeq: number): boolean {
  return externalSeq > appliedSeq;
}

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

export function rateCapAllows(priorFiringTimestampsMs: readonly number[], nowMs: number): boolean {
  let inWindow = 0;
  for (const ts of priorFiringTimestampsMs) {
    if (nowMs - ts < RATE_CAP_WINDOW_MS) inWindow += 1;
  }
  return inWindow < RATE_CAP_MAX_FIRINGS;
}

const wedgeFiringsByDocName = new Map<string, number[]>();

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
  const wrappedBindings = new WeakSet<object>();

  const wrapBindingWriteBack = (state: EditorState): void => {
    const syncState = ySyncPluginKey.getState(state) as
      | { binding?: { _prosemirrorChanged?: (doc: unknown) => void } | null }
      | null
      | undefined;
    const binding = syncState?.binding;
    if (!binding) return;
    if (typeof binding._prosemirrorChanged !== 'function') {
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
    for (const [name, timestamps] of wedgeFiringsByDocName) {
      if (timestamps.every((ts) => now - ts >= RATE_CAP_WINDOW_MS)) {
        wedgeFiringsByDocName.delete(name);
      }
    }
    const prior = wedgeFiringsByDocName.get(docName) ?? [];
    const recent = prior.filter((ts) => now - ts < RATE_CAP_WINDOW_MS);
    if (!rateCapAllows(recent, now)) {
      wedgeFiringsByDocName.set(docName, recent);
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
      reported = false;
      mark.count('ok/editor/binding-wedge-recovery-error', { docName });
      console.error(`[binding-staleness-guard] wedge recovery threw for "${docName}":`, err);
    }
  };

  const handleBeforeObserverCalls = (transaction: Y.Transaction): void => {
    if (transaction.origin === ySyncPluginKey) return;
    if (!transactionTouchesFragment(transaction, fragment)) return;
    externalSeq += 1;
    if (!checkQueued) {
      checkQueued = true;
      queueMicrotask(runWedgeCheck);
    }
  };

  return new Plugin({
    state: {
      init: () => null,
      apply: (tr) => {
        if (isCatchUpApply(tr.getMeta(ySyncPluginKey))) {
          appliedSeq = externalSeq;
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
      return tr.getMeta(ySyncPluginKey) !== undefined;
    },
    view: (editorView) => {
      const doc = fragment.doc;
      if (doc == null) {
        mark.count('ok/editor/binding-guard-disarmed', { docName, reason: 'no-ydoc' });
        console.error(
          `[binding-staleness-guard] fragment has no Y.Doc for "${docName}" — staleness guard disarmed`,
        );
        return {};
      }
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
