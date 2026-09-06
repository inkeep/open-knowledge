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
import { type EditorState, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type * as Y from 'yjs';
import { emitDiagnosticBreadcrumb } from '@/lib/diagnostic-breadcrumb';
import { PROJECTION_REMOTE_APPLY_META } from './extensions/autonomous-fragment-edit';
import { fullPrecisionProjection } from './projection-coordinates';
import { PROJECTION_WRITE_ORIGIN, sharedUndoManagerFor } from './shared-undo-manager';

const SPLICE_DECLINED_EVENT = 'ok-projection-splice-declined';
const WRITE_DROPPED_EVENT = 'ok-projection-write-dropped';
const REBASE_DECLINED_EVENT = 'ok-projection-rebase-declined';
const REPROJECT_MISMATCH_EVENT = 'ok-projection-reproject-mismatch';
const ALIGN_DECLINED_EVENT = 'ok-projection-align-declined';
const DOC_REDERIVED_EVENT = 'ok-projection-doc-rederived';

export interface ProjectionBindingPluginState {
  undoManager: Y.UndoManager;
  binding: ProjectionBindingState;
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

interface ProjectionBindingOptions {
  ytext: Y.Text;
  md: MarkdownManager;
  initial: Projection;
  stats?: ProjectionBindingState;
  origin: unknown;
  undoManager: Y.UndoManager;
}

/* STOP: one delete plus one insert, so changed lines land as a single fresh contiguous run.
   Narrowing this to a character-minimal diff trades a cost win for the content-loss class
   external-change-stale-anchor-interleave.test.ts exists to pin. */
function applyToYText(ytext: Y.Text, splice: SourceSplice): void {
  if (splice.to > splice.from) ytext.delete(splice.from, splice.to - splice.from);
  if (splice.text !== '') ytext.insert(splice.from, splice.text);
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

function replaceDoc(view: EditorView, doc: PmNode, at: number | null, remote: boolean): void {
  const tr = view.state.tr.replaceWith(
    0,
    view.state.doc.content.size,
    intoEditorSchema(view, doc).content,
  );
  tr.setMeta('addToHistory', false);
  if (remote) tr.setMeta(PROJECTION_REMOTE_APPLY_META, true);
  if (at !== null) {
    const pos = Math.max(0, Math.min(at, tr.doc.content.size));
    tr.setSelection(TextSelection.near(tr.doc.resolve(pos)));
  }
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
  };
}

function projectionBindingPlugin(options: ProjectionBindingOptions): Plugin {
  const { ytext, md, origin } = options;
  const stats: ProjectionBindingState = options.stats ?? newBindingState(options.initial);

  return new Plugin<ProjectionBindingPluginState>({
    key: projectionBindingKey,
    state: {
      init: () => ({ undoManager: options.undoManager, binding: stats }),
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

      const caretOffset = (): number => {
        const before = fullPrecision();
        return before.bodyOffset + before.map.pmPosToSourceOffset(view.state.selection.from);
      };

      const project = (source: string, caretAt: number | null, remote: boolean): void => {
        const next = buildProjection(source, md);
        stats.rebuilds++;
        const at =
          caretAt === null
            ? null
            : next.map.sourceOffsetToPmPos(Math.max(0, caretAt - next.bodyOffset));
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
        const carried = mapOffsetThroughDelta(event.changes.delta as never, caretOffset());
        project(ytext.toString(), carried, true);
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
            doc.transact(() => applyToYText(ytext, splice), origin);
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
