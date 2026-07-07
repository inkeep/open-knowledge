/**
 * CM6 source-mode list hanging-indent - first-character overflow regression.
 *
 * Pins the CSS hanging-indent invariant for `.cm-line.cm-list-item`:
 *
 *   "The first rendered character of a list-item line MUST NOT paint to the
 *    LEFT of the line's own content box. The first rendered glyph's left
 *    edge (measured via a Range over the first text node - see
 *    `measureListLines`) must be ≥ the line element's left edge (within
 *    ≤1px of subpixel rounding). Otherwise the leading marker (`-`, `1.`,
 *    `- [ ]`) overflows into the line-number gutter."
 *
 * Adjacent test in `source-polish.e2e.ts` only compares the parent
 * `.cm-line` boxes against each other and so cannot catch this class of
 * bug — `.cm-line` itself stays at the correct x; the regression is that
 * its FIRST CHILD paints negative-x relative to the parent because the
 * `text-indent: -Nch` is applied while the matching `padding-inline-start`
 * is silently overridden by a broader `!important` rule on `.cm-line`.
 *
 * Fixture deliberately covers every list-marker variant the underlying
 * `LIST_PREFIX_RE` recognizes (see view-plugin.ts), because hang width
 * scales with marker length and the bug surfaces at all hang values
 * > ~2ch:
 *   - plain bullet           (`- foo`             → 2ch hang)
 *   - asterisk bullet        (`* foo`             → 2ch hang)
 *   - plus bullet            (`+ foo`             → 2ch hang)
 *   - ordered, single digit  (`1. foo`            → 3ch hang)
 *   - ordered, two digit     (`10. foo`           → 4ch hang)
 *   - ordered, three digit   (`100. foo`          → 5ch hang)
 *   - ordered with paren     (`1) foo`            → 3ch hang)
 *   - task unchecked         (`- [ ] foo`         → 6ch hang)
 *   - task checked           (`- [x] foo`         → 6ch hang)
 *   - nested bullet          (`  - foo`           → 4ch hang via leading ws)
 *   - nested task            (`  - [ ] foo`       → 8ch hang)
 *
 * The assertion shape is behavior-only: child-left ≥ parent-left. The test
 * does NOT pin which fix lands (drop `!important`, add `!important`,
 * reformulate as `padding: calc(1rem + Nch)` — all three produce the same
 * observable result and must all keep the test green).
 *
 * Per-test isolation: per-test docName via `randomUUID()`;
 * per-worker dev server fixture from
 * `_helpers/fixtures.ts`.
 *
 * Requires: Playwright Chromium installed.
 */

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

// Console-error monitoring follows the precedent from source-polish.e2e.ts: an
// uncaught exception or console.error during editor mount or CRDT sync can
// leave the editor partially rendered, and the geometric assertions below
// would then measure a degenerate layout yet still pass. The
// filterCriticalErrors helper strips known noise (reconnect races etc.) and
// surfaces anything genuinely critical for the afterEach gate.
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

// 1px tolerance absorbs subpixel rounding from font metrics. The bug under
// test is ~9px (`1. ` → 3ch) up to ~45px (`  - [ ] ` → 8ch); 1px is well
// inside that band and well outside any legitimate antialiasing slop.
const SUBPIXEL_TOLERANCE_PX = 1;

interface ListLineSample {
  /** The markdown source line (used for failure messages). */
  marker: string;
  /** Resolved `--list-hang` value the ViewPlugin is expected to set (in ch). */
  expectedHangCh: number;
}

/**
 * Maximal-coverage fixture: each entry maps to one rendered `.cm-line`
 * carrying `.cm-list-item`. The numeric `expectedHangCh` documents what
 * `LIST_PREFIX_RE` should capture; it is informational only — the
 * assertion is on rendered geometry, not on `--list-hang`.
 */
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

/**
 * The fixture is composed with blank-line separators so each entry becomes
 * its own top-level list and gets its own `.cm-line` (otherwise consecutive
 * `- foo` would merge into one list and `LIST_PREFIX_RE` is still applied
 * per-line, but the visual output stays one block).
 */
const FIXTURE_MARKDOWN = FIXTURE.map((s) => s.marker).join('\n\n');

/** Seed content via agent-write-md API (replace mode). */
async function seedMarkdown(api: ApiHelpers, docName: string, markdown: string) {
  await api.replaceDoc(docName, markdown);
}

