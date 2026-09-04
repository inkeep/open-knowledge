import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../stress/_helpers';

interface EnvelopeFixture {
  agents: Record<string, { source: string; id: string; name: string }>;
  candidates: { name: string; update: Record<string, unknown> }[];
  neighbors: Record<string, { update: Record<string, unknown> }>;
  ordinaryAnswer: { update: Record<string, unknown> };
}

const FIXTURE: EnvelopeFixture = JSON.parse(
  readFileSync(
    join(
      fileURLToPath(import.meta.url),
      '..',
      '..',
      '..',
      '..',
      '..',
      'test-support',
      'fixtures',
      'codex-legacy-warning-envelopes.json',
    ),
    'utf-8',
  ),
);

const CODEX = FIXTURE.agents.codexRegistry;

function candidate(name: string): Record<string, unknown> {
  const found = FIXTURE.candidates.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`fixture candidate "${name}" is missing`);
  return found.update;
}

const LONG_WARNING = candidate('warning-skills-budget');
const DETAILED_WARNING = candidate('config-warning-with-details');
const ORDINARY_ANSWER = FIXTURE.ordinaryAnswer.update;

const NOTICE = '[data-testid="agent-thread-agent-notice"]';
const ANNOUNCER = '[data-testid="agent-thread-warning-announcer"]';
const THREAD_ROOT = '[data-agent-thread-root]';

async function recordAnnouncements(page: Page): Promise<void> {
  await page.evaluate((announcerSelector) => {
    const log: string[] = [];
    Object.assign(globalThis, { acpAnnouncementLog: log });
    new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target as HTMLElement;
        const region = target.closest?.(announcerSelector) ?? null;
        if (region === null) continue;
        for (const node of Array.from(record.addedNodes)) {
          const text = node.textContent ?? '';
          if (text !== '') log.push(text);
        }
      }
    }).observe(document.documentElement, { subtree: true, childList: true });
  }, ANNOUNCER);
}

function readAnnouncements(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (globalThis as unknown as { acpAnnouncementLog?: string[] }).acpAnnouncementLog ?? [],
  );
}

function threadRosterDelivered(page: Page): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('thread socket never delivered its roster')),
      30_000,
    );
    page.on('websocket', (socket) => {
      if (!socket.url().includes('/collab/thread')) return;
      socket.on('framereceived', (frame) => {
        if (typeof frame.payload !== 'string') return;
        if (!frame.payload.includes('"op":"threads"')) return;
        clearTimeout(timer);
        resolve();
      });
    });
  });
}

async function openApp(page: Page): Promise<void> {
  const roster = threadRosterDelivered(page);
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__acpThreadHarness), null, { timeout: 30_000 });
  await roster;
}

type Delivery = 'live' | 'replay';

interface MountedThread {
  threadId: string;
  card: Locator;
}

async function mountThread(
  page: Page,
  updates: readonly Record<string, unknown>[],
  delivery: Delivery = 'live',
): Promise<MountedThread> {
  const threadId = await page.evaluate(
    ({ agent, payload, mode }) => {
      const harness = window.__acpThreadHarness;
      if (harness === undefined) throw new Error('ACP thread harness is not installed');
      const options = { agent, title: 'Accessibility thread' } as Parameters<
        typeof harness.openThread
      >[0];
      const sessionUpdates = payload as Parameters<typeof harness.pushUpdates>[1];
      return mode === 'replay'
        ? harness.replayThread(options, sessionUpdates)
        : harness.openThread(options);
    },
    { agent: CODEX, payload: updates, mode: delivery },
  );

  await expect(page.locator(THREAD_ROOT).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(ANNOUNCER).first()).toBeAttached({ timeout: 15_000 });
  if (delivery === 'live') await pushUpdates(page, threadId, updates);

  return { threadId, card: page.locator(NOTICE).first() };
}

async function pushUpdates(
  page: Page,
  threadId: string,
  updates: readonly Record<string, unknown>[],
): Promise<void> {
  await page.evaluate(
    ({ id, payload }) => {
      const harness = window.__acpThreadHarness;
      if (harness === undefined) throw new Error('ACP thread harness is not installed');
      harness.pushUpdates(id, payload as Parameters<typeof harness.pushUpdates>[1]);
    },
    { id: threadId, payload: updates },
  );
}

