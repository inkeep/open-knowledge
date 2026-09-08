import { docsUrl } from '../docs.mjs';

const URL = docsUrl('path-conditional-map-driven-origin');

const MESSAGE = `Observer-side transact call missing sanctioned origin. Pass \`OBSERVER_SYNC_ORIGIN\` as the second argument: \`doc.transact(fn, OBSERVER_SYNC_ORIGIN)\`. Bare \`doc.transact(fn)\` (or a wrong origin) routes the write to \`openknowledge-service\` and breaks per-session UndoManager attribution. See ${URL}`;

export const pathConditionalMapDrivenOrigin = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Observer-side transact calls must pass OBSERVER_SYNC_ORIGIN as the second argument.',
      url: URL,
    },
  },
  create(context) {
    const source = context.sourceCode;
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (!callee) return;
        if (callee.type !== 'MemberExpression' && callee.type !== 'StaticMemberExpression') return;
        if (callee.property?.type !== 'Identifier' || callee.property.name !== 'transact') return;
        const second = (node.arguments ?? [])[1];
        if (second && source.getText(second) === 'OBSERVER_SYNC_ORIGIN') return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
};
