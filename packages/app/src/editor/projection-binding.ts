/**
 * Binds a ProseMirror view directly to `Y.Text('source')` — no XmlFragment.
 *
 * This is the single-CRDT target's client half. The ProseMirror document is a
 * per-client *projection* of the markdown: derived on read, never synced, and
 * rebuilt when the markdown changes underneath it. A local edit is translated
 * back into one `Y.Text` splice under the user's own origin. There is no second
 * replica, so there is nothing to reconcile — none of the bridge's guards,
 * kill-switches or circuit breakers has a counterpart on this side.
 *
 * Two properties are load-bearing and easy to lose:
 *
 * **The write is block-scoped.** Only the edited top-level block is
 * re-serialized (0.05 ms flat at every document size, against 181 ms to
 * re-serialize a 488 KB document), and only its line range is rewritten. That
 * second half is a correctness property, not just a cost one: a whole-document
 * serialize renormalizes blocks the user never touched, which changes bytes on
 * disk and produces spurious git diffs. See `core/projection/block-splice.ts`.
 *
 * **The write is one contiguous replacement.** The splice deletes a whole line
 * range and inserts a whole replacement, so changed lines land as one fresh
 * contiguous run. Do not "optimize" this into a character-minimal diff — that
 * trades a cost win for the content-loss class
 * `external-change-stale-anchor-interleave` exists to pin.
 *
 * The binding never re-parses the document on a keystroke: after each write the
 * projection is rebased arithmetically (`rebaseProjection`). A parse happens
 * only when the markdown changes from outside — an agent write, a file watcher,
 * another client — which is orders of magnitude rarer than typing.
 */

import {
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

/**
 * Emergency kill switch for the projection path. `false` keeps every editor on
 * the XmlFragment binding; nothing below runs. Flip to `true` to derive the
 * WYSIWYG document from `Y.Text` instead.
 *
 * Both paths coexist deliberately during the migration — the fragment binding
 * is still what production uses, and is not removed until the bridge is (Phase
 * 3). A build with this on must not also be running the server-side bridge
 * observers against the same document: two writers on `Y.Text`, one of them
 * deriving from a fragment the client no longer updates, converge on the
 * fragment's stale content.
 */
export const PROJECTION_BINDING_ENABLED = false;

declare global {
  interface Window {
    /** Dev-only projection-path toggle — see `projectionBindingEnabled`. */
    __okProjectionBinding?: boolean;
  }
}

/**
 * Whether this editor binds the projection or the fragment.
 *
 * The constant above is the shipping decision. The two dev-only channels below
 * exist because the path has to be *typed on* before it can be trusted — every
 * property here is asserted by test, but no human has yet put a caret in it —
 * and requiring a source edit plus a rebuild to try it makes that exercise
 * something people skip:
 *
 *   VITE_OK_PROJECTION_BINDING=1 pnpm --dir packages/desktop run dev
 *
 * or, in DevTools, set `window.__okProjectionBinding` to true and reload.
 * (Spelled in prose rather than as an assignment on purpose: the
 * `no ungated window.__ writes` STOP rule scans lines, not syntax, and a
 * pasteable assignment here reads to it as a real ungated write. This module
 * only ever READS that global.)
 *
 * `import.meta.env.PROD` is replaced with a literal by Vite, so the whole
 * override body is unreachable — and tree-shakeable — in a production build.
 * Turning this on must NOT be combined with the server-side bridge observers on
 * the same document: Observer A would keep writing `Y.Text` from a fragment the
 * client no longer updates.
 */
export function projectionBindingEnabled(): boolean {
  if (PROJECTION_BINDING_ENABLED) return true;
  if (import.meta.env.PROD === true) return false;
  if (typeof window !== 'undefined' && window.__okProjectionBinding === true) return true;
  return import.meta.env.VITE_OK_PROJECTION_BINDING === '1';
}

const projectionBindingKey = new PluginKey('okProjectionBinding');

interface ProjectionBindingOptions {
  ytext: Y.Text;
  md: MarkdownManager;
  /**
   * The projection the editor is being CONSTRUCTED with.
   *
   * ProseMirror builds its plugin views inside the `EditorView` constructor, and
   * TipTap's `dispatchTransaction` reaches for a `this.view` that does not exist
   * yet at that moment — so a binding cannot install its document by dispatching
   * from `view()`. It has to arrive as the editor's initial content instead, and
   * the plugin has to be told which projection that content came from. Getting
   * this wrong is not a rendering glitch: the binding would see the editor's
   * empty starting document as a local edit and write it over the markdown.
   */
  initial: Projection;
  /**
   * Mutable counters the binding writes as it runs. Held by the caller rather
   * than read out of plugin state so a test can assert the cost model directly:
   * a keystroke must not re-parse the document, and the only way to see that is
   * to watch `rebuilds` stay put across a typing run.
   */
  stats?: ProjectionBindingState;
  /**
   * Stamped on every write this client makes, and the origin a shared
   * `Y.UndoManager` tracks. It is what makes one undo stack possible: source
   * mode and WYSIWYG write the same type under origins the same manager
   * follows, so the most recent edit retracts whichever view made it.
   */
  origin: unknown;
}

/** Apply a computed splice to the CRDT as one delete plus one insert. */
function applyToYText(ytext: Y.Text, splice: SourceSplice): void {
  if (splice.to > splice.from) ytext.delete(splice.from, splice.to - splice.from);
  if (splice.text !== '') ytext.insert(splice.from, splice.text);
}

/** Carry a source offset across a `Y.Text` delta from someone else's write. */
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
      // Inside the removed run: collapse onto its start, the only position that
      // still exists.
      if (read + op.delete > offset) return write;
      read += op.delete;
    }
  }
  return write + Math.max(0, offset - read);
}

