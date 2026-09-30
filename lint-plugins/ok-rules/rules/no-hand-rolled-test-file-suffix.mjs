import { TEST_ONLY_SOURCE_SUFFIXES } from '../../../test-support/test-only-source-file.mjs';
import { docsUrl } from '../docs.mjs';

const URL = docsUrl('no-hand-rolled-test-file-suffix');
const MESSAGE = `Hand-rolled test-file classification can mistake helpers and type checks for production. Use isTestOnlySourceFile from test-support/test-only-source-file.mjs; select a kind when discovering runnable tests. See ${URL}`;
const SUFFIXES = new Set(TEST_ONLY_SOURCE_SUFFIXES);
const INFIXES = new Set(
  TEST_ONLY_SOURCE_SUFFIXES.map((suffix) => suffix.slice(0, suffix.lastIndexOf('.') + 1)),
);

function stringValue(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked;
  return undefined;
}

function isSuffixRegex(node) {
  if (node?.type !== 'Literal' || !node.regex) return false;
  const pattern = node.regex.pattern;
  if (!pattern.endsWith('$')) return false;
  const suffix = pattern
    .slice(0, -1)
    .replaceAll('\\.', '.')
    .replace(/\((?:\?:)?ts\|tsx\)/g, 'tsx?')
    .replace(/\.tsx\?$/, '.ts');
  return SUFFIXES.has(suffix);
}

export const noHandRolledTestFileSuffix = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Use the canonical test-only source-file predicate in scanners.',
      url: URL,
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee?.type !== 'MemberExpression') return;
        const method = callee.computed ? stringValue(callee.property) : callee.property?.name;
        const argument = node.arguments[0];
        if (method === 'endsWith' || method === 'includes') {
          const value = stringValue(argument);
          if (SUFFIXES.has(value) || (method === 'includes' && INFIXES.has(value)))
            context.report({ node, message: MESSAGE });
          return;
        }
        if (
          ((method === 'test' || method === 'exec') && isSuffixRegex(callee.object)) ||
          ((method === 'match' || method === 'search') && isSuffixRegex(argument))
        ) {
          context.report({ node, message: MESSAGE });
        }
      },
    };
  },
};
