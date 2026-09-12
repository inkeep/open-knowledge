import { docsUrl } from '../docs.mjs';

const URL = docsUrl('no-unconverted-git-pathspec');

const MESSAGE = `Hand-written \`'--'\` in a git argv leaves the operands after it as bare paths, and git parses a pathspec position as a pattern language — \`--\` stops option parsing, not pathspec-magic parsing. Build the tail with \`pathspecArgs(paths)\` from @inkeep/open-knowledge-core, which emits the separator and the \`:(literal)\` conversion together. If this verb's \`--\` operands are not pathspecs (as for clone, hash-object, mv and worktree), add the verb to \`NON_PATHSPEC_VERBS\` in this rule rather than suppressing. See ${URL}`;

export const NON_PATHSPEC_VERBS = ['clone', 'hash-object', 'mv', 'worktree'];

const ALLOWED = new Set(NON_PATHSPEC_VERBS);

const SEPARATOR = '--';

const CONFIG_FLAGS = new Set(['-c', '-C']);

function collectFragment(node, out) {
  if (!node) return;
  if (node.type === 'Literal' && typeof node.value === 'string') {
    out.push(node.value);
    return;
  }
  if (node.type === 'SpreadElement') {
    collectFragment(node.argument, out);
    return;
  }
  if (node.type === 'ConditionalExpression') {
    collectFragment(node.consequent, out);
    collectFragment(node.alternate, out);
    return;
  }
  if (node.type === 'ArrayExpression') {
    collectArgv(node, out);
    return;
  }
  out.push(null);
}

function collectArgv(node, out) {
  for (const element of node.elements) {
    if (element?.type === 'ArrayExpression') continue;
    collectFragment(element, out);
  }
}

function verbOf(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (typeof token !== 'string') return undefined;
    if (CONFIG_FLAGS.has(token)) {
      i += 1;
      continue;
    }
    if (!token.startsWith('-')) return token;
  }
  return undefined;
}

function violates(tokens) {
  return tokens.includes(SEPARATOR) && !ALLOWED.has(verbOf(tokens));
}

function isArgvFragment(node) {
  let parent = node.parent;
  let unwrapped = false;
  while (parent && (parent.type === 'SpreadElement' || parent.type === 'ConditionalExpression')) {
    parent = parent.parent;
    unwrapped = true;
  }
  return unwrapped && parent?.type === 'ArrayExpression';
}

function isRawCall(node) {
  const callee = node.callee;
  return callee?.type === 'MemberExpression' && callee.property?.name === 'raw';
}

function hasDirectSeparatorArgument(node) {
  return node.arguments.some(
    (argument) => argument.type === 'Literal' && argument.value === SEPARATOR,
  );
}

export const noUnconvertedGitPathspec = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Git pathspec operands must be built with pathspecArgs, not a hand-written --.',
      url: URL,
    },
  },
  create(context) {
    return {
      ArrayExpression(node) {
        if (isArgvFragment(node)) return;
        const tokens = [];
        collectArgv(node, tokens);
        if (violates(tokens)) context.report({ node, message: MESSAGE });
      },
      CallExpression(node) {
        if (!isRawCall(node) || !hasDirectSeparatorArgument(node)) return;
        const tokens = [];
        for (const argument of node.arguments) {
          collectFragment(argument, tokens);
        }
        if (violates(tokens)) context.report({ node, message: MESSAGE });
      },
    };
  },
};
