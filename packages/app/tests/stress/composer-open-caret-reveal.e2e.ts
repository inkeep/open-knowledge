import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { CARET_REVEAL_GAP_PX } from '../../src/editor/caret-reveal';
import {
  FULL_PAGE_CM_HOST_SELECTORS,
  FULL_PAGE_CM_SCROLLPORTS,
  type FullPageCmHost,
  SCROLL_PIN_SLACK_PX,
} from '../../src/editor/document-scrollports';
import { expect, test, toggleMode } from './_helpers';

const COMPOSER_CARD = '[data-testid="bottom-composer"] > div';
const WYSIWYG_SCROLLPORT = '[data-testid="editor-scroll-container"]';
const WYSIWYG_BODY = '.editor-doc-scroll .ProseMirror:not(.composer-prosemirror)';
const WYSIWYG_LINE = `${WYSIWYG_BODY} > *`;
const SOURCE_SCROLLPORT = `${FULL_PAGE_CM_HOST_SELECTORS.sourceEditor} .cm-scroller`;
const SOURCE_LINE = `${FULL_PAGE_CM_HOST_SELECTORS.sourceEditor} .cm-content .cm-line`;
const TEXT_DOC_CONTENT = `${FULL_PAGE_CM_HOST_SELECTORS.textDocEditor} .cm-content`;
const TEXT_DOC_LINE = `${TEXT_DOC_CONTENT} .cm-line`;
const MERMAID_HOST = FULL_PAGE_CM_HOST_SELECTORS.mermaidDocEditor;
const MERMAID_CONTENT = `${MERMAID_HOST} .cm-content`;
const MERMAID_LINE = `${MERMAID_CONTENT} .cm-line`;

const LINE_COUNT = 600;
const CARET_LINE_FRACTION = 0.45;
const NEAR_END_ROOM_PX = 64;

const CASE_TIMEOUT_MS = 180_000;
const FIRST_PAINT_TIMEOUT_MS = 30_000;
const MODE_SWITCH_TIMEOUT_MS = 10_000;
const POLL_TIMEOUT_MS = 20_000;
const SETTLE_INTERVALS_MS = [150, 150, 200, 200, 300, 300, 500] as const;

const settleIntervals = (): number[] => [...SETTLE_INTERVALS_MS];
const UNPAINTED_TOLERANCE_MS = 2_500;

const markdownBody = Array.from(
  { length: LINE_COUNT },
  (_, index) => `Paragraph number ${index}.`,
).join('\n\n');

function textDocBody(): string {
  return `${Array.from(
    { length: LINE_COUNT },
    (_, index) => `export const l${index} = ${index};`,
  ).join('\n')}\n`;
}

function mermaidDocBody(): string {
  return `${['graph TD']
    .concat(Array.from({ length: LINE_COUNT }, (_, index) => `  n${index} --> n${index + 1}`))
    .join('\n')}\n`;
}

interface Surface {
  readonly label: string;
  readonly lineSelector: string;
  readonly scrollportSelector: string;
}

const CM_SURFACES: Record<FullPageCmHost, Surface> = {
  sourceEditor: {
    label: 'markdown source mode',
    lineSelector: SOURCE_LINE,
    scrollportSelector: FULL_PAGE_CM_SCROLLPORTS.sourceEditor,
  },
  textDocEditor: {
    label: 'editable text doc',
    lineSelector: TEXT_DOC_LINE,
    scrollportSelector: FULL_PAGE_CM_SCROLLPORTS.textDocEditor,
  },
  mermaidDocEditor: {
    label: 'mermaid doc source mode',
    lineSelector: MERMAID_LINE,
    scrollportSelector: FULL_PAGE_CM_SCROLLPORTS.mermaidDocEditor,
  },
};

const WYSIWYG_SURFACE: Surface = {
  label: 'markdown WYSIWYG',
  lineSelector: WYSIWYG_LINE,
  scrollportSelector: WYSIWYG_SCROLLPORT,
};

interface LineGeometry {
  readonly text: string;
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly portBottom: number;
  readonly scrollTop: number;
  readonly scrollMax: number;
}

interface CaseResult {
  readonly label: string;
  readonly scrollportSelector: string;
  readonly caretText: string;
  readonly composerHeight: number;
  readonly cardTop: number;
  readonly before: LineGeometry;
  readonly after: LineGeometry;
}

