import { docsUrl } from '../docs.mjs';
import { attributeName, elementName } from '../jsx.mjs';

const URL = docsUrl('no-themeless-pierre-diff');

const THEME_MESSAGE = `@pierre/diffs render contract: this renderer passes no theme — add \`theme: okPierreTheme()\` to its options so the pane uses app tokens and tracks light/dark. See ${URL}`;
const STYLE_MESSAGE = `@pierre/diffs render contract: this renderer does not set diffStyle: 'unified' — add it to its options; 'split' desyncs the change stepper. See ${URL}`;

const HAS_THEME = /\btheme\s*:/;
const HAS_UNIFIED = /diffStyle:\s*['"]unified['"]/;
const PIERRE_FILES = new Set(['UnresolvedFile', 'PierreFile']);

export const noThemelessPierreDiff = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Every @pierre/diffs renderer must pass an app theme and unified diff style.',
      url: URL,
    },
  },
  create(context) {
    const source = context.sourceCode;
    return {
      JSXOpeningElement(node) {
        if (elementName(node) !== 'MultiFileDiff') return;
        const options = (node.attributes ?? []).find((a) => attributeName(a) === 'options');
        if (!options || !HAS_THEME.test(source.getText(options))) {
          context.report({ node, message: THEME_MESSAGE });
        }
        if (!HAS_UNIFIED.test(source.getText(node))) {
          context.report({ node, message: STYLE_MESSAGE });
        }
      },
      NewExpression(node) {
        if (node.callee?.type !== 'Identifier' || !PIERRE_FILES.has(node.callee.name)) return;
        if (HAS_THEME.test(source.getText(node))) return;
        context.report({ node, message: THEME_MESSAGE });
      },
    };
  },
};
