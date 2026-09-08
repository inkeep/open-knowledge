import { docsUrl } from '../docs.mjs';

const URL = docsUrl('no-roundtrip-identity-oracle');

const MESSAGE = `Byte-fidelity round-trip oracle in a public test: \`serialize(parse(x))\` asserted equal to the same input \`x\`. This general round-trip-identity check belongs to the engine's fidelity suite (packages/app/tests/fidelity or packages/core/src/markdown); a public test should assert a fixed expected literal for a specific contract instead. See ${URL}`;

const MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual']);

function calleeName(node) {
  const callee = node?.callee;
  if (!callee) return '';
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' || callee.type === 'StaticMemberExpression') {
    return callee.property?.type === 'Identifier' ? callee.property.name : '';
  }
  return '';
}

function receiverText(node, source) {
  const callee = node?.callee;
  if (!callee) return null;
  if (callee.type === 'Identifier') return '';
  if (callee.type === 'MemberExpression' || callee.type === 'StaticMemberExpression') {
    return callee.object ? source.getText(callee.object) : null;
  }
  return null;
}

function roundTripInput(node, source) {
  if (!node || node.type !== 'CallExpression' || calleeName(node) !== 'serialize') return null;
  const [inner] = node.arguments ?? [];
  if (!inner || inner.type !== 'CallExpression' || calleeName(inner) !== 'parse') return null;
  const outer = receiverText(node, source);
  const nested = receiverText(inner, source);
  if (outer === null || nested === null || outer !== nested) return null;
  const [input] = inner.arguments ?? [];
  return input ? source.getText(input) : null;
}

export const noRoundtripIdentityOracle = {
  meta: {
    type: 'problem',
    docs: {
      description: 'A byte-fidelity round-trip identity oracle does not belong in a public test.',
      url: URL,
    },
  },
  create(context) {
    const source = context.sourceCode;
    return {
      CallExpression(node) {
        if (!MATCHERS.has(calleeName(node))) return;
        const callee = node.callee;
        const receiver = callee?.object;
        if (!receiver || receiver.type !== 'CallExpression') return;
        if (receiver.callee?.type !== 'Identifier' || receiver.callee.name !== 'expect') return;
        const [actual] = receiver.arguments ?? [];
        const [expected] = node.arguments ?? [];
        if (!actual || !expected) return;
        const input = roundTripInput(actual, source);
        if (input === null || input !== source.getText(expected)) return;
        context.report({ node, message: MESSAGE });
      },
      BinaryExpression(node) {
        if (node.operator !== '===') return;
        const left = roundTripInput(node.left, source);
        if (left !== null && left === source.getText(node.right)) {
          context.report({ node, message: MESSAGE });
          return;
        }
        const right = roundTripInput(node.right, source);
        if (right !== null && right === source.getText(node.left)) {
          context.report({ node, message: MESSAGE });
        }
      },
    };
  },
};
