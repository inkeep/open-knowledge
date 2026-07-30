/**
 * The outline pane's ACTIVE-heading indication — position marker, row
 * highlight, and `aria-current="location"` — must track the reader's scroll
 * position in BOTH editor modes. All three affordances render off one value, so
 * they are asserted together at every sample.
 *
 * STOP: do not "fix" source-mode tracking by reading heading rects out of the
 * DOM. In source mode every heading slug still resolves via
 * `document.getElementById` — to the HIDDEN WYSIWYG pane, which stays mounted
 * under `content-visibility: hidden` (painting is skipped but descendant layout
 * is preserved, so its rects are real, non-zero, and move as you scroll) and is
 * `position: absolute` (so it contributes nothing to the shared scrollport's
 * scrollHeight). Measuring it while the source pane scrolls yields confidently
 * WRONG tracking, not working tracking: the hidden pane is taller than the
 * scrollable range, so the last headings can never activate and mid-document
 * picks skew by the pane-height ratio. That is exactly why the two source-mode
 * assertions below are pinned to an EXACT expected heading at the bottom of the
 * document and at a clicked mid-document target, rather than to "something
 * became active".
 *
 * Both modes run through the same `expectTracksScroll` contract. The WYSIWYG
 * case is a protective pin (it passes today; nothing else in the suite asserts
 * the outline's active state), the source case is the target behavior.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  type ApiHelpers,
  expect,
  primeFullLayout,
  test,
  waitForActiveProviderSynced,
} from './_helpers';

const sourceToggle = (page: Page) => page.getByRole('radio', { name: 'Markdown source' });

const SCROLLPORT = '[data-testid="editor-scroll-container"]';

const HEADING_COUNT = 12;
const label = (ordinal: number) => `Heading ${String(ordinal).padStart(2, '0')}`;
const FIRST_LABEL = label(1);
const LAST_LABEL = label(HEADING_COUNT);

/**
 * Mid-document target for the click oracle. Deep enough that the hidden-pane
 * skew lands several headings short of it, shallow enough to stay clear of the
 * document's last section.
 */
const CLICK_TARGET_ORDINAL = 9;

const SWEEP_FRACTIONS = [0, 0.2, 0.4, 0.6, 0.8, 1] as const;

/**
 * Uniform section heights are load-bearing, not incidental. The hidden WYSIWYG
 * pane renders this document taller than the source pane, so with equal
 * sections a hidden-pane read tops out several headings short of the end. A
 * deliberately tall FINAL section would let that wrong read reach the last
 * heading anyway and silently drain the bottom-of-document assertion of its
 * discriminating power.
 */
const FILLER = 'Filler paragraph to force scrollable content. '.repeat(12);

const DOC = [
  '---',
  'title: Outline Active Heading',
  '---',
  '',
  ...Array.from({ length: HEADING_COUNT }, (_, i) => {
    const level = i === 0 ? '#' : i % 3 === 0 ? '##' : '###';
    return [`${level} ${label(i + 1)}`, '', FILLER, FILLER, FILLER, ''];
  }).flat(),
].join('\n');

const headingLineText = (ordinal: number) => {
  const i = ordinal - 1;
  const level = i === 0 ? '#' : i % 3 === 0 ? '##' : '###';
  return `${level} ${label(ordinal)}`;
};

/** Await two animation frames: one for the hook's rAF-coalesced recompute, one for React's commit. */
const nextFrame = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );

interface OutlineSample {
  /** Text of the row carrying `aria-current="location"`, or null when none does. */
  activeLabel: string | null;
  /** Must be exactly 1 — a set of navigation items has one current item. */
  ariaCurrentCount: number;
  /** The position marker, rendered only when an active row was resolved. */
  markerPresent: boolean;
  /** Rendered colour of the active row and of a non-active row: the visual highlight. */
  activeColor: string | null;
  inactiveColor: string | null;
  rowCount: number;
  scrollTop: number;
}

async function readOutline(page: Page): Promise<OutlineSample> {
  return page.evaluate((scrollport) => {
    const panel = document.querySelector('#panel-outline');
    const rows = [...(panel?.querySelectorAll('nav button') ?? [])];
    const current = rows.filter((r) => r.getAttribute('aria-current') === 'location');
    const active = current[0];
    const inactive = rows.find((r) => r !== active);
    const scroller = document.querySelector(scrollport);
    return {
      activeLabel: active?.textContent?.trim() ?? null,
      ariaCurrentCount: current.length,
      markerPresent: Boolean(panel?.querySelector('nav > div[aria-hidden="true"]')),
      activeColor: active ? getComputedStyle(active).color : null,
      inactiveColor: inactive ? getComputedStyle(inactive).color : null,
      rowCount: rows.length,
      scrollTop: scroller instanceof HTMLElement ? Math.round(scroller.scrollTop) : -1,
    };
  }, SCROLLPORT);
}

