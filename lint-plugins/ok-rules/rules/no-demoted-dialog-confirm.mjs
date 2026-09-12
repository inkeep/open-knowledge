import { docsUrl } from '../docs.mjs';
import { elementName } from '../jsx.mjs';

const URL = docsUrl('no-demoted-dialog-confirm');

const MESSAGE = `Demoted confirm in a dialog footer. \`secondary\` draws no border and its \`bg-secondary\` fill sits within about 1.1:1 of the dialog surface, so it reads as flat text and loses the emphasis contest with the \`outline\` dismiss beside it. Drop the variant prop and let the confirm take \`default\` (or \`destructive\` for irreversible removal); the footer already supplies the row's font-mono uppercase treatment, so there is nothing to hand-add. See ${URL}`;

const FOOTERS = new Set(['DialogFooter', 'AlertDialogFooter']);

export const noDemotedDialogConfirm = {
  meta: {
    type: 'problem',
    docs: {
      description: 'A dialog footer confirm must not be demoted to the secondary variant.',
      url: URL,
    },
  },
  create(context) {
    const source = context.sourceCode;
    return {
      JSXElement(node) {
        if (!FOOTERS.has(elementName(node.openingElement ?? {}))) return;
        if (!source.getText(node).includes('variant="secondary"')) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
};
