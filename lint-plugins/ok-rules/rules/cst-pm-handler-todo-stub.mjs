import { docsUrl } from '../docs.mjs';

const URL = docsUrl('cst-pm-handler-todo-stub');

const MESSAGE = `Codemod-emitted handler stub still throws TODO marker - fill in the substrate-specific body so the handler is implemented per the ICstEngine contract. See ${URL}`;

const TODO = /^TODO: implement/;

export const cstPmHandlerTodoStub = {
  meta: {
    type: 'problem',
    docs: {
      description: 'A codemod-emitted handler stub must not ship still throwing its TODO marker.',
      url: URL,
    },
  },
  create(context) {
    const source = context.sourceCode;
    return {
      ThrowStatement(node) {
        const argument = node.argument;
        if (!argument || argument.type !== 'NewExpression') return;
        if (argument.callee?.type !== 'Identifier' || argument.callee.name !== 'Error') return;
        const [message] = argument.arguments ?? [];
        if (!message) return;
        const text = source.getText(message).slice(1, -1);
        if (!TODO.test(text)) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
};
