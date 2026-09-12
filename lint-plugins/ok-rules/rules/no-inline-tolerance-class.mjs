import { docsUrl } from '../docs.mjs';

const URL = docsUrl('no-inline-tolerance-class');

const MESSAGE = `Inline bridge normalization-class value in a public test. Assert observable \`normalizeBridge\` equivalence between inputs instead of hard-coding a BRIDGE_TOLERANCE_CLASSES label as a string literal. See ${URL}`;

export const MATCHED_FIDELITY_CLASSES = [
  'commonmark-escape',
  'emphasis-around-code',
  'leading-newline',
  'doc-start-thematic',
  'block-separator-collapse',
  'table-align-row-spacing',
  'row-no-trailing-pipe',
  'list-indent-canonical',
  'ordered-list-marker-number',
  'paragraph-continuation-indent',
  'jsx-container-boundary-blank',
  'blank-line-collapse',
];

const MATCHED = new Set(MATCHED_FIDELITY_CLASSES);

export const noInlineToleranceClass = {
  meta: {
    type: 'problem',
    docs: {
      description: 'A public test must not hard-code a BRIDGE_TOLERANCE_CLASSES label inline.',
      url: URL,
    },
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value !== 'string' || !MATCHED.has(node.value)) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
};
