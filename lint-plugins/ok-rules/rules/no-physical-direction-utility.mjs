import { docsUrl } from '../docs.mjs';
import { isClassNameAttribute } from '../jsx.mjs';

const URL = docsUrl('no-physical-direction-utility');

const MESSAGE = `Physical direction utility in a class string. Use the logical equivalent so the chrome follows the reading direction — \`ms-\`/\`me-\` for margin, \`ps-\`/\`pe-\` for padding, \`start-\`/\`end-\` for inset. See ${URL}`;

const PHYSICAL = /\b(?:ml|mr|pl|pr|left|right)-(?:auto|px|full|\[|[0-9]+(?:\.[0-9]+)?[\s"'`])/;

export const noPhysicalDirectionUtility = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Chrome layout derives its side from the reading direction, never from a hardcoded left or right.',
      url: URL,
    },
  },
  create(context) {
    const source = context.sourceCode;
    return {
      JSXAttribute(node) {
        if (!isClassNameAttribute(node) || !node.value) return;
        if (!PHYSICAL.test(source.getText(node.value))) return;
        context.report({ node: node.value, message: MESSAGE });
      },
    };
  },
};
