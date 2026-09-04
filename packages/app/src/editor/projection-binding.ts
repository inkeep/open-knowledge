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
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type * as Y from 'yjs';
import { PROJECTION_WRITE_ORIGIN, sharedUndoManagerFor } from './shared-undo-manager';

const projectionBindingKey = new PluginKey('okProjectionBinding');

interface ProjectionBindingOptions {
  ytext: Y.Text;
  md: MarkdownManager;
  initial: Projection;
  stats?: ProjectionBindingState;
  origin: unknown;
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

function reprojectAgainst(source: string, doc: PmNode, md: MarkdownManager): Projection | null {
  const rebuilt = buildProjection(source, md);
  if (rebuilt.doc.childCount !== doc.childCount) return null;
  return { ...rebuilt, doc };
}

/* WARN: MarkdownManager owns a separate Schema instance, and ProseMirror matches content by
   NodeType identity. Nodes inserted without this conversion compare unequal to byte-identical
   ones and are silently dropped on the first incremental rebuild. */
function intoEditorSchema(view: EditorView, doc: PmNode): PmNode {
  return doc.type.schema === view.state.schema ? doc : view.state.schema.nodeFromJSON(doc.toJSON());
}

function replaceDoc(view: EditorView, doc: PmNode, at: number | null): void {
  const tr = view.state.tr.replaceWith(
    0,
    view.state.doc.content.size,
    intoEditorSchema(view, doc).content,
  );
  tr.setMeta('addToHistory', false);
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
}

function projectionBindingPlugin(options: ProjectionBindingOptions): Plugin {
  const { ytext, md, origin } = options;

  return new Plugin({
    key: projectionBindingKey,
    view(view) {
      let projection = options.initial;
      let destroyed = false;
      const stats: ProjectionBindingState = options.stats ?? {
        projection,
        rebuilds: 1,
        writes: 0,
      };
      let applyingRemote = false;

      const adopt = (next: Projection): void => {
        projection = next;
        stats.projection = next;
      };

      const fullPrecision = (): Projection => {
        if (projection.map.precision === 'full') return projection;
        stats.rebuilds++;
        return buildProjection(projection.source, md);
      };

      const caretOffset = (): number => {
        const before = fullPrecision();
        return before.bodyOffset + before.map.pmPosToSourceOffset(view.state.selection.from);
      };

      const project = (source: string, caretAt: number | null): void => {
        const next = buildProjection(source, md);
        stats.rebuilds++;
        const at =
          caretAt === null
            ? null
            : next.map.sourceOffsetToPmPos(Math.max(0, caretAt - next.bodyOffset));
        applyingRemote = true;
        try {
          replaceDoc(view, next.doc, at);
        } finally {
          applyingRemote = false;
        }
        adopt(alignProjectionToDoc(next, view.state.doc));
      };

      const onYText = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
        if (transaction.origin === origin) return;
        const carried = mapOffsetThroughDelta(event.changes.delta as never, caretOffset());
        project(ytext.toString(), carried);
      };

      ytext.observe(onYText);

      let settling = false;
      if (ytext.toString() === projection.source) {
        adopt(alignProjectionToDoc(projection, view.state.doc));
      } else {
        settling = true;
        queueMicrotask(() => {
          if (destroyed) return;
          project(ytext.toString(), null);
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
            adopt(alignProjectionToDoc(projection, after));
            return;
          }

          const splice = computeBlockSplice(projection, after, md, changed);
          if (splice === null) {
            project(ytext.toString(), null);
            return;
          }

          const nextSource = applySplice(projection.source, splice);
          const writesBytes = projection.source.slice(splice.from, splice.to) !== splice.text;
          if (writesBytes) {
            const doc = ytext.doc;
            if (doc === null) return;
            doc.transact(() => applyToYText(ytext, splice), origin);
            stats.writes++;
          }

          const rebased = rebaseProjection(projection, after, changed, splice);
          if (rebased !== null) {
            adopt(rebased);
            return;
          }
          const reprojected = reprojectAgainst(nextSource, after, md);
          stats.rebuilds++;
          adopt(reprojected ?? alignProjectionToDoc(buildProjection(nextSource, md), after));
        },
        destroy() {
          destroyed = true;
          ytext.unobserve(onYText);
        },
      };
    },
  });
}

export interface ProjectionBinding {
  content: JSONContent;
  extension: Extension;
  projection: Projection;
  stats: ProjectionBindingState;
  undoManager: Y.UndoManager;
}

export function createProjectionBinding(
  options: Omit<ProjectionBindingOptions, 'initial' | 'origin'> & { origin?: unknown },
): ProjectionBinding {
  const origin = options.origin ?? PROJECTION_WRITE_ORIGIN;
  const initial = buildProjection(options.ytext.toString(), options.md);
  const stats: ProjectionBindingState = { projection: initial, rebuilds: 1, writes: 0 };
  const undoManager = sharedUndoManagerFor(options.ytext);
  if (origin !== PROJECTION_WRITE_ORIGIN) undoManager.addTrackedOrigin(origin);
  const plugin = projectionBindingPlugin({ ...options, origin, initial, stats });
  return {
    projection: initial,
    stats,
    undoManager,
    content: initial.doc.toJSON() as JSONContent,
    extension: Extension.create({
      name: 'okProjectionBinding',
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
