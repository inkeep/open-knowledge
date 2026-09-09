import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

const GUARD_SCRIPT_PATH = resolve(
  import.meta.dirname ?? new URL('.', import.meta.url).pathname,
  './rejection-loop-guard-script.js',
);

export function rejectionLoopGuardPlugin(): Plugin {
  const guardScript = readFileSync(GUARD_SCRIPT_PATH, 'utf-8');
  return {
    name: 'ok:rejection-loop-guard',
    apply: 'serve',
    transformIndexHtml: {
      order: 'pre',
      handler() {
        return [
          {
            tag: 'script',
            attrs: { type: 'text/javascript' },
            children: guardScript,
            injectTo: 'head-prepend',
          },
        ];
      },
    },
  };
}
