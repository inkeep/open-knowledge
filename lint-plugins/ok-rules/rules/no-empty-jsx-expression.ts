import type { RuleTester } from 'oxlint/plugins-dev';
// @ts-expect-error untyped ESM lint-plugin module
import { docsUrl } from '../docs.mjs';

type Rule = Parameters<RuleTester['run']>[1];

const URL: string = docsUrl('no-empty-jsx-expression');

const EMPTY_MESSAGE = `Empty JSX expression \`{}\` renders nothing. Delete the braces, and the line when nothing else is on it. See ${URL}`;

const COMMENT_MESSAGE = `JSX expression braces that hold only a comment are not allowed. Put the comment between an element's props, or after its tag name (\`<div // ...\`), and delete the braces. The braces may hold a single biome-ignore directive, or a single oxlint-disable-next-line directly before JSX text. See ${URL}`;

type JsxChild =
  | { type: 'JSXText'; value: string }
  | { type: 'JSXElement' | 'JSXFragment'; children: readonly JsxChild[] }
  | { type: 'JSXExpressionContainer' | 'JSXSpreadChild' };

function isBlankText(child: JsxChild): boolean {
  return child.type === 'JSXText' && !child.value.trim();
}

function firstNonBlank(children: readonly JsxChild[]): JsxChild | undefined {
  return children.find((child) => !isBlankText(child));
}

function textFollows(siblings: readonly JsxChild[], index: number): boolean {
  const next = firstNonBlank(siblings.slice(index + 1));
  if (next === undefined) return false;
  if (next.type === 'JSXText') return true;
  if (next.type !== 'JSXElement' && next.type !== 'JSXFragment') return false;
  return firstNonBlank(next.children)?.type === 'JSXText';
}

export const noEmptyJsxExpression: Rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'JSX expression braces hold an expression or a single lint directive that has no other place, never nothing and never another comment.',
      url: URL,
    },
  },
  create(context) {
    const source = context.sourceCode;
    return {
      JSXExpressionContainer(node) {
        if (node.expression.type !== 'JSXEmptyExpression') return;
        const parent = node.parent;
        if (parent.type !== 'JSXElement' && parent.type !== 'JSXFragment') return;
        const comments = source.getCommentsInside(node);
        if (comments.length === 0) {
          context.report({ node, message: EMPTY_MESSAGE });
          return;
        }
        if (comments.length === 1) {
          const directive = comments[0].value.trim();
          if (directive.startsWith('biome-ignore')) return;
          const siblings: readonly JsxChild[] = parent.children;
          if (
            directive.startsWith('oxlint-disable-next-line') &&
            textFollows(siblings, siblings.indexOf(node))
          ) {
            return;
          }
        }
        context.report({ node, message: COMMENT_MESSAGE });
      },
    };
  },
};
