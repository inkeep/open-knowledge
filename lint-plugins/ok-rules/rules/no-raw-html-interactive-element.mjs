import { docsUrl } from '../docs.mjs';
import { elementName } from '../jsx.mjs';

const URL = docsUrl('no-raw-html-interactive-element');

const MESSAGE = `Raw HTML interactive primitive — use shadcn Button/Input/Textarea/Select from @/components/ui/* (install missing via \`pnpm dlx shadcn@latest add <name>\`). See ${URL}`;

const FORBIDDEN = new Set(['button', 'input', 'textarea', 'select']);

export const noRawHtmlInteractiveElement = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Raw JSX button/input/textarea/select is forbidden; use the shadcn primitives.',
      url: URL,
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (!FORBIDDEN.has(elementName(node))) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
};
