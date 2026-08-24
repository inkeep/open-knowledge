import type { Point } from 'unist';
import { visit } from 'unist-util-visit';
import { defineOkfRule } from '../okf-runner.ts';

const WIKI_LINK = /\[\[[^[\]\n]+\]\]/g;

function describe(matched: string): string {
  const base = `Wiki-link ${matched} won't resolve for an external Open Knowledge Format consumer — it renders as literal text and its graph edge is lost.`;
  return matched.includes('|') ? `${base} The alias "|" also splits a GFM table cell.` : base;
}

export const noWikiLinks = defineOkfRule('no-wiki-links', (tree, file) => {
  const source = typeof file.value === 'string' ? file.value : String(file.value);
  visit(tree, 'text', (node) => {
    const start = node.position?.start;
    const end = node.position?.end;
    const base = start?.offset;
    const scanned =
      base === undefined || end?.offset === undefined ? node.value : source.slice(base, end.offset);
    let cursor = 0;
    let line = start?.line ?? 0;
    let column = start?.column ?? 0;
    const advanceTo = (index: number): Point => {
      for (; cursor < index; cursor += 1) {
        if (scanned[cursor] === '\n') {
          line += 1;
          column = 1;
        } else {
          column += 1;
        }
      }
      return { line, column };
    };
    for (const match of scanned.matchAll(WIKI_LINK)) {
      const { index } = match;
      const preceding = base === undefined ? scanned[index - 1] : source[base + index - 1];
      if (preceding === '!') continue;
      const place =
        start && base !== undefined
          ? { start: advanceTo(index), end: advanceTo(index + match[0].length) }
          : undefined;
      file.message(describe(match[0]), place);
    }
  });
});
