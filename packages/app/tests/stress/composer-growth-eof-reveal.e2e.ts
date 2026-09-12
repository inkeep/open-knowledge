import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test, toggleMode } from './_helpers';

const COMPOSER_CARD = '[data-testid="bottom-composer"] > div';
const COMPOSER_INPUT = '.composer-prosemirror';
const OUTER_SCROLLPORT = '[data-testid="editor-scroll-container"]';
const WYSIWYG_BODY = '.editor-doc-scroll .ProseMirror:not(.composer-prosemirror)';
const WYSIWYG_LINE = `${WYSIWYG_BODY} > *`;
const SOURCE_SCROLLPORT = '.source-editor .cm-scroller';
const SOURCE_LINE = '.source-editor .cm-content .cm-line';
const TEXT_DOC_CONTENT = '[data-text-doc-editor] .cm-content';
const TEXT_DOC_SCROLLPORT = '[data-text-doc-editor] .cm-scroller';
const TEXT_DOC_LINE = `${TEXT_DOC_CONTENT} .cm-line`;
const MERMAID_CONTENT = '[data-mermaid-doc-editor] .cm-content';
const MERMAID_SCROLLPORT = '[data-mermaid-doc-editor] .cm-scroller';
const MERMAID_LINE = `${MERMAID_CONTENT} .cm-line`;

const LINE_COUNT = 300;

const CASE_TIMEOUT_MS = 180_000;
const FIRST_PAINT_TIMEOUT_MS = 30_000;
const MODE_SWITCH_TIMEOUT_MS = 10_000;
const POLL_TIMEOUT_MS = 20_000;

const GROW_PROMPT =
  'Please refactor the trailing helpers in this file and explain the reasoning in detail so that ' +
  'the composer input wraps onto several visual lines and the floating card grows noticeably taller ' +
  'than the single-line resting height it started at before this prompt was typed into it.';

const markdownBody = Array.from({ length: LINE_COUNT }, (_, index) => `Paragraph number ${index}.`)
  .concat('Final paragraph, the one the caret sits on.')
  .join('\n\n');

function textDocBody(): string {
  return `${Array.from({ length: LINE_COUNT }, (_, index) => `export const l${index} = ${index};`)
    .concat('export const lastLineSentinel = true;')
    .join('\n')}\n`;
}

function mermaidDocBody(): string {
  return `${['graph TD']
    .concat(Array.from({ length: LINE_COUNT }, (_, index) => `  n${index} --> n${index + 1}`))
    .concat('  nLast[the last line the caret sits on]')
    .join('\n')}\n`;
}

interface Surface {
  readonly label: string;
  readonly lineSelector: string;
  readonly scrollportSelector: string;
}

interface Geometry {
  readonly cardTop: number;
  readonly lineBottom: number;
  readonly composerHeight: number;
  readonly scrollTop: number;
  readonly scrollMax: number;
}

const clearanceOf = (geometry: Geometry): number => geometry.cardTop - geometry.lineBottom;

function describeTransition(surface: Surface, before: Geometry, after: Geometry): string {
  return [
    `[${surface.label}] the last line of the document must keep painting above the Ask AI card`,
    `  scrollport      ${surface.scrollportSelector}`,
    `  composer height ${before.composerHeight} -> ${after.composerHeight}`,
    `  card top        ${before.cardTop.toFixed(1)} -> ${after.cardTop.toFixed(1)} (moved ${(after.cardTop - before.cardTop).toFixed(1)})`,
    `  line bottom     ${before.lineBottom.toFixed(1)} -> ${after.lineBottom.toFixed(1)} (moved ${(after.lineBottom - before.lineBottom).toFixed(1)})`,
    `  scroll          ${before.scrollTop.toFixed(1)}/${before.scrollMax.toFixed(1)} -> ${after.scrollTop.toFixed(1)}/${after.scrollMax.toFixed(1)}`,
    `  clearance       ${clearanceOf(before).toFixed(1)} -> ${clearanceOf(after).toFixed(1)}`,
    `  compensation    ${(after.lineBottom - before.lineBottom - (after.cardTop - before.cardTop)).toFixed(1)} (0 = the scrollport tracked the growing card)`,
  ].join('\n');
}

async function readComposerHeight(page: Page): Promise<number> {
  return page.evaluate(() =>
    Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--ask-composer-height') || '0',
    ),
  );
}

