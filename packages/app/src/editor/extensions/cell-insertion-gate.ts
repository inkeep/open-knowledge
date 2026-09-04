import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { ReplaceAroundStep, ReplaceStep } from '@tiptap/pm/transform';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { CELL_NODES } from '../table-cell-context';

const COMPONENT_NODE = 'jsxComponent';

const CANDIDATE_NODES = new Set([COMPONENT_NODE, 'table', 'tableRow', 'tableCell', 'tableHeader']);

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
          if (tr.getMeta(ySyncPluginKey)) return true;
          if (!tr.docChanged) return true;
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
