
import type { List, ListItem } from 'mdast';
import { EXIT, visit } from 'unist-util-visit';
import { defineScopedOkfRule } from '../okf-runner.ts';

const INDEX_SCOPE = '**/index';

function hasLink(item: ListItem): boolean {
  let found = false;
  visit(item, ['link', 'linkReference'], () => {
    found = true;
    return EXIT;
  });
  return found;
}

export const indexShape = defineScopedOkfRule('index-shape', INDEX_SCOPE, (tree, file) => {
  let sectionOpen = false;
  for (const node of tree.children) {
    if (node.type === 'heading') {
      sectionOpen = true;
      continue;
    }
    if (node.type === 'list' && !sectionOpen) {
      file.message(
        'This index list is not under a section heading, so an Open Knowledge Format consumer reading the file as navigation has no name to file its entries under — an index is one or more heading-led sections of bulleted links.',
        node as List,
      );
    }
  }

  visit(tree, 'listItem', (node: ListItem) => {
    if (node.children.some((child) => child.type === 'list')) return;
    if (hasLink(node)) return;
    file.message(
      "This index entry has no link, so an Open Knowledge Format consumer reading the file as navigation has nowhere to follow it. Every entry in the format's own reference bundles is a link followed by a short description.",
      node,
    );
  });
});
