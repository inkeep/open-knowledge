import { docsUrl } from '../docs.mjs';
import { attributeName, elementName } from '../jsx.mjs';

const URL = docsUrl('no-unwrapped-user-facing-string');

const TOAST_MESSAGE = `Unwrapped user-facing string in a toast argument. Wrap it with the Lingui \`t\` macro — in a plain module call the macro inside the function, never at module top level, so it resolves against the active locale. See ${URL}`;
const JSX_TEXT_MESSAGE = `Unwrapped user-facing string in JSX text. Wrap it with the Lingui \`<Trans>\` element so it reaches the catalogs. See ${URL}`;
const ATTRIBUTE_MESSAGE = `Unwrapped user-facing string in a UI-facing attribute. Wrap it with the Lingui \`t\` macro from \`useLingui()\` so it reaches the catalogs. See ${URL}`;
const PROPERTY_MESSAGE = `Unwrapped user-facing string in a UI-facing object property. Wrap it with the Lingui \`t\` macro — or, when the object is module scope, hold a \`msg\` descriptor here and resolve it at render, so a language switch is not frozen out. See ${URL}`;

const TWO_WORDS = /[A-Za-z]\s+[A-Za-z]/;
const ICON_NAME = /^[A-Za-z0-9()\-. ]* icon$/;

const COPY_ATTRIBUTES = new Set(['aria-label', 'placeholder', 'title', 'alt']);
const COPY_PROPERTIES = new Set([
  'aria-label',
  'placeholder',
  'title',
  'alt',
  'label',
  'description',
]);

function isCopy(value) {
  return typeof value === 'string' && TWO_WORDS.test(value) && !ICON_NAME.test(value.trim());
}

function propertyKeyName(key) {
  if (!key) return null;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
}

export const noUnwrappedUserFacingString = {
  meta: {
    type: 'problem',
    docs: {
      description: 'User-facing copy must route through Lingui rather than ship as a bare literal.',
      url: URL,
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (!callee) return;
        if (callee.type !== 'MemberExpression' && callee.type !== 'StaticMemberExpression') return;
        if (callee.object?.type !== 'Identifier' || callee.object.name !== 'toast') return;
        const [argument] = node.arguments ?? [];
        if (!argument || argument.type !== 'Literal' || typeof argument.value !== 'string') return;
        context.report({ node, message: TOAST_MESSAGE });
      },
      JSXText(node) {
        if (!isCopy(node.value)) return;
        let parent = node.parent;
        while (parent) {
          if (
            parent.type === 'JSXElement' &&
            elementName(parent.openingElement ?? {}) === 'Trans'
          ) {
            return;
          }
          parent = parent.parent;
        }
        context.report({ node, message: JSX_TEXT_MESSAGE });
      },
      JSXAttribute(node) {
        if (!COPY_ATTRIBUTES.has(attributeName(node))) return;
        const value = node.value;
        if (!value || value.type !== 'Literal' || !isCopy(value.value)) return;
        context.report({ node: value, message: ATTRIBUTE_MESSAGE });
      },
      Property(node) {
        const name = propertyKeyName(node.key);
        if (!name || !COPY_PROPERTIES.has(name)) return;
        const value = node.value;
        if (!value || value.type !== 'Literal' || !isCopy(value.value)) return;
        context.report({ node: value, message: PROPERTY_MESSAGE });
      },
    };
  },
};
