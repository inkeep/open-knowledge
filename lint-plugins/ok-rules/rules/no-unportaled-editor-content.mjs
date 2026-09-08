import { docsUrl } from '../docs.mjs';
import { elementName } from '../jsx.mjs';

const URL = docsUrl('no-unportaled-editor-content');

const MESSAGE = `Portal-only: render <EditorContent /> via React.createPortal(<EditorContent .../>, portalTarget). H6 cross-doc DOM bleed contract — TipTap's PureEditorContent.componentDidMount vacuums sibling DOM nodes into its refDiv; portalling isolates view.dom in a per-Activity DOM target. See ${URL}`;

export const noUnportaledEditorContent = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Every <EditorContent> must be rendered through React.createPortal.',
      url: URL,
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (elementName(node) !== 'EditorContent') return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
};