async function readLineBottom(page: Page, lineSelector: string): Promise<number> {
  return page.evaluate((selector) => {
    const painted = [...document.querySelectorAll<HTMLElement>(selector)].filter(
      (element) => element.closest('.ok-mode-hidden') === null,
    );
    const last = painted.at(-1);
    if (!last) throw new Error(`no painted line matched ${selector}`);
    return last.getBoundingClientRect().bottom;
  }, lineSelector);
}

async function readGeometry(page: Page, surface: Surface): Promise<Geometry> {
  return page.evaluate(
    ([cardSelector, lineSelector, scrollportSelector]) => {
      const card = document.querySelector(cardSelector);
      if (!(card instanceof HTMLElement))
        throw new Error('the Ask AI composer card is not painted');
      const scrollport = document.querySelector(scrollportSelector);
      if (!(scrollport instanceof HTMLElement)) {
        throw new Error(`no painted scrollport matched ${scrollportSelector}`);
      }
      const painted = [...document.querySelectorAll<HTMLElement>(lineSelector)].filter(
        (element) => element.closest('.ok-mode-hidden') === null,
      );
      const last = painted.at(-1);
      if (!last) throw new Error(`no painted line matched ${lineSelector}`);
      return {
        cardTop: card.getBoundingClientRect().top,
        lineBottom: last.getBoundingClientRect().bottom,
        composerHeight: Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--ask-composer-height') ||
            '0',
        ),
        scrollTop: scrollport.scrollTop,
        scrollMax: scrollport.scrollHeight - scrollport.clientHeight,
      };
    },
    [COMPOSER_CARD, surface.lineSelector, surface.scrollportSelector] as const,
  );
}

async function waitForComposerPublished(page: Page): Promise<void> {
  await expect
    .poll(() => readComposerHeight(page), {
      message:
        'the composer never published --ask-composer-height, so every geometry assertion below ' +
        'would compare an unreserved layout against itself and pass vacuously',
      timeout: POLL_TIMEOUT_MS,
    })
    .toBeGreaterThan(0);
}

async function waitForGeometrySettled(page: Page, surface: Surface): Promise<Geometry> {
  let previous: Geometry | undefined;
  await expect
    .poll(
      async () => {
        const current = await readGeometry(page, surface);
        const stable =
          previous !== undefined &&
          Math.abs(previous.cardTop - current.cardTop) < 0.5 &&
          Math.abs(previous.lineBottom - current.lineBottom) < 0.5 &&
          Math.abs(previous.scrollTop - current.scrollTop) < 0.5;
        previous = current;
        return stable;
      },
      {
        message: `${surface.label}: the card, the last line and the scrollport never stopped moving`,
        timeout: POLL_TIMEOUT_MS,
        intervals: [150, 150, 200, 200, 300, 300, 500],
      },
    )
    .toBe(true);
  return readGeometry(page, surface);
}

async function pinScrollportToBottom(page: Page, surface: Surface): Promise<void> {
  let previousMax = Number.NaN;
  await expect
    .poll(
      async () => {
        const { scrollTop, scrollMax } = await page.evaluate((selector) => {
          const scrollport = document.querySelector(selector);
          if (!(scrollport instanceof HTMLElement)) {
            throw new Error(`no painted scrollport matched ${selector}`);
          }
          scrollport.scrollTop = scrollport.scrollHeight;
          return {
            scrollTop: scrollport.scrollTop,
            scrollMax: scrollport.scrollHeight - scrollport.clientHeight,
          };
        }, surface.scrollportSelector);
        const pinned = scrollMax > 0 && scrollMax - scrollTop < 1 && scrollMax === previousMax;
        previousMax = scrollMax;
        return pinned;
      },
      {
        message:
          `${surface.label}: ${surface.scrollportSelector} never came to rest at its own scroll ` +
          'end, so the document was never scrolled to the line this test is about',
        timeout: POLL_TIMEOUT_MS,
        intervals: [150, 150, 200, 200, 300, 300, 500],
      },
    )
    .toBe(true);
}

async function placeCaretOnLastLine(page: Page, surface: Surface): Promise<void> {
  await page
    .locator(surface.lineSelector)
    .filter({ hasNot: page.locator('.ok-mode-hidden') })
    .last()
    .click({ position: { x: 4, y: 4 } });
}

