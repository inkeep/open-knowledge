import {
  alignProjectionToDoc,
  applySplice,
  buildProjection,
  changedProjectionBlocks,
  computeBlockSplice,
  type MarkdownManager,
  type Projection,
  rebaseProjection,
  type SourceSplice,
} from '@inkeep/open-knowledge-core';
import { Extension, type JSONContent } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import {
  AllSelection,
  type EditorState,
  NodeSelection,
  Plugin,
  PluginKey,
  type Selection,
  TextSelection,
} from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type * as Y from 'yjs';
import { emitDiagnosticBreadcrumb } from '@/lib/diagnostic-breadcrumb';
import { PROJECTION_REMOTE_APPLY_META } from './extensions/autonomous-fragment-edit';
import {
  caretSourceOffsetToPmPos,
  fullPrecisionProjection,
  liveCaretPmPosToSourceOffset,
  liveToFullPos,
  pmPosToSourceOffset,
  sourceOffsetToPmPos,
} from './projection-coordinates';
import { PROJECTION_WRITE_ORIGIN, sharedUndoManagerFor } from './shared-undo-manager';

const SPLICE_DECLINED_EVENT = 'ok-projection-splice-declined';
const WRITE_DROPPED_EVENT = 'ok-projection-write-dropped';
const REBASE_DECLINED_EVENT = 'ok-projection-rebase-declined';
const REPROJECT_MISMATCH_EVENT = 'ok-projection-reproject-mismatch';
const ALIGN_DECLINED_EVENT = 'ok-projection-align-declined';
const DOC_REDERIVED_EVENT = 'ok-projection-doc-rederived';
const STALE_LOCAL_EDIT_EVENT = 'ok-projection-stale-local-edit';

interface ProjectionVisibility {
  hidden: boolean;
  stale: boolean;
  show: (() => void) | null;
}

export interface ProjectionBindingPluginState {
  undoManager: Y.UndoManager;
  binding: ProjectionBindingState;
  visibility: ProjectionVisibility;
}

export const projectionBindingKey = new PluginKey<ProjectionBindingPluginState>(
  'okProjectionBinding',
);

export function projectionUndoManager(state: EditorState): Y.UndoManager | null {
  return projectionBindingKey.getState(state)?.undoManager ?? null;
}

export function liveProjection(state: EditorState): Projection | null {
  return projectionBindingKey.getState(state)?.binding.projection ?? null;
}

/* STOP: while hidden, liveProjection and the doc lag Y.Text. Nothing may read either for
   placement until the editor is shown again, and showing it re-projects synchronously so a
   reader queued behind the switch sees the current document. */
export function setProjectionHidden(state: EditorState, hidden: boolean): void {
  const visibility = projectionBindingKey.getState(state)?.visibility;
  if (visibility === undefined) return;
  visibility.hidden = hidden;
  if (!hidden) visibility.show?.();
}

interface ProjectionBindingOptions {
  ytext: Y.Text;
  md: MarkdownManager;
  initial: Projection;
  stats?: ProjectionBindingState;
  origin: unknown;
  undoManager: Y.UndoManager;
}

/* STOP: ONE contiguous delete plus ONE insert, never a multi-range character-minimal diff --
   that is the content-loss class external-change-stale-anchor-interleave.test.ts exists to pin.
   The run must still be narrowed to the bytes that differ: rewriting shared affixes makes two
   peers editing one block each delete the shared text and insert a whole copy of it, and Yjs
   merges the deletes while keeping both inserts, so the block is duplicated. */
export function narrowSplice(before: string, splice: SourceSplice): SourceSplice {
  const { prefix, suffix } = sharedAffixes(before.slice(splice.from, splice.to), splice.text);
  return {
    from: splice.from + prefix,
    to: splice.to - suffix,
    text: splice.text.slice(prefix, splice.text.length - suffix),
  };
}

interface SharedAffixes {
  prefix: number;
  suffix: number;
}

