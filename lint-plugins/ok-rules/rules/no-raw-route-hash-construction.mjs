import { docsUrl } from '../docs.mjs';

const URL = docsUrl('no-raw-route-hash-construction');

const MESSAGE = `Raw route-hash construction: this joins a name onto the \`#/\` prefix by hand, so a name containing \`#\`, \`?\` or \`%\` reaches the router unescaped and resolves to the wrong target (or to none, which opens a New Tab). Call \`hashFromDocName\`, \`hashFromFolderPath\`, \`hashFromAssetPath\` or \`encodeShareTargetForHash\` from \`@/lib/doc-hash\` instead — they percent-encode per segment so \`/\` stays a route separator. See ${URL}`;

const TEMPLATE_INTERPOLATION = /#\/\$\{/;
const HASH_PREFIX_LITERAL = /^['"`]#\/['"`]$/;

export const noRawRouteHashConstruction = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Build route hashes through @/lib/doc-hash, never by joining onto `#/` by hand.',
      url: URL,
    },
  },
  create(context) {
    const source = context.sourceCode;
    return {
      TemplateLiteral(node) {
        if (!TEMPLATE_INTERPOLATION.test(source.getText(node))) return;
        context.report({ node, message: MESSAGE });
      },
      BinaryExpression(node) {
        if (node.operator !== '+') return;
        if (!HASH_PREFIX_LITERAL.test(source.getText(node.left))) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
};