async function settleAtEndOfDocument(page: Page, surface: Surface): Promise<Geometry> {
  await pinScrollportToBottom(page, surface);
  await placeCaretOnLastLine(page, surface);
  await pinScrollportToBottom(page, surface);
  return waitForGeometrySettled(page, surface);
}

async function growComposer(page: Page, surface: Surface, before: Geometry): Promise<void> {
  const minimumGrowth = clearanceOf(before);
  await page.locator(COMPOSER_INPUT).first().click();
  await page.keyboard.type(GROW_PROMPT, { delay: 1 });
  await expect
    .poll(() => readComposerHeight(page), {
      message:
        `${surface.label}: typing a multi-line prompt never grew the composer card past the ` +
        `${minimumGrowth.toFixed(1)}px the last line already cleared it by, so an uncompensated ` +
        'scrollport would still clear the card and the assertion below would pass vacuously',
      timeout: POLL_TIMEOUT_MS,
    })
    .toBeGreaterThan(before.composerHeight + minimumGrowth);
}

function assertLastLineStaysAboveCard(surface: Surface, before: Geometry, after: Geometry): void {
  expect(
    before.scrollMax - before.scrollTop,
    `${surface.label}: precondition, ${surface.scrollportSelector} must be pinned at its end`,
  ).toBeLessThan(2);
  expect(
    clearanceOf(before),
    `${surface.label}: precondition, the last line must clear the card before the composer changes`,
  ).toBeGreaterThan(0);
  expect(
    after.composerHeight - before.composerHeight,
    `${surface.label}: precondition, the card has to grow by more than the ` +
      `${clearanceOf(before).toFixed(1)}px it already cleared the last line by, or a scrollport ` +
      'that compensated for nothing would still clear the card and the assertion below would ' +
      'pass vacuously',
  ).toBeGreaterThan(clearanceOf(before));
  expect(clearanceOf(after), describeTransition(surface, before, after)).toBeGreaterThan(0);
}

