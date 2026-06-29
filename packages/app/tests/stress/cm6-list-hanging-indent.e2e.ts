import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  type ApiHelpers,
  expect,
  filterCriticalErrors,
  type LogEntry,
  test,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

const errors: LogEntry[] = [];

test.beforeEach(({ page }) => {
  errors.length = 0;
  page.on('pageerror', (err) => errors.push({ type: 'uncaught', text: err.message }));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const loc = msg.location();
      errors.push({ type: 'error', text: msg.text(), url: loc.url, line: loc.lineNumber });
    }
  });
});

test.afterEach(() => {
  expect(filterCriticalErrors(errors), 'Expected zero critical console errors').toEqual([]);
});

const SUBPIXEL_TOLERANCE_PX = 1;

interface ListLineSample {
  marker: string;
  expectedHangCh: number;
}

const FIXTURE: readonly ListLineSample[] = [
  { marker: '- bullet dash', expectedHangCh: 2 },
  { marker: '* bullet star', expectedHangCh: 2 },
  { marker: '+ bullet plus', expectedHangCh: 2 },
  { marker: '1. ordered single', expectedHangCh: 3 },
  { marker: '10. ordered two-digit', expectedHangCh: 4 },
  { marker: '100. ordered three-digit', expectedHangCh: 5 },
  { marker: '1) ordered with paren', expectedHangCh: 3 },
  { marker: '- [ ] task unchecked', expectedHangCh: 6 },
  { marker: '- [x] task checked', expectedHangCh: 6 },
  { marker: '  - nested bullet', expectedHangCh: 4 },
  { marker: '  - [ ] nested task', expectedHangCh: 8 },
];

const FIXTURE_MARKDOWN = FIXTURE.map((s) => s.marker).join('\n\n');

async function seedMarkdown(api: ApiHelpers, docName: string, markdown: string) {
  await api.replaceDoc(docName, markdown);
}

async function switchToSourceAndWaitForLists(page: Page, expectedListCount: number) {
  await page.getByRole('radio', { name: 'Markdown source' }).click();
  await page.waitForSelector('.cm-content', { timeout: 10_000 });
  await page.waitForFunction(
    (n) => document.querySelectorAll('.cm-line.cm-list-item').length >= n,
    expectedListCount,
    { timeout: 10_000 },
  );
}

interface MeasuredLine {
  marker: string;
  lineLeft: number;
  firstChildLeft: number;
  paddingLeftPx: number;
  textIndentPx: number;
}

async function measureListLines(page: Page): Promise<MeasuredLine[]> {
  return page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll<HTMLElement>('.cm-line.cm-list-item'));
    const out: Array<{
      marker: string;
      lineLeft: number;
      firstChildLeft: number;
      paddingLeftPx: number;
      textIndentPx: number;
    }> = [];

    for (const line of lines) {
      const lineRect = line.getBoundingClientRect();
      const cs = getComputedStyle(line);
      const paddingLeftPx = parseFloat(cs.paddingLeft) || 0;
      const textIndentPx = parseFloat(cs.textIndent) || 0;
      const text = line.textContent ?? '';

      let firstChildLeft = lineRect.left;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      const firstTextNode = walker.nextNode() as Text | null;
      if (firstTextNode?.nodeValue && firstTextNode.nodeValue.length > 0) {
        const range = document.createRange();
        range.setStart(firstTextNode, 0);
        range.setEnd(firstTextNode, 1);
        const rangeRect = range.getBoundingClientRect();
        firstChildLeft = rangeRect.left;
      }

      out.push({
        marker: text,
        lineLeft: lineRect.left,
        firstChildLeft,
        paddingLeftPx,
        textIndentPx,
      });
    }
    return out;
  });
}

