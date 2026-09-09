import { Node } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    jsxComponent: {
      insertJsxComponent: (content: string) => ReturnType;
    };
  }
}

/**
 * Block-level PM node for MDX JSX flow elements. Descriptor dispatch at render time picks the
 * NodeView branch: registered renders live React, wildcard and render errors auto-convert to the
 * `rawMdxFallback` source editor (precedent #28 / #30). Attrs are add-only per precedent #9.
 */
export const JsxComponent = Node.create({
  name: 'jsxComponent',
  group: 'block',
  atom: false,
  content: 'block*',
  isolating: true,
  selectable: true,
  defining: true,
  priority: 60,

  addAttributes() {
    return {
      componentName: { default: '' },
      kind: { default: 'element' },
      attributes: { default: [] },
      sourceRaw: { default: '' },
      sourceDirty: { default: false },
      props: { default: {} },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-jsx-component]',
        getAttrs: (node) => {
          if (typeof node === 'string') return false;
          return {
            componentName: node.getAttribute('data-component-name') || '',
            sourceRaw: node.getAttribute('data-source-raw') || '',
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      {
        'data-jsx-component': '',
        'data-component-name': HTMLAttributes.componentName,
        'data-source-raw': HTMLAttributes.sourceRaw,
      },
      0,
    ];
  },

  addCommands() {
    return {
      insertJsxComponent:
        (content: string) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: { sourceRaw: content },
          });
        },
    };
  },
});
