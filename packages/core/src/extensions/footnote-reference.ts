
import { Node } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    footnoteReference: {
      insertFootnoteReference: (identifier: string) => ReturnType;
    };
  }
}

export function nextFootnoteIdentifier(existingIdentifiers: readonly string[]): string {
  let maxId = 0;
  for (const id of existingIdentifiers) {
    const n = Number.parseInt(id, 10);
    if (!Number.isNaN(n) && n > maxId) maxId = n;
  }
  return String(maxId + 1);
}

export interface FootnoteWalkableDoc {
  forEach(
    f: (node: { type: { name: string }; nodeSize: number }, offset: number, index: number) => void,
  ): void;
  content: { size: number };
}

export interface FootnoteDescendableDoc {
  descendants(
    f: (
      node: { type: { name: string }; attrs: { identifier?: unknown } },
      pos: number,
    ) => boolean | undefined,
  ): void;
}

export function collectFootnoteIdentifiers(doc: FootnoteDescendableDoc): string[] {
  const ids: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'footnoteDefinition') {
      ids.push(String(node.attrs.identifier ?? ''));
    }
    return true;
  });
  return ids;
}

export function findFootnoteDefinitionInsertPos(doc: FootnoteWalkableDoc): number {
  let pos: number | null = null;
  doc.forEach((node, offset) => {
    if (node.type.name === 'footnoteDefinition') {
      pos = offset + node.nodeSize;
    }
  });
  return pos ?? doc.content.size;
}

export const FootnoteReference = Node.create({
  name: 'footnoteReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  priority: 60,

  addAttributes() {
    return {
      identifier: { default: '' },
      label: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'sup[data-footnote-ref]',
        getAttrs: (node) => {
          if (typeof node === 'string') return false;
          const id = node.getAttribute('data-footnote-id') || '';
          return { identifier: id, label: id || null };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const id = String(node.attrs.identifier ?? '');
    return [
      'sup',
      {
        id: `fnref-${id}`,
        'data-footnote-ref': '',
        'data-footnote-id': id,
        class: 'footnote-ref',
      },
      ['a', { href: `#fn-${id}`, class: 'footnote-ref-link' }, `[${id}]`],
    ];
  },

  addCommands() {
    return {
      insertFootnoteReference:
        (identifier) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { identifier, label: identifier },
          }),
    };
  },
});