function sharedAffixes(previous: string, next: string): SharedAffixes {
  const bound = Math.min(previous.length, next.length);
  let prefix = 0;
  while (prefix < bound && previous.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++;
  if (prefix > 0 && isHighSurrogate(next.charCodeAt(prefix - 1))) prefix--;
  let suffix = 0;
  while (
    suffix < bound - prefix &&
    previous.charCodeAt(previous.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
  )
    suffix++;
  if (suffix > 0 && isLowSurrogate(next.charCodeAt(next.length - suffix))) suffix--;
  return { prefix, suffix };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function applyToYText(ytext: Y.Text, splice: SourceSplice): void {
  if (splice.to > splice.from) ytext.delete(splice.from, splice.to - splice.from);
  if (splice.text !== '') ytext.insert(splice.from, splice.text);
}

type DeltaOp = { retain?: number; insert?: string | object; delete?: number };

/* STOP: a whole-paragraph rewrite reaches this client as one delete plus one insert that share
   most of their bytes, and mapOffsetThroughDelta collapses a caret inside a removed run onto
   that run's start -- correct for a real deletion, wrong for a replacement, which is what an
   agent edit always is. Trimming the shared affixes off the pair first leaves the caret outside
   the removed run, so ordinary retain arithmetic carries it. This is the read-side mirror of
   narrowSplice; `before` must be the source the delta's offsets index, never the post-change
   one. */
export function narrowDelta(delta: ReadonlyArray<DeltaOp>, before: string): DeltaOp[] {
  const out: DeltaOp[] = [];
  let read = 0;
  for (let index = 0; index < delta.length; index++) {
    const op = delta[index];
    const next = delta[index + 1];
    const removal = op.delete !== undefined ? op : next?.delete !== undefined ? next : undefined;
    const addition =
      typeof op.insert === 'string' ? op : typeof next?.insert === 'string' ? next : undefined;
    const pairs =
      removal !== undefined &&
      addition !== undefined &&
      removal !== addition &&
      (op.delete !== undefined || typeof op.insert === 'string');

    if (pairs && removal?.delete !== undefined && typeof addition?.insert === 'string') {
      const length = removal.delete;
      if (read + length <= before.length) {
        const inserted = addition.insert;
        const { prefix, suffix } = sharedAffixes(before.slice(read, read + length), inserted);
        if (prefix > 0) out.push({ retain: prefix });
        if (length - prefix - suffix > 0) out.push({ delete: length - prefix - suffix });
        const added = inserted.slice(prefix, inserted.length - suffix);
        if (added !== '') out.push({ insert: added });
        if (suffix > 0) out.push({ retain: suffix });
        read += length;
        index++;
        continue;
      }
    }

    out.push(op);
    if (op.retain !== undefined) read += op.retain;
    else if (op.delete !== undefined) read += op.delete;
  }
  return out;
}

export function mapOffsetThroughDelta(
  delta: ReadonlyArray<{ retain?: number; insert?: string | object; delete?: number }>,
  offset: number,
): number {
  let read = 0;
  let write = 0;
  for (const op of delta) {
    if (op.retain !== undefined) {
      if (read + op.retain > offset) return write + (offset - read);
      read += op.retain;
      write += op.retain;
      continue;
    }
    if (op.insert !== undefined) {
      write += typeof op.insert === 'string' ? op.insert.length : 1;
      continue;
    }
    if (op.delete !== undefined) {
      if (read + op.delete > offset) return write;
      read += op.delete;
    }
  }
  return write + Math.max(0, offset - read);
}

function reprojectAgainst(
  source: string,
  doc: PmNode,
  md: MarkdownManager,
  onMismatch?: (rebuiltChildren: number) => void,
): Projection | null {
  const rebuilt = buildProjection(source, md);
  if (rebuilt.doc.childCount !== doc.childCount) {
    onMismatch?.(rebuilt.doc.childCount);
    return null;
  }
  return { ...rebuilt, doc };
}

/* WARN: MarkdownManager owns a separate Schema instance, and ProseMirror matches content by
   NodeType identity. Nodes inserted without this conversion compare unequal to byte-identical
   ones and are silently dropped on the first incremental rebuild. */
function intoEditorSchema(view: EditorView, doc: PmNode): PmNode {
  return doc.type.schema === view.state.schema ? doc : view.state.schema.nodeFromJSON(doc.toJSON());
}

interface CarriedSelection {
  kind: 'text' | 'node' | 'all';
  anchor: number;
  head: number;
  nodeType: string | null;
}

function restoreSelection(doc: PmNode, at: CarriedSelection): Selection {
  if (at.kind === 'all') return new AllSelection(doc);
  const clamp = (pos: number): number => Math.max(0, Math.min(pos, doc.content.size));
  const anchor = clamp(at.anchor);
  if (at.kind === 'node') {
    const node = doc.nodeAt(anchor);
    if (node !== null && node.type.name === at.nodeType) return NodeSelection.create(doc, anchor);
    return TextSelection.near(doc.resolve(anchor));
  }
  const head = clamp(at.head);
  if (anchor === head) return TextSelection.near(doc.resolve(anchor));
  return TextSelection.between(doc.resolve(anchor), doc.resolve(head));
}

function replaceDoc(
  view: EditorView,
  doc: PmNode,
  at: CarriedSelection | null,
  remote: boolean,
): void {
  const tr = view.state.tr.replaceWith(
    0,
    view.state.doc.content.size,
    intoEditorSchema(view, doc).content,
  );
  tr.setMeta('addToHistory', false);
  if (remote) tr.setMeta(PROJECTION_REMOTE_APPLY_META, true);
  if (at !== null) tr.setSelection(restoreSelection(tr.doc, at));
  view.dispatch(tr);
}

interface ProjectionBindingState {
  projection: Projection;
  rebuilds: number;
  writes: number;
  spliceDeclines: number;
  droppedWrites: number;
  rebaseDeclines: number;
  reprojectMismatches: number;
  alignDeclines: number;
  docRederives: number;
  unchangedUpdates: number;
  staleLocalEdits: number;
}

function newBindingState(projection: Projection): ProjectionBindingState {
  return {
    projection,
    rebuilds: 1,
    writes: 0,
    spliceDeclines: 0,
    droppedWrites: 0,
    rebaseDeclines: 0,
    reprojectMismatches: 0,
    alignDeclines: 0,
    docRederives: 0,
    unchangedUpdates: 0,
    staleLocalEdits: 0,
  };
}

function projectionBindingPlugin(options: ProjectionBindingOptions): Plugin {
  const { ytext, md, origin } = options;
  const stats: ProjectionBindingState = options.stats ?? newBindingState(options.initial);
  const visibility: ProjectionVisibility = { hidden: false, stale: false, show: null };

  return new Plugin<ProjectionBindingPluginState>({
    key: projectionBindingKey,
    state: {
      init: () => ({ undoManager: options.undoManager, binding: stats, visibility }),
      apply: (_tr, value) => value,
    },
    view(view) {
      let projection = options.initial;
      let destroyed = false;
      let applyingRemote = false;

      const adopt = (next: Projection): void => {
        projection = next;
        stats.projection = next;
      };

      let declineReason = '';
      let declineFields: Readonly<Record<string, number>> = {};
      const noteDecline = (reason: string, detail?: Readonly<Record<string, number>>): void => {
        declineReason = reason;
        declineFields = detail ?? {};
      };
      const takeDecline = (): Record<string, number | string> => {
        const taken = { reason: declineReason, ...declineFields };
        declineReason = '';
        declineFields = {};
        return taken;
      };

      const alignTo = (base: Projection, doc: PmNode, site: string): Projection => {
        declineReason = '';
        const aligned = alignProjectionToDoc(base, doc, noteDecline);
        if (declineReason !== '') {
          stats.alignDeclines++;
          emitDiagnosticBreadcrumb(ALIGN_DECLINED_EVENT, {
            site,
            ...takeDecline(),
            declines: stats.alignDeclines,
          });
        }
        return aligned;
      };

      /* STOP: alignProjectionToDoc returns the caller's doc over a stale table when it cannot
         account for every child, and map.blocks.length === doc.childCount is the contract every
         splice indexes through. Adopting that pair costs the NEXT keystroke, which
         computeBlockSplice then declines or, in block 0, spells over the whole body. A doc the
         source cannot re-parse into is unrepresentable, so the source wins and the doc is
         re-derived. */
      const adoptAligned = (base: Projection, doc: PmNode, site: string): boolean => {
        const aligned = alignTo(base, doc, site);
        if (aligned.map.blocks.length === doc.childCount) {
          adopt(aligned);
          return true;
        }
        stats.docRederives++;
        emitDiagnosticBreadcrumb(
          DOC_REDERIVED_EVENT,
          {
            site,
            blocks: aligned.map.blocks.length,
            children: doc.childCount,
            rederives: stats.docRederives,
          },
          'warn',
        );
        return false;
      };

      const fullPrecision = (): Projection => {
        const full = fullPrecisionProjection(projection, md);
        if (full !== projection) stats.rebuilds++;
        return full;
      };

      const liveSelection = (): CarriedSelection => {
        const { selection, doc } = view.state;
        if (selection instanceof AllSelection) {
          return { kind: 'all', anchor: 0, head: 0, nodeType: null };
        }
        const full = fullPrecision();
        if (selection instanceof NodeSelection) {
          const at = pmPosToSourceOffset(full, liveToFullPos(full, doc, selection.from));
          return { kind: 'node', anchor: at, head: at, nodeType: selection.node.type.name };
        }
        return {
          kind: 'text',
          anchor: liveCaretPmPosToSourceOffset(full, doc, selection.anchor),
          head: liveCaretPmPosToSourceOffset(full, doc, selection.head),
          nodeType: null,
        };
      };

      const project = (source: string, carried: CarriedSelection | null, remote: boolean): void => {
        const next = buildProjection(source, md);
        stats.rebuilds++;
        const toPm = (offset: number): number =>
          carried?.kind === 'node'
            ? sourceOffsetToPmPos(next, offset)
            : caretSourceOffsetToPmPos(next, offset);
        const at =
          carried === null
            ? null
            : { ...carried, anchor: toPm(carried.anchor), head: toPm(carried.head) };
        applyingRemote = true;
        try {
          replaceDoc(view, next.doc, at, remote);
        } finally {
          applyingRemote = false;
        }
        adopt(alignTo(next, view.state.doc, 'project'));
      };

      const onYText = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
        if (transaction.origin === origin) return;
        if (visibility.hidden) {
          visibility.stale = true;
          return;
        }
        const delta = narrowDelta(event.changes.delta as never, projection.source);
        const before = liveSelection();
        project(
          ytext.toString(),
          {
            ...before,
            anchor: mapOffsetThroughDelta(delta, before.anchor),
            head: mapOffsetThroughDelta(delta, before.head),
          },
          true,
        );
      };

      visibility.show = () => {
        if (destroyed || !visibility.stale) return;
        visibility.stale = false;
        project(ytext.toString(), null, true);
      };

      ytext.observe(onYText);

      let settling = false;
      if (ytext.toString() === projection.source) {
        adopt(alignTo(projection, view.state.doc, 'mount'));
      } else {
        settling = true;
        queueMicrotask(() => {
          if (destroyed) return;
          project(ytext.toString(), null, true);
          settling = false;
        });
      }

      return {
        update(updatedView) {
          if (applyingRemote || settling) return;
          const after = updatedView.state.doc;
          if (after === projection.doc) return;

          if (visibility.stale) {
            visibility.stale = false;
            stats.staleLocalEdits++;
            emitDiagnosticBreadcrumb(
              STALE_LOCAL_EDIT_EVENT,
              { children: after.childCount, staleLocalEdits: stats.staleLocalEdits },
              'warn',
            );
            project(ytext.toString(), null, true);
            return;
          }

          const changed = changedProjectionBlocks(projection.doc, after);
          if (changed === null) {
            stats.unchangedUpdates++;
            adopt(alignTo(projection, after, 'unchanged'));
            return;
          }

          const splice = computeBlockSplice(projection, after, md, changed, noteDecline);
          if (splice === null) {
            stats.spliceDeclines++;
            emitDiagnosticBreadcrumb(
              SPLICE_DECLINED_EVENT,
              { ...takeDecline(), declines: stats.spliceDeclines },
              'warn',
            );
            project(ytext.toString(), null, false);
            return;
          }

          const nextSource = applySplice(projection.source, splice);
          const writesBytes = projection.source.slice(splice.from, splice.to) !== splice.text;
          if (writesBytes) {
            const doc = ytext.doc;
            if (doc === null) {
              stats.droppedWrites++;
              emitDiagnosticBreadcrumb(
                WRITE_DROPPED_EVENT,
                {
                  spliceFrom: splice.from,
                  spliceTo: splice.to,
                  textLength: splice.text.length,
                  children: after.childCount,
                  dropped: stats.droppedWrites,
                },
                'warn',
              );
              return;
            }
            doc.transact(
              () => applyToYText(ytext, narrowSplice(projection.source, splice)),
              origin,
            );
            stats.writes++;
          }

          const rebased = rebaseProjection(projection, after, changed, splice, noteDecline);
          if (rebased !== null) {
            adopt(rebased);
            return;
          }
          stats.rebaseDeclines++;
          emitDiagnosticBreadcrumb(REBASE_DECLINED_EVENT, {
            ...takeDecline(),
            declines: stats.rebaseDeclines,
          });

          let rebuiltChildren = -1;
          const reprojected = reprojectAgainst(nextSource, after, md, (children) => {
            rebuiltChildren = children;
          });
          stats.rebuilds++;
          if (reprojected !== null) {
            adopt(reprojected);
            return;
          }
          stats.reprojectMismatches++;
          emitDiagnosticBreadcrumb(REPROJECT_MISMATCH_EVENT, {
            rebuiltChildren,
            children: after.childCount,
            mismatches: stats.reprojectMismatches,
          });
          if (adoptAligned(buildProjection(nextSource, md), after, 'reproject-fallback')) return;
          project(nextSource, null, false);
        },
        destroy() {
          destroyed = true;
          ytext.unobserve(onYText);
        },
      };
    },
  });
}

export const PROJECTION_BINDING_EXTENSION = 'okProjectionBinding';

export interface ProjectionBindingExtensionOptions {
  ytext: Y.Text;
}

export interface ProjectionBinding {
  content: JSONContent;
  extension: Extension;
  projection: Projection;
  stats: ProjectionBindingState;
  undoManager: Y.UndoManager;
}

export function createProjectionBinding(
  options: Omit<ProjectionBindingOptions, 'initial' | 'origin' | 'undoManager'> & {
    origin?: unknown;
  },
): ProjectionBinding {
  const origin = options.origin ?? PROJECTION_WRITE_ORIGIN;
  const initial = buildProjection(options.ytext.toString(), options.md);
  const stats: ProjectionBindingState = newBindingState(initial);
  const undoManager = sharedUndoManagerFor(options.ytext);
  if (origin !== PROJECTION_WRITE_ORIGIN) undoManager.addTrackedOrigin(origin);
  const plugin = projectionBindingPlugin({ ...options, origin, initial, stats, undoManager });
  return {
    projection: initial,
    stats,
    undoManager,
    content: initial.doc.toJSON() as JSONContent,
    extension: Extension.create<ProjectionBindingExtensionOptions>({
      name: PROJECTION_BINDING_EXTENSION,
      addOptions() {
        return { ytext: options.ytext };
      },
      addProseMirrorPlugins() {
        return [plugin];
      },
      addKeyboardShortcuts() {
        return {
          'Mod-z': () => {
            undoManager.undo();
            return true;
          },
          'Shift-Mod-z': () => {
            undoManager.redo();
            return true;
          },
          'Mod-y': () => {
            undoManager.redo();
            return true;
          },
        };
      },
    }),
  };
}
