import { docsUrl } from '../docs.mjs';

const URL = docsUrl('no-fixed-palette-color');

const MESSAGE = `Fixed Tailwind hue in a class string. Use a theme token so the color follows the active theme's palette — \`success\`, \`warning\`, \`destructive\` or \`info\` for status, \`chart-1\` to \`chart-5\` for data categories, \`identity-1\` to \`identity-4\` for telling items such as threads apart. See ${URL}`;

const FIXED_HUE =
  /(?<![\w-])(?:bg|text|border(?:-[xytrblse])?|decoration|ring|ring-offset|inset-ring|outline|fill|stroke|from|via|to|divide|accent|caret|shadow|inset-shadow|drop-shadow|text-shadow|placeholder)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)(?![\w-])/;

export const noFixedPaletteColor = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Chrome colors come from the active theme palette, never from a fixed Tailwind hue.',
      url: URL,
    },
  },
  create(context) {
    const report = (node, text) => {
      if (FIXED_HUE.test(text)) context.report({ node, message: MESSAGE });
    };
    return {
      Literal(node) {
        if (typeof node.value === 'string') report(node, node.value);
      },
      TemplateElement(node) {
        report(node, node.value.raw);
      },
    };
  },
};
