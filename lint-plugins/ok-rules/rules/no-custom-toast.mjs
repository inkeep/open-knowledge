import { docsUrl } from '../docs.mjs';
import { sonnerToastBindings, toastCallMethod } from '../toast.mjs';

const URL = docsUrl('no-custom-toast');

const MESSAGE = `Custom sonner toast. \`toast.custom\` renders unstyled: it sizes to its content, draws no close button, and overlaps the toast stacked behind it. Use the typed toast functions (\`toast.success\`, \`toast.error\`, \`toast.warning\`, \`toast.info\`, \`toast.loading\`) so the Toaster supplies the color, icon, width and close button. See ${URL}`;

export const noCustomToast = {
  meta: {
    type: 'problem',
    docs: {
      description: 'App code must use the typed sonner toast functions, not toast.custom.',
      url: URL,
    },
  },
  create(context) {
    let bindings = { direct: new Set(), namespaces: new Set() };
    return {
      Program(node) {
        bindings = sonnerToastBindings(node);
      },
      CallExpression(node) {
        if (toastCallMethod(node, bindings, context.sourceCode) !== 'custom') return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
};