function readCardMetrics(card: Locator) {
  return card.evaluate((el) => {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      borderTopColor: style.borderTopColor,
      borderTopStyle: style.borderTopStyle,
      borderTopWidth: Number.parseFloat(style.borderTopWidth),
      backgroundColor: style.backgroundColor,
      color: style.color,
      fontSize: Number.parseFloat(style.fontSize),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      width: rect.width,
      height: rect.height,
      right: rect.right,
      forcedColors: window.matchMedia('(forced-colors: active)').matches,
    };
  });
}

function readTypography(card: Locator) {
  return card.evaluate((el) => {
    const measure = (part: HTMLElement | null) => {
      if (part === null) throw new Error('warning card is missing a text part');
      const style = window.getComputedStyle(part);
      return {
        fontSize: Number.parseFloat(style.fontSize),
        textOverflow: style.textOverflow,
        webkitLineClamp: style.webkitLineClamp,
        scrollWidth: part.scrollWidth,
        clientWidth: part.clientWidth,
        scrollHeight: part.scrollHeight,
        clientHeight: part.clientHeight,
      };
    };
    return {
      devicePixelRatio: window.devicePixelRatio,
      label: measure(el.querySelector('p')),
      body: measure(el.lastElementChild as HTMLElement | null),
    };
  });
}

test('warning boundary survives forced-colors substitution', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await openApp(page);
  const { card } = await mountThread(page, [LONG_WARNING]);
  await expect(card).toBeVisible({ timeout: 15_000 });

  const metrics = await readCardMetrics(card);
  expect(metrics.forcedColors).toBe(true);

  expect(metrics.borderTopStyle).not.toBe('none');
  expect(metrics.borderTopWidth).toBeGreaterThan(0);
  expect(metrics.borderTopColor).not.toBe('transparent');
  expect(metrics.borderTopColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(metrics.borderTopColor).not.toBe(metrics.backgroundColor);

  await expect(card).toContainText('Warning');
  await expect(card).toContainText('skills context budget');
});

const NARROWABLE = { width: 500, height: 800 } as const;

test.describe('narrow window', () => {
  test.use({ viewport: NARROWABLE });

  test('warning card reflows at a 320 px viewport without clipping or side-scroll', async ({
    page,
  }) => {
    await openApp(page);
    const { card } = await mountThread(page, [DETAILED_WARNING]);
    await expect(card).toBeVisible({ timeout: 15_000 });

    await page.setViewportSize({ width: 320, height: 640 });
    await page.waitForFunction(() => document.documentElement.clientWidth === 320, null, {
      timeout: 10_000,
    });

    const metrics = await readCardMetrics(card);
    expect(metrics.width).toBeGreaterThan(0);
    expect(metrics.width).toBeLessThanOrEqual(320);
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
    expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight + 1);
    expect(metrics.right).toBeLessThanOrEqual(320);

    const overflow = await page.evaluate(() => {
      const transcript = document.querySelector(
        '[data-testid="agent-thread-transcript"]',
      ) as HTMLElement;
      return {
        transcriptScrollWidth: transcript.scrollWidth,
        transcriptClientWidth: transcript.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        documentClientWidth: document.documentElement.clientWidth,
      };
    });
    expect(overflow.transcriptScrollWidth).toBeLessThanOrEqual(overflow.transcriptClientWidth + 1);
    expect(overflow.documentScrollWidth).toBeLessThanOrEqual(overflow.documentClientWidth + 1);

    await expect(card).toContainText('model_reasoning_effort');
    await expect(card).toContainText('sandbox_mode');
  });
});

