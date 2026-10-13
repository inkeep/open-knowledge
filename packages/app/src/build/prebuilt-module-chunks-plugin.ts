import { isAbsolute, relative, sep } from 'node:path';
import type { Plugin } from 'vite';
import { PREBUILT_MODULE_CHUNKS } from './prebuilt-dev-contract';

export function prebuiltModuleChunksPlugin(appRoot: string): Plugin {
  return {
    name: 'ok:prebuilt-module-chunks',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks = new Map<string, string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const id of output.moduleIds) {
          const path = id.split('?')[0] ?? '';
          if (!isAbsolute(path)) continue;
          const source = relative(appRoot, path).split(sep).join('/');
          if (source.startsWith('../')) continue;
          const carrier = chunks.get(source);
          if (carrier !== undefined && carrier !== output.fileName) {
            this.error(`${source} is bundled into both ${carrier} and ${output.fileName}`);
          }
          chunks.set(source, output.fileName);
        }
      }
      this.emitFile({
        type: 'asset',
        fileName: PREBUILT_MODULE_CHUNKS,
        source: `${JSON.stringify(Object.fromEntries([...chunks].sort()), null, 1)}\n`,
      });
    },
  };
}
