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

const CLICK_TARGET_ORDINAL = 9;

const SWEEP_FRACTIONS = [0, 0.2, 0.4, 0.6, 0.8, 1] as const;

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

const nextFrame = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );

interface OutlineSample {
  activeLabel: string | null;
  ariaCurrentCount: number;
  markerPresent: boolean;
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

function expectTracksScroll(
  samples: Array<{ f: number; sample: OutlineSample }>,
  mode: 'WYSIWYG' | 'source',
) {
  const table = `\n${mode} sweep:\n${formatSweep(samples)}\n`;

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