test.describe('CM6 source-mode padding contract', () => {
  test('every list-marker variant: firstChild.left >= line.left (no gutter overflow)', async ({
    page,
    api,
  }) => {
    const docName = `cm6-hang-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');

    await seedMarkdown(api, docName, FIXTURE_MARKDOWN);
    await switchToSourceAndWaitForLists(page, FIXTURE.length);

    const measured = await measureListLines(page);

    expect(
      measured.length,
      `expected ${FIXTURE.length} .cm-line.cm-list-item rows but found ${measured.length}`,
    ).toBe(FIXTURE.length);

    const violations = measured
      .filter((m) => m.firstChildLeft < m.lineLeft - SUBPIXEL_TOLERANCE_PX)
      .map(
        (m) =>
          `  • "${m.marker.slice(0, 40)}": firstChild.left=${m.firstChildLeft.toFixed(2)}px ` +
          `is ${(m.lineLeft - m.firstChildLeft).toFixed(2)}px LEFT of line.left=${m.lineLeft.toFixed(2)}px ` +
          `(padding-left=${m.paddingLeftPx.toFixed(2)}px, text-indent=${m.textIndentPx.toFixed(2)}px ` +
          `→ net=${(m.paddingLeftPx + m.textIndentPx).toFixed(2)}px which must be ≥ 0)`,
      );

    expect(
      violations,
      `\nThe following list lines render their first character LEFT of the line's own content box ` +
        `(violating the hanging-indent invariant — the first character should never paint into the gutter):\n` +
        violations.join('\n') +
        `\n\nA correct fix keeps "padding-inline-start" and "-text-indent" balanced on .cm-list-item ` +
        `so net = padding-left + text-indent >= 0.`,
    ).toEqual([]);
  });

  test('fenced code: source-indent is visible (var(--line-indent) honored)', async ({
    page,
    api,
  }) => {
    const docName = `cm6-fenced-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');

    const fencedFixture = [
      '```js',
      'unindented',
      '  two_space',
      '    four_space',
      '        eight_space',
      '```',
      '',
    ].join('\n');
    await seedMarkdown(api, docName, fencedFixture);

    await page.getByRole('radio', { name: 'Markdown source' }).click();
    await page.waitForSelector('.cm-content', { timeout: 10_000 });
    await page.waitForFunction(
      () => document.querySelectorAll('.cm-line.cm-fenced-code-line').length >= 4,
      null,
      { timeout: 10_000 },
    );

    const measured = await page.evaluate(() => {
      const lines = Array.from(document.querySelectorAll('.cm-line.cm-fenced-code-line'));
      return lines.map((line) => {
        const cs = getComputedStyle(line);
        const lineRect = line.getBoundingClientRect();
        let firstTextNode: Text | null = null;
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const n = walker.currentNode as Text;
          if (n.nodeValue && n.nodeValue.length > 0) {
            firstTextNode = n;
            break;
          }
        }
        let firstCharLeft = Number.NaN;
        if (firstTextNode) {
          const range = document.createRange();
          range.setStart(firstTextNode, 0);
          range.setEnd(firstTextNode, 1);
          firstCharLeft = range.getBoundingClientRect().left;
        }
        return {
          lineIndent: Number((cs.getPropertyValue('--line-indent') || '0').trim()),
          firstCharLeft,
          lineLeft: lineRect.left,
          text: (line.textContent || '').slice(0, 32),
        };
      });
    });

    expect(measured.length, 'expected 4 .cm-line.cm-fenced-code-line rows').toBe(4);

    expect(
      measured.filter((m) => Number.isNaN(m.firstCharLeft)),
      'every fenced-code line must yield a measurable first character',
    ).toEqual([]);

    const sorted = [...measured].sort((a, b) => a.lineIndent - b.lineIndent);
    const violations: string[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const delta = curr.firstCharLeft - prev.firstCharLeft;
      if (delta <= 0.5) {
        violations.push(
          `  • --line-indent=${curr.lineIndent} first.left=${curr.firstCharLeft.toFixed(2)}px ` +
            `is NOT to the right of --line-indent=${prev.lineIndent} first.left=${prev.firstCharLeft.toFixed(2)}px ` +
            `(delta=${delta.toFixed(2)}px; expected >0). Source-indent is not visible — the .cm-line ` +
            `producer rule is overriding .cm-fenced-code-line's padding-inline-start without ` +
            `incorporating --line-indent.`,
        );
      }
    }

    expect(
      violations,
      `\nFenced-code lines with progressively-larger --line-indent must shift their first ` +
        `character progressively further right. All-flat first-char-x across distinct ` +
        `--line-indent values means the cascade clobber dropped the indent silently.\n\n` +
        `Measurements (sorted by --line-indent):\n` +
        sorted
          .map(
            (m) =>
              `  • --line-indent=${m.lineIndent} line.left=${m.lineLeft.toFixed(2)} ` +
              `first.left=${m.firstCharLeft.toFixed(2)} text=${JSON.stringify(m.text)}`,
          )
          .join('\n') +
        (violations.length > 0 ? `\n\nViolations:\n${violations.join('\n')}` : ''),
    ).toEqual([]);
  });

  test('table lines align with prose (not pulled left of the baseline)', async ({ page, api }) => {
    const docName = `cm6-table-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');

    const tableFixture = [
      'Baseline prose paragraph for alignment.',
      '',
      '| Species | Count |',
      '| --- | --- |',
      '| Flounder | 4 |',
      '',
    ].join('\n');
    await seedMarkdown(api, docName, tableFixture);

    await page.getByRole('radio', { name: 'Markdown source' }).click();
    await page.waitForSelector('.cm-content', { timeout: 10_000 });
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.cm-line.cm-table-header').length >= 1 &&
        document.querySelectorAll('.cm-line.cm-table-row').length >= 2,
      null,
      { timeout: 10_000 },
    );

    const measured = await page.evaluate(() => {
      function firstGlyphLeft(line: HTMLElement): number {
        const lineLeft = line.getBoundingClientRect().left;
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode() as Text | null;
        while (node && (!node.nodeValue || node.nodeValue.length === 0)) {
          node = walker.nextNode() as Text | null;
        }
        if (!node?.nodeValue) return lineLeft;
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, 1);
        return range.getBoundingClientRect().left;
      }
      function measureLine(line: HTMLElement) {
        const cs = getComputedStyle(line);
        return {
          text: (line.textContent ?? '').slice(0, 40),
          firstGlyphLeft: firstGlyphLeft(line),
          lineLeft: line.getBoundingClientRect().left,
          paddingLeftPx: parseFloat(cs.paddingLeft) || 0,
          textIndentPx: parseFloat(cs.textIndent) || 0,
        };
      }
      const allLines = Array.from(document.querySelectorAll<HTMLElement>('.cm-content .cm-line'));
      const proseEl = allLines.find(
        (l) =>
          (l.textContent ?? '').includes('Baseline prose') &&
          !l.classList.contains('cm-table-row') &&
          !l.classList.contains('cm-table-header') &&
          !l.classList.contains('cm-list-item') &&
          !l.classList.contains('cm-fenced-code-line'),
      );
      const tableLines = Array.from(
        document.querySelectorAll<HTMLElement>('.cm-line.cm-table-header, .cm-line.cm-table-row'),
      );
      return {
        prose: proseEl ? measureLine(proseEl) : null,
        tableLines: tableLines.map(measureLine),
      };
    });

    const prose = measured.prose;
    if (!prose) throw new Error('expected a plain prose .cm-line baseline but found none');

    expect(
      measured.tableLines.length,
      'expected 3 table lines (header + delimiter + 1 data row)',
    ).toBe(3);

    const violations = measured.tableLines
      .filter((t) => Math.abs(t.firstGlyphLeft - prose.firstGlyphLeft) > SUBPIXEL_TOLERANCE_PX)
      .map(
        (t) =>
          `  • "${t.text}": firstGlyph.left=${t.firstGlyphLeft.toFixed(2)}px is ` +
          `${(prose.firstGlyphLeft - t.firstGlyphLeft).toFixed(2)}px off the prose baseline ` +
          `(${prose.firstGlyphLeft.toFixed(2)}px) — padding-left=${t.paddingLeftPx.toFixed(2)}px, ` +
          `text-indent=${t.textIndentPx.toFixed(2)}px → net=${(t.paddingLeftPx + t.textIndentPx).toFixed(2)}px`,
      );

    expect(
      violations,
      `\nTable lines must start at the same x as surrounding prose in source mode. ` +
        `The following are offset from the prose baseline (the bug: --list-hang unset on ` +
        `table lines, so .cm-line's !important padding overrides the standalone .cm-table-row ` +
        `padding while its -2ch text-indent still applies, pulling the table left):\n` +
        violations.join('\n'),
    ).toEqual([]);
  });
});