test.describe('the Ask AI composer keeps the end-of-document line visible as it grows', () => {
  test.setTimeout(CASE_TIMEOUT_MS);

  test('markdown in WYSIWYG mode keeps its last block above the growing card', async ({
    page,
    api,
  }) => {
    const docName = `composer-eof-wysiwyg-${randomUUID().slice(0, 8)}`;
    await api.seedDocs([{ name: `${docName}.md`, markdown: markdownBody }]);
    const surface: Surface = {
      label: 'markdown WYSIWYG',
      lineSelector: WYSIWYG_LINE,
      scrollportSelector: OUTER_SCROLLPORT,
    };

    await page.goto(`/#/${docName}`);
    await expect(page.locator(WYSIWYG_BODY).first()).toBeVisible({
      timeout: FIRST_PAINT_TIMEOUT_MS,
    });
    await waitForComposerPublished(page);

    const before = await settleAtEndOfDocument(page, surface);
    await growComposer(page, surface, before);
    const after = await waitForGeometrySettled(page, surface);

    assertLastLineStaysAboveCard(surface, before, after);
  });

  test('markdown in source mode keeps its last line above the growing card', async ({
    page,
    api,
  }) => {
    const docName = `composer-eof-source-${randomUUID().slice(0, 8)}`;
    await api.seedDocs([{ name: `${docName}.md`, markdown: markdownBody }]);
    const surface: Surface = {
      label: 'markdown source mode',
      lineSelector: SOURCE_LINE,
      scrollportSelector: OUTER_SCROLLPORT,
    };

    await page.goto(`/#/${docName}`);
    await expect(page.locator(WYSIWYG_BODY).first()).toBeVisible({
      timeout: FIRST_PAINT_TIMEOUT_MS,
    });
    await toggleMode(page, 'source');
    await expect(
      page.locator(SOURCE_SCROLLPORT).first(),
      'the markdown doc never entered source mode after toggleMode, so the CodeMirror lines this ' +
        'case measures would be absent and settleAtEndOfDocument would throw',
    ).toBeVisible({ timeout: MODE_SWITCH_TIMEOUT_MS });
    await waitForComposerPublished(page);

    const before = await settleAtEndOfDocument(page, surface);
    await growComposer(page, surface, before);
    const after = await waitForGeometrySettled(page, surface);

    assertLastLineStaysAboveCard(surface, before, after);
  });

  test('an editable text doc keeps its last line above the growing card', async ({
    page,
    workerServer,
  }) => {
    const docName = `composer-eof-text-${randomUUID().slice(0, 8)}.ts`;
    writeFileSync(join(workerServer.contentDir, docName), textDocBody(), 'utf-8');
    const surface: Surface = {
      label: 'editable text doc',
      lineSelector: TEXT_DOC_LINE,
      scrollportSelector: TEXT_DOC_SCROLLPORT,
    };

    await page.goto(`/#/${docName}`);
    await expect(page.locator(TEXT_DOC_CONTENT).first()).toBeVisible({
      timeout: FIRST_PAINT_TIMEOUT_MS,
    });
    await waitForComposerPublished(page);

    const before = await settleAtEndOfDocument(page, surface);
    await growComposer(page, surface, before);
    const after = await waitForGeometrySettled(page, surface);

    assertLastLineStaysAboveCard(surface, before, after);
  });

  test('a mermaid doc in source mode keeps its last line above the growing card', async ({
    page,
    workerServer,
  }) => {
    const docName = `composer-eof-mermaid-${randomUUID().slice(0, 8)}.mmd`;
    writeFileSync(join(workerServer.contentDir, docName), mermaidDocBody(), 'utf-8');
    const surface: Surface = {
      label: 'mermaid doc source mode',
      lineSelector: MERMAID_LINE,
      scrollportSelector: MERMAID_SCROLLPORT,
    };

    await page.goto(`/#/${docName}`);
    await expect(page.locator('[data-mermaid-doc-editor]').first()).toBeVisible({
      timeout: FIRST_PAINT_TIMEOUT_MS,
    });
    await toggleMode(page, 'source');
    await expect(
      page.locator(MERMAID_CONTENT).first(),
      'the mermaid doc never mounted its source-mode CodeMirror content after toggleMode, so ' +
        'the scrollport this case pins would be absent and settleAtEndOfDocument would throw',
    ).toBeVisible({ timeout: MODE_SWITCH_TIMEOUT_MS });
    await waitForComposerPublished(page);

    const before = await settleAtEndOfDocument(page, surface);
    await growComposer(page, surface, before);
    const after = await waitForGeometrySettled(page, surface);

    assertLastLineStaysAboveCard(surface, before, after);
  });

  test('an editable text doc keeps its last line above the card when the composer reopens', async ({
    page,
    workerServer,
  }) => {
    const docName = `composer-eof-reopen-${randomUUID().slice(0, 8)}.ts`;
    writeFileSync(join(workerServer.contentDir, docName), textDocBody(), 'utf-8');
    const surface: Surface = {
      label: 'editable text doc, composer reopened',
      lineSelector: TEXT_DOC_LINE,
      scrollportSelector: TEXT_DOC_SCROLLPORT,
    };

    await page.goto(`/#/${docName}`);
    await expect(page.locator(TEXT_DOC_CONTENT).first()).toBeVisible({
      timeout: FIRST_PAINT_TIMEOUT_MS,
    });
    await waitForComposerPublished(page);

    await page.getByTestId('ask-ai-collapse').click();
    await expect(page.getByTestId('ask-ai-reopen-badge')).toBeVisible();
    await pinScrollportToBottom(page, surface);
    await placeCaretOnLastLine(page, surface);
    await pinScrollportToBottom(page, surface);

    const dismissedLineBottom = await readLineBottom(page, surface.lineSelector);

    await page.getByTestId('ask-ai-reopen-badge').click();
    await waitForComposerPublished(page);
    const after = await waitForGeometrySettled(page, surface);

    expect(
      dismissedLineBottom,
      `${surface.label}: precondition, with the composer collapsed the last line has to sit below ` +
        'where the reopened card lands, or it would clear the card without the reveal having done ' +
        'anything',
    ).toBeGreaterThan(after.cardTop);
    expect(
      clearanceOf(after),
      [
        `[${surface.label}] reopening the composer over a document pinned at its end must not bury the last line`,
        `  scrollport      ${surface.scrollportSelector}`,
        `  composer height ${after.composerHeight}`,
        `  card top        ${after.cardTop.toFixed(1)}`,
        `  line bottom     ${dismissedLineBottom.toFixed(1)} -> ${after.lineBottom.toFixed(1)}`,
        `  scroll          ${after.scrollTop.toFixed(1)}/${after.scrollMax.toFixed(1)}`,
        `  clearance       ${clearanceOf(after).toFixed(1)}`,
      ].join('\n'),
    ).toBeGreaterThan(0);
  });
});
