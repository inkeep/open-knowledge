import { describe, expect, test } from 'bun:test';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { GFM } from '@lezer/markdown';
import { buildDecorationsForRanges } from './view-plugin';

/**
 * Unit tests for source-polish view-plugin's decoration builder.
 *
 * Calls `buildDecorationsForRanges(state, ranges)` directly — no EditorView, so
 * no DOM needed (Bun test env has no `document`). We always pass a whole-doc
 * range because the ViewPlugin's viewport-scoping is a separate concern covered
 * by Playwright.
 *
 * We inspect the returned DecorationSet by iterating it and extracting
 * class names via `spec.class`. Pure range-and-class-level assertions;
 * no rendering.
 */

function createState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [GFM] })],
  });
}

interface DecoInfo {
  from: number;
  to: number;
  classes: string;
  style: string;
  isLine: boolean;
}

function collect(doc: string): DecoInfo[] {
  const state = createState(doc);
  const set = buildDecorationsForRanges(state, [{ from: 0, to: state.doc.length }]);
  const out: DecoInfo[] = [];
  const cursor = set.iter();
  while (cursor.value) {
    const spec =
      (
        cursor.value as unknown as {
          spec?: { class?: string; attributes?: { style?: string } };
        }
      ).spec ?? {};
    // Line decorations in CM6 are zero-length (from === to) and have attributes.
    // Mark decorations span a range.
    const isLine = cursor.from === cursor.to;
    out.push({
      from: cursor.from,
      to: cursor.to,
      classes: (spec.class ?? '') as string,
      style: spec.attributes?.style ?? '',
      isLine,
    });
    cursor.next();
  }
  return out;
}

function classesAtLine(decos: DecoInfo[], lineFrom: number): string[] {
  return decos.filter((d) => d.isLine && d.from === lineFrom).map((d) => d.classes);
}

function styleAtLine(decos: DecoInfo[], lineFrom: number): string[] {
  return decos.filter((d) => d.isLine && d.from === lineFrom).map((d) => d.style);
}

function markRangesWithClass(decos: DecoInfo[], cls: string): Array<{ from: number; to: number }> {
  return decos
    .filter((d) => !d.isLine && d.classes.split(/\s+/).includes(cls))
    .map(({ from, to }) => ({ from, to }));
}

