import type { RuleTester } from 'oxlint/plugins-dev';
// @ts-expect-error untyped ESM lint-plugin module
import { docsUrl } from '../docs.mjs';

type Rule = Parameters<RuleTester['run']>[1];

const URL: string = docsUrl('no-redundant-jsx-element-braces');

const MESSAGE = `JSX expression braces around a single element do nothing, and a comment does not need them. Delete the braces, and put the comment between the element's props, or after its tag name (\`<div // ...\`). See ${URL}`;

const ELEMENT_TYPES = new Set(['JSXElement', 'JSXFragment']);

export const noRedundantJsxElementBraces: Rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A JSX child element is written bare, not wrapped in expression braces that carry a comment.',
      url: URL,
    },
  },
  create(context) {
    const source = context.sourceCode;
    return {
      JSXExpressionContainer(node) {
        if (!ELEMENT_TYPES.has(node.parent.type) || !ELEMENT_TYPES.has(node.expression.type))
          return;
        const comments = source.getCommentsInside(node);
        if (comments.length === 0) return;
        const { start, end } = node.expression;
        const outside = comments.filter((comment) => comment.end <= start || comment.start >= end);
        if (outside.length === 1 && outside[0].value.trim().startsWith('biome-ignore')) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
};
