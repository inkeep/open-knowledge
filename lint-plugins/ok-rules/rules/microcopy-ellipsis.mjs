import { docsUrl } from '../docs.mjs';
import { attributeName } from '../jsx.mjs';

const URL = docsUrl('microcopy-ellipsis');

const UI_ATTRIBUTES = new Set([
  'placeholder',
  'label',
  'title',
  'aria-label',
  'description',
  'tooltip',
]);

const TEXT_MESSAGE = `Microcopy: drop the trailing \`…\`. Reserve U+2026 for macOS native menus (menu.ts) or truncation indicators. See ${URL}`;
const ATTRIBUTE_MESSAGE = `Microcopy: drop the trailing \`…\` from this UI-facing attribute. See ${URL}`;

export const microcopyEllipsis = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Reserve U+2026 for macOS native menus and truncation indicators.',
      url: URL,
    },
  },
  create(context) {
    const source = context.sourceCode;
    return {
      JSXText(node) {
        if (!source.getText(node).includes('…')) return;
        context.report({ node, message: TEXT_MESSAGE });
      },
      JSXAttribute(node) {
        if (!UI_ATTRIBUTES.has(attributeName(node))) return;
        if (!node.value) return;
        if (!source.getText(node.value).includes('…')) return;
        context.report({ node: node.value, message: ATTRIBUTE_MESSAGE });
      },
    };
  },
};
