import { docsUrl } from '../docs.mjs';

const URL = docsUrl('no-blocking-error-box');

const MESSAGE = `Blocking error box. \`dialog.showErrorBox\` runs a synchronous dialog with no parent window: the main process stops until someone dismisses it, and on Linux it can fall behind the window it reports on, so the IPC reply that window waits for never arrives and SIGTERM goes unhandled. Show the error with \`showErrorDialog\` from \`packages/desktop/src/main/error-dialog.ts\`, attached to the window the user is looking at. See ${URL}`;

export const noBlockingErrorBox = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Desktop code must not show a blocking, parentless dialog.showErrorBox.',
      url: URL,
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee?.type !== 'MemberExpression' || callee.computed) return;
        if (callee.property?.type !== 'Identifier' || callee.property.name !== 'showErrorBox') {
          return;
        }
        context.report({ node, message: MESSAGE });
      },
    };
  },
};
