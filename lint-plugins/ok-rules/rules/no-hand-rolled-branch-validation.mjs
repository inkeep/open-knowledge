import { docsUrl } from '../docs.mjs';

const URL = docsUrl('no-hand-rolled-branch-validation');

const MESSAGE = `Hand-rolled branch-name validation — call \`isValidBranchName\` (from @inkeep/open-knowledge-core, re-exported at packages/server/src/git-branch-info.ts) instead of testing a regex against a branch value. It is the declared single source of truth for the seven-rule contract; a local regex drifts from it silently, which is how /api/history came to answer 400 on git-legal branch names containing \`+\`. Validating something other than a branch name, or enforcing a rule the contract deliberately omits? suppress with \`// oxlint-disable-next-line ok/no-hand-rolled-branch-validation -- <reason>\`. See ${URL}`;

export const BRANCH_IDENTIFIER_RE =
  /^(?:branch|refName)(?:Name|Ref)?$|^[a-z][a-zA-Z0-9]*Branch(?:Name|Ref)?$/;

const REGEX_TEST_METHODS = new Set(['test', 'match', 'exec']);

function isBranchIdentifier(node) {
  if (!node) return false;
  if (node.type === 'Identifier') return BRANCH_IDENTIFIER_RE.test(node.name);
  if (node.type === 'MemberExpression' && node.property?.type === 'Identifier') {
    return BRANCH_IDENTIFIER_RE.test(node.property.name);
  }
  return false;
}

export const noHandRolledBranchValidation = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Branch-name admissibility must come from the declared isValidBranchName contract.',
      url: URL,
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee?.type !== 'MemberExpression' || callee.property?.type !== 'Identifier') return;
        const method = callee.property.name;
        if (!REGEX_TEST_METHODS.has(method)) return;

        if (method === 'test' || method === 'exec') {
          if (callee.object.type !== 'Literal' || !('regex' in callee.object)) return;
          if (!isBranchIdentifier(node.arguments?.[0])) return;
          context.report({ node, message: MESSAGE });
          return;
        }

        if (!isBranchIdentifier(callee.object)) return;
        const arg = node.arguments?.[0];
        if (arg?.type !== 'Literal' || !('regex' in arg)) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
};
