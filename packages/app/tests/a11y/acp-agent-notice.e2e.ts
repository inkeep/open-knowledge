/**
 * Real-engine accessibility coverage for the ACP agent-warning card.
 *
 * jsdom can already prove the card's role, label, glyph and class list, and
 * the DOM tier does. What it cannot prove is anything the cascade decides:
 * it has no forced-colors substitution, no wrapping, and returns zero for
 * every box measurement, so a card that vanished into the background under
 * high contrast, spilled off a narrow viewport, or clipped its text at 400%
 * zoom would still pass there. Those failure classes need a browser.
 *
 * The transcript reaches the screen through the development-only injection
 * seam on `window`, so the client, the fold, the renderer and the browser are
 * all the production path — only the bytes are synthesized, and they are the
 * producer's own, read from the committed fixture the unit and server tiers
 * share.
 */

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

/** The long single-paragraph warning — the one that has to wrap when space is short. */
const LONG_WARNING = candidate('warning-skills-budget');
/** The multi-paragraph config warning — the one whose details must not be clipped. */
const DETAILED_WARNING = candidate('config-warning-with-details');
const ORDINARY_ANSWER = FIXTURE.ordinaryAnswer.update;

const NOTICE = '[data-testid="agent-thread-agent-notice"]';
const ANNOUNCER = '[data-testid="agent-thread-warning-announcer"]';
const THREAD_ROOT = '[data-agent-thread-root]';

/**
 * Record every announcement the polite region receives, in write order.
 *
 * Reading the region's settled text cannot distinguish two announcements that
 * queued from two that overwrote each other — both leave the same final
 * string. The writer clears before each write, so the added text nodes are the
 * sequence, and that is also the closest available stand-in for how a screen
 * reader watches a live region.
 *
 * Installed after load rather than through `addInitScript`, which would run
 * against a document that has no element to observe yet.
 */
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

/**
 * Resolve once the real thread socket has delivered its authoritative roster.
 *
 * The client asks the server to list its threads the moment the socket opens,
 * and the answer replaces the whole thread map — anything the server does not
 * name is dropped, which is exactly how the harness withdraws its own threads.
 * Injecting before that answer lands therefore races it, and loses. Observing
 * the frame on the wire is what makes the wait deterministic; there is no
 * rendered difference between "roster not yet received" and "roster received
 * and empty".
 *
 * Must be called before navigation, since the socket opens during load.
 */
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

/** Load the app shell and wait until synthetic threads can survive on it. */
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

/**
 * Put a transcript on screen and return the thread plus its warning-card locator.
 *
 * `live` subscribes an empty thread, lets it paint, and only then streams the
 * updates in — the order a real turn arrives in, and the order the announcer's
 * replay latch is defined against. `replay` hydrates the whole transcript out
 * of the retained log in one batch, the way reopening an existing thread does.
 * The cards the two produce must be identical.
 */
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

/** Stream further updates into an already-mounted thread, as a live turn does. */
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

/** Computed box + paint facts, read in one round trip so they describe one layout. */
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

/**
 * Type + box facts for the card's label and its body, which are what "legible
 * and untruncated" comes down to once the layout is magnified.
 */
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

// ── Forced colors ───────────────────────────────────────────────────────────

test('warning boundary survives forced-colors substitution', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await openApp(page);
  const { card } = await mountThread(page, [LONG_WARNING]);
  await expect(card).toBeVisible({ timeout: 15_000 });

  const metrics = await readCardMetrics(card);
  // Guard the oracle first: if the emulation never reached the page, every
  // assertion below would pass against ordinary rendering and prove nothing.
  expect(metrics.forcedColors).toBe(true);

  expect(metrics.borderTopStyle).not.toBe('none');
  expect(metrics.borderTopWidth).toBeGreaterThan(0);
  expect(metrics.borderTopColor).not.toBe('transparent');
  expect(metrics.borderTopColor).not.toBe('rgba(0, 0, 0, 0)');
  // The system palette replaces the amber fill outright, so the box is only a
  // box if its edge still contrasts with what it encloses.
  expect(metrics.borderTopColor).not.toBe(metrics.backgroundColor);

  // Severity must survive in words as well, since neither the tint nor the
  // glyph carries it here.
  await expect(card).toContainText('Warning');
  await expect(card).toContainText('skills context budget');
});

