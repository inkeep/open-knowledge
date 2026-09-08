import { docsUrl } from '../docs.mjs';

const URL = docsUrl('playwright-prefer-to-have-count');

const MESSAGE = `One-shot count read never retries — use the web-first \`await expect(locator).toHaveCount(n)\` so the assertion polls the live DOM. See ${URL}`;

function isCountCall(node) {
  if (!node || node.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (!callee) return false;
  if (callee.type !== 'MemberExpression' && callee.type !== 'StaticMemberExpression') return false;
  return callee.property?.type === 'Identifier' && callee.property.name === 'count';
}

export const playwrightPreferToHaveCount = {
  meta: {
    type: 'problem',
    docs: {
      description: 'A one-shot `expect(await locator.count())` never retries; use toHaveCount.',
      url: URL,
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee?.type !== 'Identifier' || node.callee.name !== 'expect') return;
        const [argument] = node.arguments ?? [];
        if (!argument || argument.type !== 'AwaitExpression') return;
        if (!isCountCall(argument.argument)) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
};
