
import { Node } from '@tiptap/core';

export const LinkRefDefFidelity = Node.create({
  name: 'linkRefDef',
  group: 'block',
  atom: true,
  priority: 60,

  addAttributes() {
    return {
      label: { default: '' },
      href: { default: '' },
      title: { default: null },
      sourceLayout: { default: null },
      sourceTitleMarker: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-link-ref-def]' }];
  },

  renderHTML({ node }) {
    const { label, href, title } = node.attrs;
    const display = title ? `[${label}]: ${href} "${title}"` : `[${label}]: ${href}`;
    return ['div', { 'data-link-ref-def': '', class: 'link-ref-def' }, display];
  },
});
