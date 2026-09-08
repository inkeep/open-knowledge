import { docsUrl } from '../docs.mjs';

const URL = docsUrl('no-loosely-typed-webcontents-ipc');

const MESSAGE = `Direct electron IPC primitive — route through createInvoker / createHandler / sendToRenderer from packages/desktop/src/shared/ipc-*.ts. See ${URL}`;

const FORBIDDEN = new Set([
  'webContents.send',
  'ipcMain.handle',
  'ipcMain.on',
  'ipcRenderer.invoke',
  'ipcRenderer.on',
  'ipcRenderer.once',
]);

function memberPath(callee) {
  if (!callee || (callee.type !== 'MemberExpression' && callee.type !== 'StaticMemberExpression')) {
    return '';
  }
  const property = callee.property;
  if (!property || property.type !== 'Identifier') return '';
  const object = callee.object;
  if (object?.type !== 'Identifier') return '';
  return `${object.name}.${property.name}`;
}

export const noLooselyTypedWebcontentsIpc = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Direct electron IPC primitives must route through the typed wrappers.',
      url: URL,
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!FORBIDDEN.has(memberPath(node.callee))) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
};
