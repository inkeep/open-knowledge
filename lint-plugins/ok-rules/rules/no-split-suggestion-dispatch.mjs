import { docsUrl } from '../docs.mjs';

const URL = docsUrl('no-split-suggestion-dispatch');

const CHAIN_MESSAGE = `Split suggestion dispatch: this chain dispatches the trigger-range delete on its own. Compose the delete and the insert into ONE chain (\`.deleteRange(range).insertContent(...).run()\`) or route through an applySlashCommandItem-style boundary so the item contributes steps to the same transaction (precedent #58). A separately dispatched delete lets a re-entrant transaction remap the selection and the follow-up insert silently replace an adjacent node. See ${URL}`;
const COMMANDS_MESSAGE = `Split suggestion dispatch: \`commands.deleteRange\` dispatches the trigger-range delete immediately as its own transaction. Compose the delete and the insert into ONE chain (\`.deleteRange(range).insertContent(...).run()\`) or route through an applySlashCommandItem-style boundary so the item contributes steps to the same transaction (precedent #58). See ${URL}`;

function memberName(node) {
  const callee = node?.callee;
  if (!callee) return '';
  if (callee.type !== 'MemberExpression' && callee.type !== 'StaticMemberExpression') return '';
  return callee.property?.type === 'Identifier' ? callee.property.name : '';
}

function isBareDeleteRangeRun(node) {
  if (memberName(node) !== 'run') return false;
  const receiver = node.callee?.object;
  return receiver?.type === 'CallExpression' && memberName(receiver) === 'deleteRange';
}

function isCommandsDeleteRange(node) {
  if (memberName(node) !== 'deleteRange') return false;
  const receiver = node.callee?.object;
  if (!receiver) return false;
  if (receiver.type !== 'MemberExpression' && receiver.type !== 'StaticMemberExpression') {
    return false;
  }
  return receiver.property?.type === 'Identifier' && receiver.property.name === 'commands';
}

export const noSplitSuggestionDispatch = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A suggestion surface must delete its trigger range and insert in one transaction.',
      url: URL,
    },
  },
  create(context) {
    let suggestionDepth = 0;
    return {
      CallExpression(node) {
        if (node.callee?.type === 'Identifier' && node.callee.name === 'Suggestion') {
          suggestionDepth += 1;
          return;
        }
        if (suggestionDepth === 0) return;
        if (isBareDeleteRangeRun(node)) {
          context.report({ node, message: CHAIN_MESSAGE });
          return;
        }
        if (isCommandsDeleteRange(node)) {
          context.report({ node, message: COMMANDS_MESSAGE });
        }
      },
      'CallExpression:exit'(node) {
        if (node.callee?.type === 'Identifier' && node.callee.name === 'Suggestion') {
          suggestionDepth -= 1;
        }
      },
    };
  },
};