/**
 * Read the outline until two consecutive frames agree on both the active row
 * and the scroll offset. CodeMirror swaps estimated line heights for measured
 * ones as content enters the viewport and re-anchors `scrollTop` when it does,
 * so a single read can catch the pane mid-adjustment.
 */
async function readSettledOutline(page: Page): Promise<OutlineSample> {
  let last = await readOutline(page);
  await expect
    .poll(
      async () => {
        await nextFrame(page);
        const next = await readOutline(page);
        const stable = next.activeLabel === last.activeLabel && next.scrollTop === last.scrollTop;
        last = next;
        return stable;
      },
      { timeout: 10_000, intervals: [50, 100, 200] },
    )
    .toBe(true);
  return last;
}

/**
 * Park the scrollport at a fraction of its range, re-applying until the offset
 * stops moving — the same CodeMirror height re-measurement that `scrollTop` is
 * re-anchored by also changes `scrollHeight` underneath the target.
 */
async function scrollToFraction(page: Page, fraction: number): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ([scrollport, frac]) => {
            const s = document.querySelector(scrollport as string);
            if (!(s instanceof HTMLElement)) return false;
            const target = (s.scrollHeight - s.clientHeight) * (frac as number);
            if (Math.abs(s.scrollTop - target) <= 2) return true;
            s.scrollTop = target;
            return false;
          },
          [SCROLLPORT, fraction] as const,
        ),
      { timeout: 10_000, intervals: [100, 150, 250] },
    )
    .toBe(true);
}

async function sweepOutline(page: Page): Promise<Array<{ f: number; sample: OutlineSample }>> {
  const samples: Array<{ f: number; sample: OutlineSample }> = [];
  for (const f of SWEEP_FRACTIONS) {
    await scrollToFraction(page, f);
    samples.push({ f, sample: await readSettledOutline(page) });
  }
  return samples;
}

const formatSweep = (samples: Array<{ f: number; sample: OutlineSample }>) =>
  samples
    .map(
      ({ f, sample }) =>
        `  f=${f.toFixed(1)} scrollTop=${sample.scrollTop} active=${JSON.stringify(
          sample.activeLabel,
        )} ariaCurrent=${sample.ariaCurrentCount} marker=${sample.markerPresent} rows=${
          sample.rowCount
        }`,
    )
    .join('\n');

const ordinalOf = (activeLabel: string | null) => {
  const match = /(\d+)$/.exec(activeLabel ?? '');
  return match ? Number(match[1]) : Number.NaN;
};

/**
 * The mode-independent contract. Both editor modes owe the reader the same
 * behaviour, so both run these assertions verbatim.
 */
function expectTracksScroll(
  samples: Array<{ f: number; sample: OutlineSample }>,
  mode: 'WYSIWYG' | 'source',
) {
  const table = `\n${mode} sweep:\n${formatSweep(samples)}\n`;

  // The sweep must actually have moved the reader through the document,
  // otherwise everything below is vacuous.
  expect(
    samples.at(-1)?.sample.scrollTop,
    `${mode}: the scrollport did not scroll — the assertions below would be vacuous.${table}`,
  ).toBeGreaterThan(1000);

  for (const { f, sample } of samples) {
    const at = `${mode} at f=${f.toFixed(1)}`;
    expect(sample.rowCount, `${at}: outline row count.${table}`).toBe(HEADING_COUNT);
    expect(
      sample.ariaCurrentCount,
      `${at}: exactly one row must carry aria-current="location".${table}`,
    ).toBe(1);
    expect(sample.markerPresent, `${at}: the position marker must render.${table}`).toBe(true);
    expect(
      sample.activeColor,
      `${at}: the active row must have a rendered colour.${table}`,
    ).not.toBeNull();
    expect(
      sample.activeColor,
      `${at}: the active row must be visually distinguished from a non-active row.${table}`,
    ).not.toBe(sample.inactiveColor);
  }

  // Bottom of the document is THE discriminating position: a hidden-pane read
  // tops out short of the end and can never reach the last heading.
  expect(
    samples.at(-1)?.sample.activeLabel,
    `${mode}: at maximum scroll the LAST heading must be active.${table}`,
  ).toBe(LAST_LABEL);

  expect(
    samples[0]?.sample.activeLabel,
    `${mode}: at the top of the document the first heading must be active.${table}`,
  ).toBe(FIRST_LABEL);

  const ordinals = samples.map(({ sample }) => ordinalOf(sample.activeLabel));
  expect(
    ordinals,
    `${mode}: the active heading must not move backwards while scrolling down.${table}`,
  ).toEqual([...ordinals].sort((a, b) => a - b));

  // Kills an implementation that reports a constant (or near-constant) heading
  // while still satisfying the two endpoint assertions by accident.
  expect(
    new Set(ordinals).size,
    `${mode}: the active heading must advance through the document, not sit on one row.${table}`,
  ).toBeGreaterThanOrEqual(4);
}

