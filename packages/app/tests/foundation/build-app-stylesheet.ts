import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import type { BrowserCommand } from 'vitest/node';

declare module 'vitest/browser' {
  interface BrowserCommands {
    buildAppStylesheet: () => Promise<string>;
  }
}

export const buildAppStylesheet: BrowserCommand<[]> = async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const output = await build({
    root,
    configFile: false,
    mode: 'production',
    logLevel: 'warn',
    build: {
      write: false,
      rolldownOptions: { input: fileURLToPath(new URL('../../src/globals.css', import.meta.url)) },
    },
  });
  const results = Array.isArray(output) ? output : [output];
  const stylesheets = results.flatMap((result) =>
    'output' in result
      ? result.output
          .filter((entry) => entry.type === 'asset')
          .filter((entry) => entry.fileName.endsWith('.css'))
      : [],
  );
  if (stylesheets.length !== 1) {
    throw new Error(`Expected one app stylesheet, received ${stylesheets.length}`);
  }
  const stylesheet = stylesheets[0];
  return typeof stylesheet.source === 'string'
    ? stylesheet.source
    : new TextDecoder().decode(stylesheet.source);
};
