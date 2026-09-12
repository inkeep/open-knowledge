import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const GLOBALS_CSS_PATH = join(import.meta.dirname, 'globals.css');

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

export interface CssBlock {
  prelude: string;
  declarations: string;
  ancestors: readonly string[];
}

export function collectBlocks(css: string): CssBlock[] {
  const source = blankComments(css);
  const blocks: CssBlock[] = [];
  const open: CssBlock[] = [];
  let segment = '';
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      segment += ch;
      if (ch === '\\') {
        segment += source[i + 1] ?? '';
        i++;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      segment += ch;
      continue;
    }
    if (ch === '{') {
      open.push({
        prelude: segment.trim(),
        declarations: '',
        ancestors: open.map((block) => block.prelude),
      });
      segment = '';
      continue;
    }
    if (ch === '}') {
      const done = open.pop();
      if (done) {
        done.declarations += segment;
        blocks.push(done);
      }
      segment = '';
      continue;
    }
    if (ch === ';') {
      const enclosing = open.at(-1);
      if (enclosing) enclosing.declarations += `${segment};`;
      segment = '';
      continue;
    }
    segment += ch;
  }
  return blocks;
}

export function normalizeSelector(selector: string): string {
  return selector.trim().replace(/\s+/g, ' ');
}

export function splitSelectorList(prelude: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of prelude) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map(normalizeSelector).filter((part) => part.length > 0);
}

export function readGlobalsCssRaw(): string {
  return readFileSync(GLOBALS_CSS_PATH, 'utf-8');
}

export function readGlobalsCssWithoutComments(): string {
  return blankComments(readGlobalsCssRaw());
}