const occlusionTopOf = (result: CaseResult): number =>
  Math.min(result.cardTop, result.after.portBottom);

const occlusionClearanceOf = (result: CaseResult): number =>
  occlusionTopOf(result) - result.after.bottom;

async function readComposerHeight(page: Page): Promise<number> {
  return page.evaluate(() =>
    Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--ask-composer-height') || '0',
    ),
  );
}

async function readCardTop(page: Page): Promise<number> {
  return page.evaluate((selector) => {
    const card = document.querySelector(selector);
    if (!(card instanceof HTMLElement)) throw new Error('the Ask AI composer card is not painted');
    return card.getBoundingClientRect().top;
  }, COMPOSER_CARD);
}

async function waitForComposerPublished(page: Page): Promise<void> {
  await expect(page.locator(COMPOSER_CARD).first()).toBeVisible({ timeout: POLL_TIMEOUT_MS });
  await expect
    .poll(() => readComposerHeight(page), {
      message:
        'the composer never published --ask-composer-height, so the card reserves no band and ' +
        'every clearance assertion below would measure a layout nothing was ever painted over',
      timeout: POLL_TIMEOUT_MS,
    })
    .toBeGreaterThan(0);
}

async function forceScrollToFraction(
  page: Page,
  surface: Surface,
  fraction: number,
): Promise<void> {
  let previous = Number.NaN;
  await expect
    .poll(
      async () => {
        const scrollTop = await page.evaluate(
          ([selector, ratio]) => {
            const scrollport = document.querySelector(selector as string);
            if (!(scrollport instanceof HTMLElement)) {
              throw new Error(`no painted scrollport matched ${selector}`);
            }
            const target = Math.round(
              (scrollport.scrollHeight - scrollport.clientHeight) * (ratio as number),
            );
            if (Math.abs(scrollport.scrollTop - target) >= 1) scrollport.scrollTop = target;
            return scrollport.scrollTop;
          },
          [surface.scrollportSelector, fraction] as const,
        );
        const settled = Number.isFinite(previous) && Math.abs(previous - scrollTop) < 1;
        previous = scrollTop;
        return settled;
      },
      {
        message:
          `${surface.label}: ${surface.scrollportSelector} never came to rest mid-document, so ` +
          'the caret could not be placed away from the scroll end this case is defined to avoid',
        timeout: POLL_TIMEOUT_MS,
        intervals: settleIntervals(),
      },
    )
    .toBe(true);
}

async function findCaretCandidateLine(
  page: Page,
  surface: Surface,
  belowY: number,
): Promise<LineGeometry | null> {
  return page.evaluate(
    ([lineSelector, scrollportSelector, threshold]) => {
      const scrollport = document.querySelector(scrollportSelector as string);
      if (!(scrollport instanceof HTMLElement)) {
        throw new Error(`no painted scrollport matched ${scrollportSelector}`);
      }
      const portBox = scrollport.getBoundingClientRect();
      const painted = [...document.querySelectorAll<HTMLElement>(lineSelector as string)].filter(
        (element) => element.closest('.ok-mode-hidden') === null,
      );
      const textOf = (element: HTMLElement): string => element.textContent ?? '';
      const occurrences = new Map<string, number>();
      for (const element of painted) {
        occurrences.set(textOf(element), (occurrences.get(textOf(element)) ?? 0) + 1);
      }
      const candidate = painted
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter((entry) => entry.rect.top >= portBox.top && entry.rect.bottom <= portBox.bottom)
        .filter((entry) => textOf(entry.element).trim().length > 0)
        .filter((entry) => occurrences.get(textOf(entry.element)) === 1)
        .filter((entry) => entry.rect.bottom > (threshold as number))
        .at(-1);
      if (candidate === undefined) return null;
      return {
        text: textOf(candidate.element),
        top: candidate.rect.top,
        bottom: candidate.rect.bottom,
        left: candidate.rect.left,
        portBottom: portBox.bottom,
        scrollTop: scrollport.scrollTop,
        scrollMax: scrollport.scrollHeight - scrollport.clientHeight,
      };
    },
    [surface.lineSelector, surface.scrollportSelector, belowY] as const,
  );
}

