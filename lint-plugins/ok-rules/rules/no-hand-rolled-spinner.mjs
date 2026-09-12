import { docsUrl } from '../docs.mjs';
import { isClassNameAttribute } from '../jsx.mjs';

const URL = docsUrl('no-hand-rolled-spinner');

const MESSAGE = `Hand-rolled loading spinner. Use \`<Spinner />\` from \`@/components/ui/spinner\` so reduced motion and the accessible name come for free — pass \`icon\` to keep a meaningful glyph, \`aria-hidden\` when a wrapper already announces the state. See ${URL}`;

const ANIMATE_SPIN = /\banimate-spin\b/;

export const noHandRolledSpinner = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Loading spinners come from the Spinner primitive so reduced-motion support and the accessible name are inherited.',
      url: URL,
    },
  },
  create(context) {
    const source = context.sourceCode;
    return {
      JSXAttribute(node) {
        if (!isClassNameAttribute(node) || !node.value) return;
        if (!ANIMATE_SPIN.test(source.getText(node.value))) return;
        context.report({ node: node.value, message: MESSAGE });
      },
    };
  },
};
