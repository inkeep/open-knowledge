import { docsUrl } from '../docs.mjs';

const URL = docsUrl('no-resolved-value-theme-source');

const MATCH_MEDIA_MESSAGE = `1-way theme contract: matchMedia inside setThemeSource argument — pass the unresolved CRDT value ('system' | 'light' | 'dark') directly. Resolving 'system' to a concrete 'light'/'dark' loses OS auto-tracking. See ${URL}`;
const LITERAL_PAIR_MESSAGE = `1-way theme contract: setThemeSource argument resolves to 'light'/'dark' literals (likely a ternary) — pass the unresolved CRDT value directly. See ${URL}`;

const LIGHT_THEN_DARK = /['"]light['"][\s\S]*['"]dark['"]/;
const DARK_THEN_LIGHT = /['"]dark['"][\s\S]*['"]light['"]/;

function isSetThemeSource(callee) {
  if (!callee) return false;
  if (callee.type === 'Identifier') return callee.name === 'setThemeSource';
  if (callee.type === 'MemberExpression' || callee.type === 'StaticMemberExpression') {
    return callee.property?.type === 'Identifier' && callee.property.name === 'setThemeSource';
  }
  return false;
}

export const noResolvedValueThemeSource = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Pass the unresolved theme value to setThemeSource; never resolve at the call site.',
      url: URL,
    },
  },
  create(context) {
    const source = context.sourceCode;
    return {
      CallExpression(node) {
        if (!isSetThemeSource(node.callee)) return;
        const [argument] = node.arguments ?? [];
        if (!argument) return;
        const text = source.getText(argument);
        if (text.includes('matchMedia')) {
          context.report({ node, message: MATCH_MEDIA_MESSAGE });
          return;
        }
        if (LIGHT_THEN_DARK.test(text) || DARK_THEN_LIGHT.test(text)) {
          context.report({ node, message: LITERAL_PAIR_MESSAGE });
        }
      },
    };
  },
};
