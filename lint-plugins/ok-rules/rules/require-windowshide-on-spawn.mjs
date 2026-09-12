import { docsUrl } from '../docs.mjs';

const URL = docsUrl('require-windowshide-on-spawn');

const MESSAGE = `child_process spawn without a hidden Windows console — wrap the options in \`withHiddenWindowsConsole(...)\` (from @inkeep/open-knowledge-server) or add \`windowsHide: true\`. On Windows a console-less parent (MCP-spawned/detached OK server) flashes a terminal window on every spawn; the flag is a no-op on macOS/Linux, so add it unconditionally. macOS/Linux-only spawn, or a same-named wrapper (not node:child_process)? suppress with \`// oxlint-disable-next-line ok/require-windowshide-on-spawn -- <reason>\`. See ${URL}`;

const SPAWNERS = new Set([
  'spawn',
  'spawnSync',
  'execSync',
  'execFile',
  'execFileSync',
  'nodeSpawn',
  'execFileAsync',
]);

export const requireWindowshideOnSpawn = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Every child_process spawn must hide the Windows console window.',
      url: URL,
    },
  },
  create(context) {
    const source = context.sourceCode;
    return {
      CallExpression(node) {
        if (node.callee?.type !== 'Identifier' || !SPAWNERS.has(node.callee.name)) return;
        const text = source.getText(node);
        if (text.includes('windowsHide:') || text.includes('withHiddenWindowsConsole(')) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
};
