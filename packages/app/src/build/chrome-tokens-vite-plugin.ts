import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { resolveChromeTokensFromCss } from '../../../core/scripts/chrome-resolver.ts';

const LIGHT_PLACEHOLDER = '__OK_CHROME_BG_LIGHT__';
const DARK_PLACEHOLDER = '__OK_CHROME_BG_DARK__';

interface ChromeTokensPluginOptions {
  globalsCssPath?: string;
}

export function chromeTokensVitePlugin(options: ChromeTokensPluginOptions = {}): Plugin {
  const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
  const cssPath = options.globalsCssPath ?? resolve(HERE, '../globals.css');

  return {
    name: 'ok:chrome-tokens',
    enforce: 'pre',
    buildStart() {
      resolveChromeTokensFromCss(cssPath);
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html: string): string {
        const tokens = resolveChromeTokensFromCss(cssPath);
        return html
          .replaceAll(LIGHT_PLACEHOLDER, tokens.light)
          .replaceAll(DARK_PLACEHOLDER, tokens.dark);
      },
    },
  };
}
