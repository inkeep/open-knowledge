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
  let resolved: { light: string; dark: string } | null = null;

  function resolveOnce(): { light: string; dark: string } {
    if (resolved !== null) return resolved;
    resolved = resolveChromeTokensFromCss(cssPath);
    return resolved;
  }

  return {
    name: 'ok:chrome-tokens',
    enforce: 'pre',
    buildStart() {
      resolveOnce();
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html: string): string {
        const tokens = resolveOnce();
        return html
          .replaceAll(LIGHT_PLACEHOLDER, tokens.light)
          .replaceAll(DARK_PLACEHOLDER, tokens.dark);
      },
    },
  };
}