// ── 320 px reflow ───────────────────────────────────────────────────────────

/**
 * A window narrow enough that the thread panel itself lands under 320 CSS px.
 *
 * The panel group apportions the agents panel out of the layout it first
 * measured, and a window that opens at 320 leaves it nothing, so these two
 * blocks open at a workable width and narrow the window afterwards — which is
 * also the shape of the real gesture, since a reader shrinks or zooms a window
 * that already has a thread in it.
 */
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
    // The card has to be measured at the width the requirement is about; a
    // panel that had collapsed instead would report a sliver and fail the
    // clipping checks below rather than passing them vacuously.
    expect(metrics.width).toBeGreaterThan(0);
    expect(metrics.width).toBeLessThanOrEqual(320);
    // Sub-pixel layout rounds either way, so allow a pixel before calling it overflow.
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
    // Reflow means one direction of scrolling, so the warning must not push the
    // page itself sideways either.
    expect(overflow.documentScrollWidth).toBeLessThanOrEqual(overflow.documentClientWidth + 1);

    // Every detail line of the config warning is still rendered, not truncated
    // away to fit.
    await expect(card).toContainText('model_reasoning_effort');
    await expect(card).toContainText('sandbox_mode');
  });
});

// ── 400% zoom ───────────────────────────────────────────────────────────────

test.describe('400% browser zoom', () => {
  // Browser zoom scales a CSS pixel and shrinks the layout viewport by the same
  // factor, so 400% on a 1280x1024 display is a 320x256 layout viewport painted
  // at four device pixels per CSS pixel. Both halves matter: the ratio is what
  // magnifies the type, the viewport is what forces the reflow.
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
    // Guard the oracle: without the magnification this is just another narrow
    // viewport, and every legibility assertion below would be about nothing.
    expect(zoomed.devicePixelRatio).toBe(4);

    // Nothing shrank the type to make the content fit.
    expect(zoomed.label.fontSize).toBeGreaterThanOrEqual(unzoomed.fontSize);
    expect(zoomed.body.fontSize).toBeGreaterThanOrEqual(unzoomed.fontSize);
    // Nor hid the overflow: no ellipsis, no line clamp, no cropped box.
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

// ── axe ─────────────────────────────────────────────────────────────────────

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

// ── Focus stability ─────────────────────────────────────────────────────────

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

  // The card's own chrome is inert — a label, a glyph and a box, no control —
  // so a warning body of plain prose adds no tab stop and the order a keyboard
  // user walks is the order they walked before it appeared. The body itself
  // renders through the same markdown path as any agent message, so a producer
  // that put a link or a fenced block in a warning would contribute whatever
  // that text contributes anywhere else in the transcript.
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

// ── Announcement order and replay silence ───────────────────────────────────

test('two live warnings announce in source order', async ({ page }) => {
  await openApp(page);
  await recordAnnouncements(page);
  await mountThread(page, [LONG_WARNING, ORDINARY_ANSWER, DETAILED_WARNING]);
  await expect(page.locator(NOTICE)).toHaveCount(2, { timeout: 15_000 });

  await expect.poll(() => readAnnouncements(page), { timeout: 15_000 }).toHaveLength(2);
  const announcements = await readAnnouncements(page);
  expect(announcements[0]).toContain('Warning: Skill descriptions were shortened');
  expect(announcements[1]).toContain('Config warning: Ignored 2 invalid entries');
  // The details paragraph belongs on the card, not in the reader's ear.
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

  // A silent region proves nothing on its own — a broken announcer is silent
  // too. Sending one warning live into the same thread forces the positive
  // case: exactly one announcement, and it is the live arrival rather than
  // history catching up.
  await pushUpdates(page, threadId, [LONG_WARNING]);
  await expect(page.locator(NOTICE)).toHaveCount(3, { timeout: 15_000 });
  await expect.poll(() => readAnnouncements(page), { timeout: 15_000 }).toHaveLength(1);
  expect((await readAnnouncements(page))[0]).toContain(
    'Warning: Skill descriptions were shortened',
  );
});

/** Enough of the focused element to tell "unchanged" from "moved elsewhere". */
function activeElementDescriptor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (el === null) return 'none';
    return `${el.tagName}#${el.id}[${el.getAttribute('data-testid') ?? ''}]`;
  });
}