async function waitForCaretCandidateLine(
  page: Page,
  surface: Surface,
  belowY: number,
): Promise<LineGeometry> {
  const missing =
    `${surface.label}: no uniquely identifiable painted line matching ${surface.lineSelector} ` +
    `sits below y=${belowY}, so this surface has no line for the reopened card to bury and the ` +
    'case would pass without the composer ever having occluded anything';
  let candidate: LineGeometry | null = null;
  await expect
    .poll(
      async () => {
        candidate = await findCaretCandidateLine(page, surface, belowY);
        return candidate !== null;
      },
      {
        message:
          `${missing}. CodeMirror paints only its own viewport, so a scrollport that has just ` +
          'jumped mid-document settles its scrollTop before the lines for the new region exist. ' +
          'Selecting the candidate on the first look reads that gap as a surface with nothing to ' +
          'bury, which is why this retries rather than throwing on one frame. The line is ' +
          'captured in the generator rather than re-read after it, so the geometry the caret ' +
          'click uses is the one that satisfied the poll',
        timeout: POLL_TIMEOUT_MS,
        intervals: settleIntervals(),
      },
    )
    .toBe(true);
  if (candidate === null) throw new Error(missing);
  return candidate;
}

async function findLineByText(
  page: Page,
  surface: Surface,
  text: string,
): Promise<LineGeometry | null> {
  return page.evaluate(
    ([lineSelector, scrollportSelector, wanted]) => {
      const scrollport = document.querySelector(scrollportSelector);
      if (!(scrollport instanceof HTMLElement)) {
        throw new Error(`no painted scrollport matched ${scrollportSelector}`);
      }
      const match = [...document.querySelectorAll<HTMLElement>(lineSelector)]
        .filter((element) => element.closest('.ok-mode-hidden') === null)
        .find((element) => (element.textContent ?? '') === wanted);
      if (match === undefined) return null;
      const rect = match.getBoundingClientRect();
      return {
        text: wanted,
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        portBottom: scrollport.getBoundingClientRect().bottom,
        scrollTop: scrollport.scrollTop,
        scrollMax: scrollport.scrollHeight - scrollport.clientHeight,
      };
    },
    [surface.lineSelector, surface.scrollportSelector, text] as const,
  );
}

async function readLineByText(
  page: Page,
  surface: Surface,
  text: string,
  phase: string,
): Promise<LineGeometry> {
  const found = await findLineByText(page, surface, text);
  if (found === null) {
    throw new Error(
      `${surface.label}: the caret line "${text}" is no longer painted ${phase}, so the surface ` +
        'scrolled it far enough out of view that virtualization dropped it',
    );
  }
  return found;
}

async function waitForLineSettled(
  page: Page,
  surface: Surface,
  text: string,
  phase: string,
): Promise<LineGeometry> {
  let previous: LineGeometry | undefined;
  let firstMissAt: number | null = null;
  await expect
    .poll(
      async () => {
        const current = await findLineByText(page, surface, text);
        if (current === null) {
          previous = undefined;
          firstMissAt ??= Date.now();
          if (Date.now() - firstMissAt > UNPAINTED_TOLERANCE_MS) {
            await readLineByText(page, surface, text, phase);
          }
          return false;
        }
        firstMissAt = null;
        const settled =
          previous !== undefined &&
          Math.abs(previous.bottom - current.bottom) < 0.5 &&
          Math.abs(previous.scrollTop - current.scrollTop) < 0.5;
        previous = current;
        return settled;
      },
      {
        message:
          `${surface.label}: the caret line "${text}" never stopped moving ${phase}. A transient ` +
          'frame where CodeMirror has recycled the line out of its rendered range reads as unsettled ' +
          'rather than throwing, because `expect.poll` awaits its generator OUTSIDE the try that ' +
          'decides whether to keep polling, so a throw here would end the test instead of ' +
          `retrying. Once the line has been unpainted for ${UNPAINTED_TOLERANCE_MS}ms the ` +
          'absence is no longer transient and the strict read rethrows its virtualization ' +
          'diagnostic, so a line the reveal scrolled out of the rendered range fails with that ' +
          'message rather than waiting out this timeout with this one. The budget is elapsed ' +
          'time rather than a poll count so it cannot drift when the interval tuple or the ' +
          "runner's schedule changes. The " +
          'intervals are handed out per poll because the runner consumes the array it is given, ' +
          'so a shared one would make that budget depend on how many polls ran before this one',
        timeout: POLL_TIMEOUT_MS,
        intervals: settleIntervals(),
      },
    )
    .toBe(true);
  return readLineByText(page, surface, text, phase);
}