/**
 * Re-derive a projection for a document the editor already holds.
 *
 * Used when a splice cannot be rebased arithmetically (a multi-block edit).
 * The PM document is the editor's, not the parse's: adopting the parse's
 * document would silently replace what the user is looking at. The two must
 * agree on block count for the map to index, and when they do not the caller
 * has genuinely diverged and rebuilds from the markdown instead.
 */
function reprojectAgainst(source: string, doc: PmNode, md: MarkdownManager): Projection | null {
  const rebuilt = buildProjection(source, md);
  if (rebuilt.doc.childCount !== doc.childCount) return null;
  return { ...rebuilt, doc };
}

/**
 * Move a projected document into the editor's own `Schema`.
 *
 * `MarkdownManager` builds a schema of its own, so a projection's nodes carry
 * `NodeType`s from a different instance than the editor's. ProseMirror matches
 * content by NodeType IDENTITY, so those nodes are not merely unequal to the
 * editor's — inserted directly they are silently dropped on the first
 * incremental rebuild. The JSON round trip is the conversion, and it is why the
 * binding adopts `view.state.doc` after every dispatch: from that point on both
 * sides of every comparison come from the editor's schema, and the cheap
 * identity check in `changedProjectionBlocks` means what it says.
 */
function intoEditorSchema(view: EditorView, doc: PmNode): PmNode {
  return doc.type.schema === view.state.schema ? doc : view.state.schema.nodeFromJSON(doc.toJSON());
}

/** Replace the whole document, optionally landing the caret at `at`. */
function replaceDoc(view: EditorView, doc: PmNode, at: number | null): void {
  const tr = view.state.tr.replaceWith(
    0,
    view.state.doc.content.size,
    intoEditorSchema(view, doc).content,
  );
  // Y.js origins, not ProseMirror history, decide what is undoable here; this
  // keeps a remote rewrite out of any local PM history that happens to be on.
  tr.setMeta('addToHistory', false);
  if (at !== null) {
    const pos = Math.max(0, Math.min(at, tr.doc.content.size));
    tr.setSelection(TextSelection.near(tr.doc.resolve(pos)));
  }
  view.dispatch(tr);
}

interface ProjectionBindingState {
  /** The projection believed to match both the CRDT and the editor document. */
  projection: Projection;
  /** How many times the document had to be re-parsed from scratch. */
  rebuilds: number;
  /** How many local edits were written as a block splice. */
  writes: number;
}

