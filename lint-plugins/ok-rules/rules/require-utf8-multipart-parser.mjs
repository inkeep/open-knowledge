import { docsUrl } from '../docs.mjs';

const URL = docsUrl('require-utf8-multipart-parser');

const MESSAGE = `busboy constructed directly - route multipart parsing through \`createMultipartParser(...)\` from \`packages/server/src/multipart.ts\`, which hardcodes \`defParamCharset: 'utf8'\`. busboy defaults that option to \`latin1\`, so every non-ASCII filename is mojibaked at the transport-decode boundary before any sanitizer sees it, irreversibly; RFC 7578 section 4.2 records that multipart/form-data file names are typically UTF-8, which is what every standard client sends. Need different parser options? widen the factory rather than construct here. See ${URL}`;

export const requireUtf8MultipartParser = {
  meta: {
    type: 'problem',
    docs: {
      description: 'busboy may only be constructed inside packages/server/src/multipart.ts.',
      url: URL,
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee?.type !== 'Identifier' || node.callee.name !== 'busboy') return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
};