async function forceScrollToRoomFromEnd(page: Page, surface: Surface, room: number): Promise<void> {
  let previous = Number.NaN;
  await expect
    .poll(
      async () => {
        const scrollTop = await page.evaluate(
          ([selector, gap]) => {
            const scrollport = document.querySelector(selector as string);
            if (!(scrollport instanceof HTMLElement)) {
              throw new Error(`no painted scrollport matched ${selector}`);
            }
            const target = Math.round(
              scrollport.scrollHeight - scrollport.clientHeight - (gap as number),
            );
            if (Math.abs(scrollport.scrollTop - target) >= 1) scrollport.scrollTop = target;
            return scrollport.scrollTop;
          },
          [surface.scrollportSelector, room] as const,
        );
        const settled = Number.isFinite(previous) && Math.abs(previous - scrollTop) < 1;
        previous = scrollTop;
        return settled;
      },
      {
        message:
          `${surface.label}: ${surface.scrollportSelector} never came to rest ${room}px from its ` +
          'scroll end, so the caret could not be placed in the near-end band this case covers',
        timeout: POLL_TIMEOUT_MS,
        intervals: settleIntervals(),
      },
    )
    .toBe(true);
}

async function runNearScrollEndCase(page: Page, surface: Surface): Promise<CaseResult> {
  await waitForComposerPublished(page);
  const bandTop = await readCardTop(page);
  const composerHeight = await readComposerHeight(page);

  await page.getByTestId('ask-ai-collapse').click();
  await expect(page.getByTestId('ask-ai-reopen-badge')).toBeVisible();
  await expect(page.locator(COMPOSER_CARD)).toHaveCount(0);

  await forceScrollToRoomFromEnd(page, surface, NEAR_END_ROOM_PX);
  const candidate = await waitForCaretCandidateLine(page, surface, bandTop - CARET_REVEAL_GAP_PX);
  await page.mouse.click(candidate.left + 8, (candidate.top + candidate.bottom) / 2);
  await waitForLineSettled(page, surface, candidate.text, 'after the caret click');
  await forceScrollToRoomFromEnd(page, surface, NEAR_END_ROOM_PX);
  const before = await waitForLineSettled(
    page,
    surface,
    candidate.text,
    'after the scroll was placed near the end',
  );

  await page.getByTestId('ask-ai-reopen-badge').click();
  await waitForComposerPublished(page);
  const after = await waitForLineSettled(
    page,
    surface,
    candidate.text,
    'after the composer reopened',
  );

  return {
    label: surface.label,
    scrollportSelector: surface.scrollportSelector,
    caretText: candidate.text,
    composerHeight,
    cardTop: await readCardTop(page),
    before,
    after,
  };
}

function assertCaretRevealedNearTheScrollEnd(result: CaseResult): void {
  const roomBefore = result.before.scrollMax - result.before.scrollTop;
  expect(
    roomBefore,
    `${result.label}: precondition, the caret has to sit outside the ${SCROLL_PIN_SLACK_PX}px pin ` +
      'band, or followBottom would have collected this scrollport before the reveal ran and this ' +
      'case would be the composer-growth invariant instead',
  ).toBeGreaterThan(SCROLL_PIN_SLACK_PX);
  expect(
    roomBefore,
    `${result.label}: precondition, the scrollport has to sit within one composer height of its ` +
      'end, or this would not exercise the near-end behavior',
  ).toBeLessThan(result.composerHeight);
  expect(
    result.before.bottom,
    `${result.label}: precondition, the caret line has to sit inside the clearance the reveal ` +
      'promises, or nothing needed revealing and the assertion below would pass vacuously',
  ).toBeGreaterThan(occlusionTopOf(result) - CARET_REVEAL_GAP_PX);
  expect(
    result.before.bottom - result.after.bottom,
    `${describeCase(result)}\n  near the scroll end the caret line already paints a few pixels ` +
      'above the occlusion line, so a positive clearance alone would hold with no reveal at all. ' +
      'The reveal has to have moved the line',
  ).toBeGreaterThan(0);
  expect(occlusionClearanceOf(result), describeCase(result)).toBeGreaterThan(0);
}

