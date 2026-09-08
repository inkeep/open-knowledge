import { docsUrl } from '../docs.mjs';

const URL = docsUrl('no-uninstall-forbidden-import');

const FORBIDDEN_MESSAGE = `Forbidden module in the uninstall entry — the uninstall window must connect to nothing (survey/completion run after the server is stopped and ~/.ok is removed). Drop this editor / CRDT / provider-pool / Hocuspocus-server import; keep only shared types + constants from @inkeep/open-knowledge-core. See ${URL}`;
const DYNAMIC_MESSAGE = `Dynamic import under src/uninstall — the uninstall screens must eager-load so the completion/failure screens paint from memory after teardown starts removing files. Use a static import. See ${URL}`;

const FORBIDDEN_SOURCE =
  /^(?:@\/editor\/.*|@inkeep\/open-knowledge-server.*|@hocuspocus\/.*|@tiptap\/y-tiptap.*|@tiptap\/extension-collaboration.*|yjs(?:\/.*)?|y-protocols(?:\/.*)?|y-prosemirror(?:\/.*)?|y-codemirror\.next(?:\/.*)?|y-indexeddb(?:\/.*)?)$/;

export const noUninstallForbiddenImport = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'The uninstall entry may not import editor/CRDT/server modules, or import dynamically.',
      url: URL,
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const value = node.source?.value;
        if (typeof value !== 'string' || !FORBIDDEN_SOURCE.test(value)) return;
        context.report({ node, message: FORBIDDEN_MESSAGE });
      },
      ImportExpression(node) {
        context.report({ node, message: DYNAMIC_MESSAGE });
      },
    };
  },
};