/**
 * Switch to source mode and wait for CodeMirror to render at least
 * `expectedListCount` decorated list lines. CM6 paints decorations
 * synchronously on the next animation frame after the editor mounts, so
 * waiting on the `.cm-list-item` count (rather than a fixed timeout) is the
 * reliable condition - it implies both the CM6 mount AND the source-polish
 * decoration pass have completed for every fixture row before the caller
 * measures geometry.
 */
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
  /** Rendered text content of the `.cm-line.cm-list-item` DOM node (used for failure messages). */
  marker: string;
  /** Computed bounding-rect of the `.cm-line.cm-list-item` element. */
  lineLeft: number;
  /** Bounding-rect left of the first descendant text in the line. */
  firstChildLeft: number;
  /** Computed `padding-left` (px). Diagnostic for failure messages. */
  paddingLeftPx: number;
  /** Computed `text-indent` (px). Diagnostic for failure messages. */
  textIndentPx: number;
}

/**
 * Walk every `.cm-line.cm-list-item` in the editor and measure both the
 * line's own left edge and the left edge of its leftmost rendered glyph.
 *
 * "Leftmost glyph" is approximated by the bounding rect of the first
 * non-empty Range over the line's text content. CM6 wraps source text in
 * a chain of `<span>` shells (`.cm-builtin`, `.cm-keyword`, etc.); reading
 * `firstChild.getBoundingClientRect()` would catch the first SHELL but
 * that shell may be zero-width in some markdown spans. Using a Range over
 * the actual text node is the geometrically truthful read — it is
 * exactly the rectangle the browser paints into.
 */
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

      // Build a Range over the first character of the line's text. The
      // Range's bounding rect is the painted glyph rectangle — this is
      // what the user sees on screen, regardless of which inline shell
      // span CM6 wrapped the character in.
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
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    await seedMarkdown(api, docName, FIXTURE_MARKDOWN);
    await switchToSourceAndWaitForLists(page, FIXTURE.length);

    const measured = await measureListLines(page);

    // Sanity: we got the expected number of list-decorated lines. If this
    // fails the test setup is wrong and the geometric assertions below
    // are meaningless.
    expect(
      measured.length,
      `expected ${FIXTURE.length} .cm-line.cm-list-item rows but found ${measured.length}`,
    ).toBe(FIXTURE.length);

    // Per-line invariant: firstChild.left >= line.left (within ≤1px).
    // Build a single failure-mode summary so the assertion error names
    // EVERY violating line, not just the first one — this matters because
    // the bug presents differently per marker length and a fix verified
    // on only the obvious task case might miss the multi-digit-ordered
    // cases.
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

  // Sibling-cascade coverage: same producer-side fix on .cm-line also has to
  // honor --line-indent (set inline by the source-polish view-plugin on
  // .cm-fenced-code-line lines). Pre-fix bug: .cm-line { pl-4! } silently
  // overrode .cm-fenced-code-line { padding-inline-start: calc(var(--line-indent) * 1ch) }
  // so all fenced-code lines rendered flush at 1rem regardless of source-indent.
  // Post-fix: .cm-line's calc incorporates --line-indent
  // additively so source-indent is visible.
  test('fenced code: source-indent is visible (var(--line-indent) honored)', async ({
    page,
    api,
  }) => {
    const docName = `cm6-fenced-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    // Fenced JS block with four distinct leading-whitespace counts so the
    // view-plugin emits four distinct --line-indent values (0, 2, 4, 8).
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

    // A NaN firstCharLeft would silently no-op the monotonicity check below
    // (NaN <= 0.5 is false), letting the test pass without verifying anything.
    expect(
      measured.filter((m) => Number.isNaN(m.firstCharLeft)),
      'every fenced-code line must yield a measurable first character',
    ).toEqual([]);

    // Invariant: lines with HIGHER --line-indent must render their first
    // character STRICTLY further right than lines with LOWER --line-indent.
    // Pre-fix all four lines collapsed to the same x position; post-fix the
    // delta between adjacent indent levels is approximately the difference in
    // ch (≈ 8.4px per `ch` in JetBrains Mono at 14px). 0.5px tolerance absorbs
    // subpixel rounding while still failing the all-flat regression.
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

  // Table-row alignment: same producer-side bug class as the list case, but
  // the symptom differs. Pre-fix the table lines had --list-hang unset, so
  // .cm-line's !important padding (1rem) won while the standalone
  // .cm-table-row { text-indent: -2ch } leaked — net offset ≈ 0, which means
  // "firstChild >= line" alone PASSES, yet the table renders ~2ch LEFT of the
  // surrounding prose (whose net offset is the full 1rem). This test pins the
  // observable symptom directly: table first-glyph x must equal prose
  // first-glyph x. Post-fix the view-plugin sets --list-hang:2ch so the base
  // calc yields padding 1rem+2ch and text-indent -2ch → aligned with prose.
  test('table lines align with prose (not pulled left of the baseline)', async ({ page, api }) => {
    const docName = `cm6-table-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

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

    // Sanity: header + delimiter row + one data row = three decorated lines.
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