async function runComposerOpenCase(page: Page, surface: Surface): Promise<CaseResult> {
  await waitForComposerPublished(page);
  const bandTop = await readCardTop(page);

  await page.getByTestId('ask-ai-collapse').click();
  await expect(page.getByTestId('ask-ai-reopen-badge')).toBeVisible();
  await expect(page.locator(COMPOSER_CARD)).toHaveCount(0);

  await forceScrollToFraction(page, surface, CARET_LINE_FRACTION);
  const candidate = await waitForCaretCandidateLine(page, surface, bandTop);
  await page.mouse.click(candidate.left + 8, (candidate.top + candidate.bottom) / 2);
  const before = await waitForLineSettled(page, surface, candidate.text, 'after the caret click');

  await page.getByTestId('ask-ai-reopen-badge').click();
  await waitForComposerPublished(page);
  const after = await waitForLineSettled(
    page,
    surface,
    candidate.text,
    'after the composer reopened',
  );

  return {
    label: surface.label,
    scrollportSelector: surface.scrollportSelector,
    caretText: candidate.text,
    composerHeight: await readComposerHeight(page),
    cardTop: await readCardTop(page),
    before,
    after,
  };
}

function describeCase(result: CaseResult): string {
  return [
    `[${result.label}] opening the Ask AI composer must scroll the caret line clear of the card`,
    `  scrollport          ${result.scrollportSelector}`,
    `  caret line          "${result.caretText}"`,
    `  composer height     ${result.composerHeight}`,
    `  card top            ${result.cardTop.toFixed(1)}`,
    `  scrollport bottom   ${result.before.portBottom.toFixed(1)} -> ${result.after.portBottom.toFixed(1)}`,
    `  occlusion top       ${occlusionTopOf(result).toFixed(1)} (the higher of the card top and the scrollport bottom)`,
    `  line bottom         ${result.before.bottom.toFixed(1)} -> ${result.after.bottom.toFixed(1)} (moved ${(result.after.bottom - result.before.bottom).toFixed(1)})`,
    `  scroll              ${result.before.scrollTop.toFixed(1)} -> ${result.after.scrollTop.toFixed(1)} (of max ${result.after.scrollMax.toFixed(1)})`,
    `  occlusion clearance ${occlusionClearanceOf(result).toFixed(1)} (positive = the caret line paints above BOTH)`,
  ].join('\n');
}

function assertCaretRevealed(result: CaseResult): void {
  expect(
    result.before.scrollMax - result.before.scrollTop,
    `${result.label}: precondition, ${result.scrollportSelector} must sit well away from its ` +
      'scroll end, or followBottom would re-pin it and this case would be about the ' +
      'composer-growth invariant instead of the composer-open reveal',
  ).toBeGreaterThan(SCROLL_PIN_SLACK_PX);
  expect(
    result.before.bottom,
    `${result.label}: precondition, with the composer collapsed the caret line has to sit below ` +
      'the line the reopened card occludes, or nothing needed revealing and the assertion below ' +
      'would pass vacuously. Measured against the occlusion line rather than the card top so a ' +
      'host whose scrollport is clipped ABOVE the card can express its clip-only case',
  ).toBeGreaterThan(occlusionTopOf(result) - CARET_REVEAL_GAP_PX);
  expect(occlusionClearanceOf(result), describeCase(result)).toBeGreaterThan(0);
  expect(
    result.after.scrollMax - result.after.scrollTop,
    `${result.label}: precondition, the reveal has to leave ${result.scrollportSelector} outside ` +
      'the pin band. Inside it the write clamps at the scroll end, followBottom then finds the ' +
      'scrollport pinned and carries it to the growing end, and the caret rises far past the ' +
      'reveal gap — so the upper bound below would red naming the reveal for a scroll ' +
      'followBottom made',
  ).toBeGreaterThan(SCROLL_PIN_SLACK_PX);
  expect(
    occlusionClearanceOf(result),
    `${describeCase(result)}\n  the reveal must lift the caret line just clear of the occlusion ` +
      'line, not jump the document: a clearance far above the reveal gap means the scroll ' +
      'overshot and took the reader somewhere they did not ask to go',
  ).toBeLessThanOrEqual(CARET_REVEAL_GAP_PX + (result.after.bottom - result.after.top));
}

