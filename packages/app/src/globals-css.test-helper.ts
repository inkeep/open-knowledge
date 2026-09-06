import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const GLOBALS_CSS_PATH = join(import.meta.dirname, 'globals.css');

export const FULL_PAGE_CM_HOST_SELECTORS = {
  mermaidDocEditor: '[data-mermaid-doc-editor]',
  sourceEditor: '.source-editor',
  textDocEditor: '[data-text-doc-editor]',
} as const;

export function blankComments(css: string): string {
  let out = '';
  let quote: string | null = null;
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (quote) {
      if (ch === '\\') {
        out += css.slice(i, i + 2);
        i += 2;
        continue;
      }
      out += ch;
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end === -1 ? css.length : end + 2;
      out += css.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export function readGlobalsCssRaw(): string {
  return readFileSync(GLOBALS_CSS_PATH, 'utf-8');
}

export function readGlobalsCssWithoutComments(): string {
  return blankComments(readGlobalsCssRaw());
}
