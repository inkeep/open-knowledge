import { resolveVariable } from '../binding.mjs';
import { docsUrl } from '../docs.mjs';

const URL = docsUrl('no-native-renderer-dialog');

const MESSAGE = `Native browser dialog in the renderer. \`confirm\`, \`alert\` and \`prompt\` open a dialog with no title, no destructive button, no app theme or focus handling, and button labels the app cannot translate. Use \`AlertDialog\` from \`@/components/ui/alert-dialog\` (or \`DeleteConfirmationDialog\` for a delete). See ${URL}`;

const DIALOGS = new Set(['confirm', 'alert', 'prompt']);
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self']);

function isLocallyBound(sourceCode, identifier) {
  return resolveVariable(sourceCode, identifier) !== null;
}

function dialogMember(callee) {
  if (callee?.type !== 'MemberExpression' || callee.computed) return false;
  if (callee.property?.type !== 'Identifier' || !DIALOGS.has(callee.property.name)) return false;
  return callee.object?.type === 'Identifier' && GLOBAL_OBJECTS.has(callee.object.name);
}

export const noNativeRendererDialog = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Renderer code must not open a native confirm, alert or prompt dialog.',
      url: URL,
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee?.type === 'Identifier') {
          if (!DIALOGS.has(callee.name) || isLocallyBound(sourceCode, callee)) return;
        } else if (!dialogMember(callee) || isLocallyBound(sourceCode, callee.object)) {
          return;
        }
        context.report({ node, message: MESSAGE });
      },
    };
  },
};
