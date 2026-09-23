import { docsUrl } from '../docs.mjs';

const URL = docsUrl('no-sentinel-signal-target');

const LITERAL_MESSAGE = `Signal target is a literal 0, 1 or -1 — on POSIX that addresses the caller's whole process group, init, or every process the user owns, never a child. Signal only a pid you spawned — the ChildProcess handle, or its pid taken from that handle, negated for the group only if you spawned it detached. See ${URL}`;
const FALLBACK_MESSAGE = `A \`?? <n>\` / \`|| <n>\` fallback fabricates a signal target when the pid is missing, and \`kill(0, …)\` reaches the caller's own process group. Filter the nullable pid out instead of substituting a sentinel. See ${URL}`;
const PARSED_MESSAGE = `A pid parsed from text reaches \`process.kill\` unvalidated — an empty pidfile yields \`0\` or \`NaN\` depending on the parser, and a stale one yields a pid that now belongs to some other process. Validate it with \`isValidLockPid()\` from @inkeep/open-knowledge-server before signalling. See ${URL}`;

const SEAM_SENDER_INDEX = new Map([
  ['signalOwnedGroup', 2],
  ['signalOwnedPids', 2],
  ['reapOwnedTree', 3],
]);

const PARSERS = new Set(['Number', 'parseInt', 'parseFloat']);

const WRAPPERS = new Set([
  'TSAsExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
  'ParenthesizedExpression',
]);

function unwrap(node) {
  let current = node;
  while (current && WRAPPERS.has(current.type)) current = current.expression;
  return current;
}

function isMember(node) {
  return node?.type === 'MemberExpression';
}

function numericLiteralValue(node) {
  const inner = unwrap(node);
  if (!inner) return undefined;
  if (inner.type === 'Literal' && typeof inner.value === 'number') return inner.value;
  if (inner.type === 'UnaryExpression' && inner.operator === '-') {
    const argument = unwrap(inner.argument);
    if (argument?.type === 'Literal' && typeof argument.value === 'number') return -argument.value;
  }
  return undefined;
}

function isSentinelLiteral(node) {
  const value = numericLiteralValue(node);
  return value === 0 || value === 1 || value === -1;
}

function isFallbackToLiteral(node) {
  const inner = unwrap(node);
  if (inner?.type !== 'LogicalExpression') return false;
  if (inner.operator !== '??' && inner.operator !== '||') return false;
  return numericLiteralValue(inner.right) !== undefined;
}

function isRawParse(node) {
  const inner = unwrap(node);
  if (inner?.type !== 'CallExpression') return false;
  const callee = inner.callee;
  if (callee?.type === 'Identifier') return PARSERS.has(callee.name);
  if (isMember(callee) && callee.object?.type === 'Identifier' && callee.object.name === 'Number') {
    return callee.property?.type === 'Identifier' && PARSERS.has(callee.property.name);
  }
  return false;
}

function classify(node) {
  if (isSentinelLiteral(node)) return LITERAL_MESSAGE;
  if (isFallbackToLiteral(node)) return FALLBACK_MESSAGE;
  if (isRawParse(node)) return PARSED_MESSAGE;
  const inner = unwrap(node);
  if (inner?.type === 'UnaryExpression' && inner.operator === '-') return classify(inner.argument);
  return undefined;
}

function classifyTarget(node) {
  const inner = unwrap(node);
  if (inner?.type !== 'ArrayExpression') return classify(inner);
  for (const element of inner.elements ?? []) {
    const message = classify(element);
    if (message) return message;
  }
  return undefined;
}

function isProcessKill(callee) {
  return (
    isMember(callee) &&
    callee.object?.type === 'Identifier' &&
    callee.object.name === 'process' &&
    callee.property?.type === 'Identifier' &&
    callee.property.name === 'kill'
  );
}

function isRealSender(node) {
  return isProcessKill(unwrap(node));
}

export const noSentinelSignalTarget = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'process.kill and the owned-process reaper never receive a literal, fallback-fabricated or unvalidated-parsed pid.',
      url: URL,
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        const args = node.arguments ?? [];
        if (isProcessKill(callee)) {
          if (numericLiteralValue(args[1]) === 0) return;
          const message = classify(args[0]);
          if (message) context.report({ node, message });
          return;
        }
        if (callee?.type !== 'Identifier') return;
        const senderIndex = SEAM_SENDER_INDEX.get(callee.name);
        if (senderIndex === undefined) return;
        const sender = unwrap(args[senderIndex]);
        const omitted =
          !sender ||
          (sender.type === 'Identifier' && sender.name === 'undefined') ||
          (sender.type === 'UnaryExpression' && sender.operator === 'void');
        if (!omitted && !isRealSender(sender)) return;
        const message = classifyTarget(args[0]);
        if (message) context.report({ node, message });
      },
    };
  },
};
