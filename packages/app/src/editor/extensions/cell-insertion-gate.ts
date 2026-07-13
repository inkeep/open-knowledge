/**
 * Cell-insertion gate — refuses placing a block jsxComponent inside a GFM table
 * cell.
 *
 * A cell's PM schema is `block+` and a jsxComponent is `group: block`, so a
 * component is schema-valid inside a cell and reachable by ordinary single-user
 * input (slash command, paste, drop, insertContent). But a GFM cell serializes
 * to one phrasing-only line, so the PM->markdown serializer flattens a cell's
 * block content and a component (whose name/props/source live outside the
 * projectable phrasing) is dropped whole — author-invisible content loss. This
 * gate makes that state unproducible at the owned insertion routes: a refused
 * insertion is a silent no-op (a filtered transaction never happened).
 *
 * The gate is a single `filterTransaction` at the transaction boundary rather
 * than per-route guards: every owned route (command tier, paste dispatcher,
 * PM-native drop) converges here, so one count-delta invariant covers all of
 * them and future routes without per-call-site wrapping.
 *
 * App-side only. Server write surfaces route through parse and cannot spell a
 * block-component-in-cell, so the gate is a client producer-input concern, not
 * a schema/serialize one — it never joins core `sharedExtensions`.
 */

import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { ReplaceAroundStep, ReplaceStep } from '@tiptap/pm/transform';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { CELL_NODES } from '../table-cell-context';

const COMPONENT_NODE = 'jsxComponent';

// A step can raise the in-cell component count two ways: it inserts the
// component directly into a cell, or it inserts a table wrapper that newly
// encloses content already holding a component (wrap-in-table around a
// selection). A step whose inserted slice carries none of these nodes cannot
// change the count, so it skips the doc walk.
const CANDIDATE_NODES = new Set([COMPONENT_NODE, 'table', 'tableRow', 'tableCell', 'tableHeader']);

/** Count of jsxComponent nodes anywhere beneath a table cell in `doc`. */
function countComponentsInCells(doc: ProseMirrorNode): number {
  let count = 0;
  const walk = (node: ProseMirrorNode, inCell: boolean): void => {
    node.forEach((child) => {
      const childInCell = inCell || CELL_NODES.has(child.type.name);
      if (childInCell && child.type.name === COMPONENT_NODE) count += 1;
      walk(child, childInCell);
    });
  };
  walk(doc, false);
  return count;
}

/** Whether a step's inserted slice contains a component or table wrapper. */
function sliceHasCandidate(slice: Slice): boolean {
  let found = false;
  slice.content.descendants((node) => {
    if (found) return false;
    if (CANDIDATE_NODES.has(node.type.name)) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

const cellInsertionGateKey = new PluginKey('cellInsertionGate');

export const CellInsertionGate = Extension.create({
  name: 'cellInsertionGate',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: cellInsertionGateKey,
        filterTransaction(tr, state) {
          // CRDT-origin transactions (remote peers, agent writes, disk load,
          // and y-undo replays) re-enter tagged with ySync meta. Rejecting one
          // would desync this client's PM view from the shared Y.Doc, so the
          // gate is producer-side only. Same origin discipline the typed
          // autolink plugin uses.
          if (tr.getMeta(ySyncPluginKey)) return true;
          if (!tr.docChanged) return true;
          // Pre-check keeps ordinary typing (and editing inside an existing
          // component-in-cell) off the doc walk: only a step inserting a
          // component or a table wrapper can raise the in-cell count.
          const candidate = tr.steps.some(
            (step) =>
              (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) &&
              sliceHasCandidate(step.slice),
          );
          if (!candidate) return true;
          return countComponentsInCells(tr.doc) <= countComponentsInCells(state.doc);
        },
      }),
    ];
  },
});