test.describe('opening the Ask AI composer reveals the caret it would otherwise bury', () => {
  test.setTimeout(CASE_TIMEOUT_MS);

  test('markdown in WYSIWYG mode reveals the caret the reopened card covers', async ({
    page,
    api,
  }) => {
    const docName = `composer-open-caret-wysiwyg-${randomUUID().slice(0, 8)}`;
    await api.seedDocs([{ name: `${docName}.md`, markdown: markdownBody }]);

    await page.goto(`/#/${docName}`);
    await expect(page.locator(WYSIWYG_BODY).first()).toBeVisible({
      timeout: FIRST_PAINT_TIMEOUT_MS,
    });

    assertCaretRevealed(await runComposerOpenCase(page, WYSIWYG_SURFACE));
  });

  test('markdown in source mode reveals the caret the reopened card covers', async ({
    page,
    api,
  }) => {
    const docName = `composer-open-caret-source-${randomUUID().slice(0, 8)}`;
    await api.seedDocs([{ name: `${docName}.md`, markdown: markdownBody }]);

    await page.goto(`/#/${docName}`);
    await expect(page.locator(WYSIWYG_BODY).first()).toBeVisible({
      timeout: FIRST_PAINT_TIMEOUT_MS,
    });
    await toggleMode(page, 'source');
    await expect(
      page.locator(SOURCE_SCROLLPORT).first(),
      'the markdown doc never entered source mode after toggleMode, so the CodeMirror lines this ' +
        'case measures would be absent and the caret would be placed in the WYSIWYG body instead',
    ).toBeVisible({ timeout: MODE_SWITCH_TIMEOUT_MS });

    assertCaretRevealed(await runComposerOpenCase(page, CM_SURFACES.sourceEditor));
  });

  test('an editable text doc reveals the caret the reopened card covers', async ({
    page,
    workerServer,
  }) => {
    const docName = `composer-open-caret-text-${randomUUID().slice(0, 8)}.ts`;
    writeFileSync(join(workerServer.contentDir, docName), textDocBody(), 'utf-8');

    await page.goto(`/#/${docName}`);
    await expect(page.locator(TEXT_DOC_CONTENT).first()).toBeVisible({
      timeout: FIRST_PAINT_TIMEOUT_MS,
    });

    assertCaretRevealed(await runComposerOpenCase(page, CM_SURFACES.textDocEditor));
  });

  test('a caret near the scroll end still clears the reopened card', async ({
    page,
    workerServer,
  }) => {
    const docName = `composer-open-caret-near-end-${randomUUID().slice(0, 8)}.ts`;
    writeFileSync(join(workerServer.contentDir, docName), textDocBody(), 'utf-8');

    await page.goto(`/#/${docName}`);
    await expect(page.locator(TEXT_DOC_CONTENT).first()).toBeVisible({
      timeout: FIRST_PAINT_TIMEOUT_MS,
    });

    assertCaretRevealedNearTheScrollEnd(
      await runNearScrollEndCase(page, CM_SURFACES.textDocEditor),
    );
  });

  test('a mermaid doc in source mode reveals the caret the reopened card covers', async ({
    page,
    workerServer,
  }) => {
    const docName = `composer-open-caret-mermaid-${randomUUID().slice(0, 8)}.mmd`;
    writeFileSync(join(workerServer.contentDir, docName), mermaidDocBody(), 'utf-8');

    await page.goto(`/#/${docName}`);
    await expect(page.locator(MERMAID_HOST).first()).toBeVisible({
      timeout: FIRST_PAINT_TIMEOUT_MS,
    });
    await toggleMode(page, 'source');
    await expect(
      page.locator(MERMAID_CONTENT).first(),
      'the mermaid doc never mounted its source-mode CodeMirror content after toggleMode, so the ' +
        'scrollport this case measures would be absent',
    ).toBeVisible({ timeout: MODE_SWITCH_TIMEOUT_MS });

    assertCaretRevealed(await runComposerOpenCase(page, CM_SURFACES.mermaidDocEditor));
  });
});