test.describe('400% browser zoom', () => {
  test.use({ viewport: NARROWABLE, deviceScaleFactor: 4 });

  test('warning text stays legible and untruncated at 400% zoom', async ({ page }) => {
    await openApp(page);
    const { card } = await mountThread(page, [DETAILED_WARNING]);
    await expect(card).toBeVisible({ timeout: 15_000 });
    const unzoomed = await readCardMetrics(card);

    await page.setViewportSize({ width: 320, height: 256 });
    await page.waitForFunction(() => document.documentElement.clientWidth === 320, null, {
      timeout: 10_000,
    });

    const zoomed = await readTypography(card);
    expect(zoomed.devicePixelRatio).toBe(4);

    expect(zoomed.label.fontSize).toBeGreaterThanOrEqual(unzoomed.fontSize);
    expect(zoomed.body.fontSize).toBeGreaterThanOrEqual(unzoomed.fontSize);
    for (const part of [zoomed.label, zoomed.body]) {
      expect(part.textOverflow).not.toBe('ellipsis');
      expect(part.webkitLineClamp).toBe('none');
      expect(part.scrollHeight).toBeLessThanOrEqual(part.clientHeight + 1);
      expect(part.scrollWidth).toBeLessThanOrEqual(part.clientWidth + 1);
    }

    await expect(card).toContainText('Warning');
    await expect(card).toContainText('Ignored 2 invalid entries');
    await expect(card).toContainText('model_reasoning_effort');
    await expect(card).toContainText('sandbox_mode');
  });
});

test('a transcript carrying a warning card has no serious or critical violations', async ({
  page,
}) => {
  await openApp(page);
  await mountThread(page, [LONG_WARNING, ORDINARY_ANSWER, DETAILED_WARNING]);
  await expect(page.locator(NOTICE)).toHaveCount(2, { timeout: 15_000 });

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .include(THREAD_ROOT)
    .analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(blocking.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
});

test('an arriving warning moves no focus and adds no tab stop', async ({ page }) => {
  await openApp(page);
  const { threadId } = await mountThread(page, [ORDINARY_ANSWER]);

  const composer = page.locator('[data-testid="agent-thread-composer"]').first();
  await composer.focus();
  await expect(composer).toBeFocused();
  const focusBefore = await activeElementDescriptor(page);

  await pushUpdates(page, threadId, [LONG_WARNING]);
  await expect(page.locator(NOTICE)).toHaveCount(1, { timeout: 15_000 });

  await expect(composer).toBeFocused();
  expect(await activeElementDescriptor(page)).toBe(focusBefore);

  const stops = await page
    .locator(NOTICE)
    .first()
    .evaluate(
      (el) =>
        el.querySelectorAll(
          'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]',
        ).length,
    );
  expect(stops).toBe(0);
});

test('two live warnings announce in source order', async ({ page }) => {
  await openApp(page);
  await recordAnnouncements(page);
  await mountThread(page, [LONG_WARNING, ORDINARY_ANSWER, DETAILED_WARNING]);
  await expect(page.locator(NOTICE)).toHaveCount(2, { timeout: 15_000 });

  await expect.poll(() => readAnnouncements(page), { timeout: 15_000 }).toHaveLength(2);
  const announcements = await readAnnouncements(page);
  expect(announcements[0]).toContain('Warning: Skill descriptions were shortened');
  expect(announcements[1]).toContain('Config warning: Ignored 2 invalid entries');
  expect(announcements[1]).not.toContain('model_reasoning_effort');
});

test('a replayed transcript renders its warnings without announcing them', async ({ page }) => {
  await openApp(page);
  await recordAnnouncements(page);
  const { threadId } = await mountThread(
    page,
    [LONG_WARNING, ORDINARY_ANSWER, DETAILED_WARNING],
    'replay',
  );
  await expect(page.locator(NOTICE)).toHaveCount(2, { timeout: 15_000 });

  const region = page.locator(ANNOUNCER).first();
  await expect(region).toHaveAttribute('aria-live', 'polite');
  await expect(region).toBeEmpty();

  await pushUpdates(page, threadId, [LONG_WARNING]);
  await expect(page.locator(NOTICE)).toHaveCount(3, { timeout: 15_000 });
  await expect.poll(() => readAnnouncements(page), { timeout: 15_000 }).toHaveLength(1);
  expect((await readAnnouncements(page))[0]).toContain(
    'Warning: Skill descriptions were shortened',
  );
});

function activeElementDescriptor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (el === null) return 'none';
    return `${el.tagName}#${el.id}[${el.getAttribute('data-testid') ?? ''}]`;
  });
}