async function seed(api: ApiHelpers, page: Page, baseURL: string): Promise<string> {
  const docName = `outline-active-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await page.addInitScript(() => {
    try {
      localStorage.setItem('ok-acp-follow-file-v1', '0');
    } catch {}
  });
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  await api.replaceDoc(docName, DOC);
  await expect
    .poll(
      async () => {
        const r = await fetch(`${baseURL}/api/page-headings?docName=${docName}`);
        if (!r.ok) return 0;
        const d = (await r.json()) as { headings?: unknown[] };
        return d.headings?.length ?? 0;
      },
      { timeout: 15_000, intervals: [200, 500, 1000] },
    )
    .toBe(HEADING_COUNT);
  await page.waitForFunction(
    (n) =>
      document.querySelectorAll('.ProseMirror h1, .ProseMirror h2, .ProseMirror h3').length === n,
    HEADING_COUNT,
    { timeout: 15_000 },
  );
  await primeFullLayout(page);
  await expect(page.locator('#panel-outline')).toBeVisible();
  return docName;
}

/** Switch to CodeMirror and re-prime: the source pane has its own layout. */
async function enterSourceMode(page: Page): Promise<void> {
  await sourceToggle(page).click();
  await page.waitForSelector('.cm-content');
  await page.waitForFunction(() => document.querySelectorAll('.cm-line').length > 5, null, {
    timeout: 15_000,
  });
  await primeFullLayout(page);
}

test.describe('outline active-heading tracking', () => {
  test('tracks scroll position in source mode', async ({ page, api, baseURL }) => {
    test.setTimeout(180_000);
    await seed(api, page, baseURL ?? '');
    await enterSourceMode(page);

    expectTracksScroll(await sweepOutline(page), 'source');
  });

  test('activates the clicked heading in source mode', async ({ page, api, baseURL }) => {
    test.setTimeout(180_000);
    await seed(api, page, baseURL ?? '');
    await enterSourceMode(page);

    const target = label(CLICK_TARGET_ORDINAL);
    await page.locator('#panel-outline nav button', { hasText: target }).click();

    // Outline navigation scrolls the heading's source line to the top of the
    // viewport, which is the independent oracle for this assertion: wait for
    // the line to actually be parked there before sampling.
    const lineText = headingLineText(CLICK_TARGET_ORDINAL);
    await expect
      .poll(
        () =>
          page.evaluate(
            ([scrollport, text]) => {
              const scroller = document.querySelector(scrollport as string);
              const line = [...document.querySelectorAll('.cm-line')].find(
                (l) => l.textContent?.trim() === text,
              );
              if (!(scroller instanceof HTMLElement) || !line) return -1;
              return Math.round(
                line.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
              );
            },
            [SCROLLPORT, lineText] as const,
          ),
        { timeout: 15_000, intervals: [150, 250, 400] },
      )
      .toBeLessThan(200);

    const sample = await readSettledOutline(page);
    expect(
      sample.activeLabel,
      `source: after clicking "${target}" its own source line is parked at the top of the ` +
        `viewport, so it must be the active heading. Got ${JSON.stringify(sample.activeLabel)} ` +
        `at scrollTop=${sample.scrollTop}.`,
    ).toBe(target);
    expect(sample.ariaCurrentCount, 'source: exactly one row must be current.').toBe(1);
    expect(sample.markerPresent, 'source: the position marker must render.').toBe(true);
  });

  test('tracks scroll position in WYSIWYG mode', async ({ page, api, baseURL }) => {
    test.setTimeout(180_000);
    await seed(api, page, baseURL ?? '');

    expectTracksScroll(await sweepOutline(page), 'WYSIWYG');
  });
});