describe('source-polish view-plugin — buildDecorationsForRanges', () => {
  describe('Strikethrough — .cm-del', () => {
    test('applies .cm-del to content between ~~ delimiters, not the delimiters', () => {
      const doc = 'a ~~struck~~ b';
      const decos = collect(doc);
      const delRanges = markRangesWithClass(decos, 'cm-del');
      expect(delRanges).toHaveLength(1);
      expect(doc.slice(delRanges[0].from, delRanges[0].to)).toBe('struck');
    });

    test('no .cm-del when no strikethrough in doc', () => {
      expect(markRangesWithClass(collect('plain text only'), 'cm-del')).toHaveLength(0);
    });

    test('multiple strikethroughs get individual marks', () => {
      const doc = '~~one~~ and ~~two~~';
      const decos = collect(doc);
      const delRanges = markRangesWithClass(decos, 'cm-del');
      expect(delRanges).toHaveLength(2);
      expect(doc.slice(delRanges[0].from, delRanges[0].to)).toBe('one');
      expect(doc.slice(delRanges[1].from, delRanges[1].to)).toBe('two');
    });

    test('strikethrough with leading/trailing whitespace inside delimiters', () => {
      const doc = '~~ padded ~~';
      const decos = collect(doc);
      const delRanges = markRangesWithClass(decos, 'cm-del');
      // Strikethrough parser treats these as potential delimiters; as long as
      // we extract exactly what's between the two delimiters, we're correct.
      if (delRanges.length > 0) {
        expect(doc.slice(delRanges[0].from, delRanges[0].to)).toBe(' padded ');
      }
    });
  });

  describe('List — .cm-list-item', () => {
    test('unordered bullets get .cm-list-item on each item line', () => {
      const doc = '- hello\n- world';
      const decos = collect(doc);
      expect(classesAtLine(decos, 0).join(' ')).toContain('cm-list-item');
      expect(classesAtLine(decos, 8).join(' ')).toContain('cm-list-item');
    });

    test('ordered list gets .cm-list-item', () => {
      const doc = '1. first\n2. second';
      const decos = collect(doc);
      expect(classesAtLine(decos, 0).join(' ')).toContain('cm-list-item');
      expect(classesAtLine(decos, 9).join(' ')).toContain('cm-list-item');
    });

    test('task items (GFM) get .cm-list-item', () => {
      const doc = '- [ ] todo\n- [x] done';
      const decos = collect(doc);
      expect(classesAtLine(decos, 0).join(' ')).toContain('cm-list-item');
      expect(classesAtLine(decos, 11).join(' ')).toContain('cm-list-item');
    });

    test('plain paragraph does NOT get .cm-list-item', () => {
      expect(classesAtLine(collect('just a paragraph'), 0).join(' ')).not.toContain('cm-list-item');
    });

    test('nested list — each item gets its own .cm-list-item', () => {
      const doc = '- outer\n  - inner';
      const decos = collect(doc);
      // outer at offset 0, inner at offset 8 (after "\n  - ")
      const outerClasses = classesAtLine(decos, 0).join(' ');
      const innerClasses = classesAtLine(decos, 8).join(' ');
      expect(outerClasses).toContain('cm-list-item');
      expect(innerClasses).toContain('cm-list-item');
    });
  });

  describe('FencedCode — .cm-fenced-code-line', () => {
    test('content lines get .cm-fenced-code-line; fence lines do NOT', () => {
      const doc = '```ts\nconst x = 1;\n```';
      //           0         6          19
      const decos = collect(doc);
      expect(classesAtLine(decos, 0).join(' ')).not.toContain('cm-fenced-code-line');
      expect(classesAtLine(decos, 6).join(' ')).toContain('cm-fenced-code-line');
      expect(classesAtLine(decos, 19).join(' ')).not.toContain('cm-fenced-code-line');
    });

    test('empty fenced block (no content) produces no .cm-fenced-code-line', () => {
      const decos = collect('```\n```');
      const any = decos.some((d) => d.classes?.includes('cm-fenced-code-line'));
      expect(any).toBe(false);
    });

    test('multi-line content — every content line decorated', () => {
      const doc = '```js\na\nb\nc\n```';
      const decos = collect(doc);
      const fencedLines = decos.filter((d) => d.classes?.includes('cm-fenced-code-line'));
      expect(fencedLines).toHaveLength(3);
    });
  });

  describe('Tables — .cm-table-header / .cm-table-row', () => {
    test('header row → .cm-table-header; body row → .cm-table-row; delimiter row → .cm-table-row', () => {
      const doc = '| a | b |\n| - | - |\n| 1 | 2 |';
      //           0           10         20
      const decos = collect(doc);
      expect(classesAtLine(decos, 0).join(' ')).toContain('cm-table-header');
      expect(classesAtLine(decos, 10).join(' ')).toContain('cm-table-row');
      expect(classesAtLine(decos, 20).join(' ')).toContain('cm-table-row');
    });

    test('table lines carry --list-hang: 2ch so the hang composes through the .cm-line calc (like lists)', () => {
      const doc = '| a | b |\n| - | - |\n| 1 | 2 |';
      //           0           10         20
      const decos = collect(doc);
      // Header, delimiter row, and body row must each set the inline --list-hang
      // the base .cm-line additive-calc consumes; without it the base !important
      // padding overrides the table rule while its negative text-indent leaks,
      // pulling table lines ~2ch left of prose.
      expect(styleAtLine(decos, 0).join(' ')).toContain('--list-hang: 2ch');
      expect(styleAtLine(decos, 10).join(' ')).toContain('--list-hang: 2ch');
      expect(styleAtLine(decos, 20).join(' ')).toContain('--list-hang: 2ch');
    });

    test('each table line gets exactly ONE of {cm-table-header, cm-table-row} — no duplicate from TableDelimiter nested in TableRow', () => {
      const doc = '| alpha | beta |\n| - | - |\n| one | two |';
      const decos = collect(doc);
      const lineStarts = [0, 17, 27];
      for (const start of lineStarts) {
        const classes = classesAtLine(decos, start);
        const tableClasses = classes.filter(
          (c) => c.includes('cm-table-header') || c.includes('cm-table-row'),
        );
        expect(tableClasses).toHaveLength(1);
      }
    });

    test('single-column table still gets header + row classes', () => {
      const doc = '| only |\n| - |\n| val |';
      const decos = collect(doc);
      expect(classesAtLine(decos, 0).join(' ')).toContain('cm-table-header');
      expect(classesAtLine(decos, 9).join(' ')).toContain('cm-table-row');
      expect(classesAtLine(decos, 15).join(' ')).toContain('cm-table-row');
    });

    test('plain paragraph with a | in it does NOT get table classes', () => {
      const classes = classesAtLine(collect('a pipe | in prose should not decorate'), 0).join(' ');
      expect(classes).not.toContain('cm-table-row');
      expect(classes).not.toContain('cm-table-header');
    });
  });

  describe('Composition — nested constructs', () => {
    test('strikethrough inside list item: line carries .cm-list-item AND content has .cm-del', () => {
      const doc = '- buy ~~milk~~ and eggs';
      const decos = collect(doc);
      expect(classesAtLine(decos, 0).join(' ')).toContain('cm-list-item');
      const delRanges = markRangesWithClass(decos, 'cm-del');
      expect(delRanges).toHaveLength(1);
      expect(doc.slice(delRanges[0].from, delRanges[0].to)).toBe('milk');
    });
  });

  describe('YAML frontmatter — decorations skip the FM region', () => {
    test('list-style items inside `--- … ---` do NOT get .cm-list-item', () => {
      // Markdown-list parsing fires on `  - characters` even though the
      // line is inside a YAML frontmatter block. Applying `.cm-list-item`'s
      // negative `text-indent` to YAML lines clips the leading whitespace
      // into negative-x and makes `  - foo` render flush-left. Skip those
      // decorations for any node inside the FM region.
      const doc = '---\ntags:\n  - characters\n  - air-nomads\n---\n# Body\n';
      const decos = collect(doc);
      // line 3 (`  - characters`) starts at offset 11; line 4 (`  - air-nomads`)
      // at offset 28. Neither should carry `cm-list-item`.
      expect(classesAtLine(decos, 11).join(' ')).not.toContain('cm-list-item');
      expect(classesAtLine(decos, 28).join(' ')).not.toContain('cm-list-item');
    });

    test('body list items AFTER the FM block still get .cm-list-item', () => {
      const doc = '---\ntags:\n  - characters\n---\n- body item\n';
      const decos = collect(doc);
      // Find the body list line — `- body item` after the closing fence.
      const bodyListStart = doc.indexOf('- body item');
      expect(classesAtLine(decos, bodyListStart).join(' ')).toContain('cm-list-item');
    });

    test('FM region with a trailing space on the opening fence still skips decorations', () => {
      // `--- ` is one in-tolerance source-mode keystroke away from `---`.
      // The user watching source mode must not see the FM region's YAML
      // lines snap into list styling mid-keystroke.
      const doc = '--- \ntags:\n  - characters\n  - air-nomads\n---\n# Body\n';
      const decos = collect(doc);
      const lineOne = doc.indexOf('  - characters');
      const lineTwo = doc.indexOf('  - air-nomads');
      expect(classesAtLine(decos, lineOne).join(' ')).not.toContain('cm-list-item');
      expect(classesAtLine(decos, lineTwo).join(' ')).not.toContain('cm-list-item');
    });

    test('FM region with a trailing space on the closing fence still skips decorations', () => {
      const doc = '---\ntags:\n  - characters\n--- \n# Body\n';
      const decos = collect(doc);
      const yamlListLine = doc.indexOf('  - characters');
      expect(classesAtLine(decos, yamlListLine).join(' ')).not.toContain('cm-list-item');
    });

    test('a leading space before the opening fence means no FM region — list styling applies', () => {
      const doc = ' ---\ntags:\n  - characters\n---\n# Body\n';
      const decos = collect(doc);
      const listLine = doc.indexOf('  - characters');
      expect(classesAtLine(decos, listLine).join(' ')).toContain('cm-list-item');
    });

    test('doc with no FM block: list items render with .cm-list-item as before', () => {
      const doc = '- alpha\n- beta\n';
      const decos = collect(doc);
      expect(classesAtLine(decos, 0).join(' ')).toContain('cm-list-item');
      expect(classesAtLine(decos, 8).join(' ')).toContain('cm-list-item');
    });
  });
});