/**
 * The plugin. Its `view` owns the binding's whole lifecycle: initial
 * projection, the `Y.Text` observer, the local-edit write path, and teardown.
 */
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
      // The one reentrancy that exists here: the dispatch that lands a remote
      // change would otherwise look like a local edit to `update` and be
      // written straight back out.
      let applyingRemote = false;

      const adopt = (next: Projection): void => {
        projection = next;
        stats.projection = next;
      };

      /**
       * A full-precision map of the state the projection currently describes.
       *
       * A rebased map resolves only to block granularity, which is all the
       * write path needs but not enough to carry a caret. The bytes it would be
       * built from are the projection's own, so this is exact rather than a
       * guess — and it costs a parse only when someone else edits, never on a
       * keystroke.
       */
      const fullPrecision = (): Projection => {
        if (projection.map.precision === 'full') return projection;
        // Counted, because it IS a parse: an outside write that lands after a
        // typing burst pays two — one to read the caret precisely, one to build
        // the new document. Both are on the outside-write path, never on a
        // keystroke, which is the budget that matters.
        stats.rebuilds++;
        return buildProjection(projection.source, md);
      };

      /** Full-source offset of the caret, or null when it cannot be placed. */
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
        // The dispatch reuses the projection's own node objects, so the
        // identity-based change detection stays meaningful on the next
        // keystroke.
        adopt({ ...next, doc: view.state.doc });
      };

      const onYText = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
        if (transaction.origin === origin) return;
        const carried = mapOffsetThroughDelta(event.changes.delta as never, caretOffset());
        project(ytext.toString(), carried);
      };

      ytext.observe(onYText);

      // The editor was constructed from `initial`, but the CRDT can have moved
      // between building that projection and mounting — a sync landing, an
      // agent write. Reconcile out of line rather than by dispatching from
      // inside the constructor, and refuse to write anything until it settles:
      // the safe direction under uncertainty is the CRDT's, never the
      // editor's.
      // The check is on the BYTES, not on the two documents. `initial.doc` came
      // from the markdown manager's schema and `view.state.doc` from the
      // editor's, so `eq` between them is false however identical they look —
      // it compares NodeType identity. The source string is the thing that can
      // actually have moved, and it answers the question exactly.
      let settling = false;
      if (ytext.toString() === projection.source) {
        adopt({ ...projection, doc: view.state.doc });
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
            adopt({ ...projection, doc: after });
            return;
          }

          const splice = computeBlockSplice(projection, after, md, changed);
          if (splice === null) {
            // The edit could not be placed against the block table this
            // projection was built from — the two have drifted. Re-derive the
            // document FROM the CRDT and discard the unplaceable edit: writing
            // at offsets that may be stale is the one outcome worse than losing
            // a keystroke, because it corrupts bytes the user cannot see. Not
            // reachable while the block table and the document stay in step,
            // which the rebase maintains; this is the net under that.
            project(ytext.toString(), null);
            return;
          }

          const nextSource = applySplice(projection.source, splice);
          const doc = ytext.doc;
          if (doc === null) return;
          doc.transact(() => applyToYText(ytext, splice), origin);
          stats.writes++;

          const rebased = rebaseProjection(projection, after, changed, splice);
          if (rebased !== null) {
            adopt(rebased);
            return;
          }
          const reprojected = reprojectAgainst(nextSource, after, md);
          stats.rebuilds++;
          adopt(reprojected ?? { ...buildProjection(nextSource, md), doc: after });
        },
        destroy() {
          destroyed = true;
          ytext.unobserve(onYText);
        },
      };
    },
  });
}

/**
 * The two halves of a projection binding, which must be produced together.
 *
 * `content` is the editor's initial document and `extension` carries the plugin
 * that was told about it. Splitting them across two calls would let a caller
 * construct the editor from one projection and bind the plugin to another; the
 * binding would then read the difference as a local edit and write the wrong
 * document into the CRDT. One call, one projection.
 */
export interface ProjectionBinding {
  content: JSONContent;
  extension: Extension;
  projection: Projection;
  /** Live counters — see `ProjectionBindingOptions.stats`. */
  stats: ProjectionBindingState;
  /** The document's one undo manager, shared with source mode. */
  undoManager: Y.UndoManager;
}

/**
 * Project the markdown and produce the editor content, extension and undo
 * manager for it.
 *
 * Undo ships here rather than as a separate opt-in because it is the same
 * decision: a surface that writes `Y.Text` under a tracked origin must send its
 * undo to the manager that tracks that origin. Wiring the write without the
 * undo would leave `Mod-z` on whatever history happened to be installed, which
 * for this editor is nothing — `sharedExtensions` disables StarterKit's
 * undo/redo because collaboration owns history.
 *
 * `origin` defaults to `PROJECTION_WRITE_ORIGIN`, the origin the shared manager
 * tracks. Passing a different one is for tests that want to watch the origin;
 * a caller that overrides it in production silently loses undo.
 */
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
        // Straight to the shared manager. There is no ProseMirror history to
        // consult and no second stack to reconcile with — that is the point.
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
