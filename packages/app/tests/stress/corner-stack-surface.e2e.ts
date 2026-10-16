import type { Locator, Page } from '@playwright/test';
import {
  type ApiHelpers,
  BORDER_SIDES,
  type BorderSideName,
  type CardSurface,
  CHAT_PANE_CARD,
  CORNER_STACK_TEST_ID,
  contrastRatioOf,
  countDifferingPixels,
  EDITOR_PANE_CARD,
  expect,
  expectDocumentOpen,
  expectEditorHidden,
  feedbackCard,
  innerClipsOf,
  NEWSLETTER_USED_UP,
  newsletterCard,
  noticeWithText,
  openDesktopLayout,
  openWebLayout,
  type RgbaBytes,
  readBorderColors,
  readCardSurface,
  readContrastPair,
  readRootColor,
  type ScreenClip,
  seedFeedbackEligibleDocs,
  seedFeedbackNudgeStateBeforeLoad,
  seedNewsletterStateBeforeLoad,
  setHeaderPane,
  settleFrames,
  sidebarTrigger,
  terminalPaneCard,
  test,
  type WorkerServer,
} from './_helpers';
import { emitUpdateEvent, installUpdateEventOverlay } from './fixtures/update-event-overlay';

const VERSION = '9.9.9';
const DOWNLOAD_URL = 'https://openknowledge.ai/download';
const RELEASE_URL = 'https://openknowledge.ai/changelog';
const WIDE = { width: 1440, height: 900 } as const;
const PHONE = { width: 393, height: 852 } as const;
const THEME_KEY = 'ok-theme-v1';
const FEEDBACK_LATCH_TIMEOUT_MS = 15_000;
const THEMES = ['light', 'dark'] as const;
const EDGE_CHANNEL_TOLERANCE = 3;
const MIN_TEXT_CONTRAST = 4.5;
const OPAQUE = 255;

type Theme = (typeof THEMES)[number];
type Host = 'web' | 'desktop';
type EdgeTone = 'shared' | 'warning' | 'success';

interface EdgeColor {
  readonly token: string;
  readonly alpha?: number;
}

const EDGE_COLORS: Readonly<Record<EdgeTone, EdgeColor>> = {
  shared: { token: '--border' },
  warning: { token: '--warning', alpha: 0.4 },
  success: { token: '--success', alpha: 0.4 },
};

interface SurfaceVerdict {
  readonly opaqueBackground: boolean;
  readonly drawnBorderSides: readonly BorderSideName[];
  readonly radiusIsCardRadius: boolean;
  readonly shadowMatchesPaneCard: boolean;
}

const SHARED_SURFACE: SurfaceVerdict = {
  opaqueBackground: true,
  drawnBorderSides: BORDER_SIDES,
  radiusIsCardRadius: true,
  shadowMatchesPaneCard: true,
};

interface CardKind {
  readonly name: string;
  readonly emit?: (page: Page) => Promise<void>;
  readonly card: (page: Page) => Locator;
  readonly texts: readonly string[];
  readonly edge: EdgeTone;
  readonly minTextContrast?: number;
}

interface ContrastRecord {
  readonly card: string;
  readonly text: string;
  readonly ratio: number;
  readonly foreground: readonly number[];
  readonly background: readonly number[];
}

interface SurfaceReading {
  readonly contrast: readonly ContrastRecord[];
  readonly edge: RgbaBytes;
}

const FEEDBACK: CardKind = {
  name: 'feedback card',
  card: feedbackCard,
  texts: ["Tell us how it's going"],
  edge: 'shared',
};

const SUCCESS_NOTICE: CardKind = {
  name: 'success notice (updated to version)',
  emit: (page) =>
    emitUpdateEvent(page, 'onWhatsNew', { version: VERSION, releaseUrl: RELEASE_URL }),
  card: (page) => noticeWithText(page, `Updated to Version ${VERSION}`),
  texts: [`Updated to Version ${VERSION}`],
  edge: 'success',
  minTextContrast: MIN_TEXT_CONTRAST,
};

const DEFAULT_NOTICE: CardKind = {
  name: 'default notice (ready to install)',
  emit: (page) => emitUpdateEvent(page, 'onUpdateDownloaded', { version: VERSION }),
  card: (page) => noticeWithText(page, `Version ${VERSION} ready to install`),
  texts: [`Version ${VERSION} ready to install`],
  edge: 'shared',
  minTextContrast: MIN_TEXT_CONTRAST,
};

const ERROR_NOTICE: CardKind = {
  name: 'error notice (install failed)',
  emit: (page) =>
    emitUpdateEvent(page, 'onUpdateRelaunchFailed', {
      version: VERSION,
      downloadUrl: DOWNLOAD_URL,
    }),
  card: (page) => noticeWithText(page, `Update to ${VERSION} didn't install.`),
  texts: [`Update to ${VERSION} didn't install.`],
  edge: 'warning',
  minTextContrast: MIN_TEXT_CONTRAST,
};

const DESKTOP_NOTICES: readonly CardKind[] = [SUCCESS_NOTICE, DEFAULT_NOTICE, ERROR_NOTICE];

const NEWSLETTER: CardKind = {
  name: 'newsletter card',
  emit: (page) =>
    emitUpdateEvent(page, 'onWhatsNew', { version: VERSION, releaseUrl: RELEASE_URL }),
  card: newsletterCard,
  texts: ['Product updates in your inbox.', `Updated to Version ${VERSION}`],
  edge: 'shared',
};

function drawnBorderSidesOf(surface: CardSurface): BorderSideName[] {
  return BORDER_SIDES.filter((side) => {
    const border = surface.borders[side];
    return border.style === 'solid' && border.widthPx >= 1 && border.colorAlpha > 0;
  });
}

function channelDistance(actual: RgbaBytes, expected: RgbaBytes): number {
  return Math.max(
    Math.abs(actual[0] - expected[0]),
    Math.abs(actual[1] - expected[1]),
    Math.abs(actual[2] - expected[2]),
    Math.abs(actual[3] - expected[3]),
  );
}

async function expectedEdgeOf(page: Page, tone: EdgeTone): Promise<RgbaBytes> {
  const { token, alpha } = EDGE_COLORS[tone];
  const [red, green, blue, tokenAlpha] = await readRootColor(page, token);
  return [red, green, blue, alpha === undefined ? tokenAlpha : Math.round(alpha * OPAQUE)];
}

const CARD_RADIUS = '10px';

function verdictOf(surface: CardSurface, paneCard: CardSurface): SurfaceVerdict {
  return {
    opaqueBackground: surface.backgroundAlpha === 1,
    drawnBorderSides: drawnBorderSidesOf(surface),
    radiusIsCardRadius: surface.borderRadius === CARD_RADIUS,
    shadowMatchesPaneCard: surface.boxShadow === paneCard.boxShadow,
  };
}

async function seedThemeBeforeLoad(page: Page, theme: Theme): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), {
    key: THEME_KEY,
    value: theme,
  });
}

async function expectThemeOnHost(page: Page, theme: Theme, host: Host): Promise<void> {
  expect(
    await page.evaluate(() => ({
      dark: document.documentElement.classList.contains('dark'),
      electronMode: document.documentElement.classList.contains('electron-mode'),
    })),
  ).toEqual({ dark: theme === 'dark', electronMode: host === 'desktop' });
}

async function seedFeedbackDocs(api: ApiHelpers, slug: string): Promise<string> {
  const docName = await seedFeedbackEligibleDocs(
    api,
    `corner-surface-${slug}-w${test.info().workerIndex}`,
  );
  return docName;
}

async function openOn(
  page: Page,
  workerServer: WorkerServer,
  host: Host,
  theme: Theme,
  docName: string,
): Promise<void> {
  await seedThemeBeforeLoad(page, theme);
  if (host === 'web') {
    await openWebLayout(page, docName, WIDE);
  } else {
    await installUpdateEventOverlay(page);
    await openDesktopLayout(page, workerServer, docName, {
      viewport: WIDE,
      terminalPlacement: 'bottom',
    });
  }
  await expectDocumentOpen(page, docName);
  await expectThemeOnHost(page, theme, host);
}

async function expectSharedSurface(page: Page, kind: CardKind): Promise<SurfaceReading> {
  await kind.emit?.(page);
  const card = kind.card(page);
  await expect(card).toBeVisible({ timeout: FEEDBACK_LATCH_TIMEOUT_MS });
  const paneCard = page.locator(EDITOR_PANE_CARD);
  await expect(paneCard).toBeVisible();

  const [surface, reference] = await Promise.all([
    readCardSurface(card),
    readCardSurface(paneCard),
  ]);
  expect(
    verdictOf(surface, reference),
    `${kind.name}: ${JSON.stringify({ surface, paneCard: reference })}`,
  ).toEqual(SHARED_SURFACE);

  const [edges, expectedEdge] = await Promise.all([
    readBorderColors(card),
    expectedEdgeOf(page, kind.edge),
  ]);
  expect(
    BORDER_SIDES.filter(
      (side) => channelDistance(edges[side], expectedEdge) <= EDGE_CHANNEL_TOLERANCE,
    ),
    `${kind.name}: border ${JSON.stringify(edges)} against ${EDGE_COLORS[kind.edge].token} ${JSON.stringify(expectedEdge)}`,
  ).toEqual(BORDER_SIDES);

  await page.emulateMedia({ forcedColors: 'active' });
  const forced = await readCardSurface(card);
  expect(
    drawnBorderSidesOf(forced),
    `${kind.name} with forced colors: ${JSON.stringify(forced)}`,
  ).toEqual(BORDER_SIDES);
  await page.emulateMedia({ forcedColors: 'none' });

  const contrast: ContrastRecord[] = [];
  for (const text of kind.texts) {
    const pair = await readContrastPair(card.getByText(text, { exact: true }), card);
    const ratio = contrastRatioOf(pair);
    contrast.push({
      card: kind.name,
      text,
      ratio: Math.round(ratio * 100) / 100,
      foreground: pair.foreground,
      background: pair.background.map(Math.round),
    });
    if (kind.minTextContrast !== undefined) {
      expect(ratio, `${kind.name}: "${text}" against its surface`).toBeGreaterThanOrEqual(
        kind.minTextContrast,
      );
    }
  }
  return { contrast, edge: edges.top };
}

async function attachContrast(label: string, records: readonly ContrastRecord[]): Promise<void> {
  await test.info().attach(`contrast ratios, ${label}`, {
    body: JSON.stringify(records, null, 2),
    contentType: 'application/json',
  });
}

async function attachScreenshot(page: Page, label: string): Promise<void> {
  await test.info().attach(label, { body: await page.screenshot(), contentType: 'image/png' });
}

async function settleForCapture(
  page: Page,
  viewport: { readonly width: number; readonly height: number },
): Promise<void> {
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  await expect
    .poll(() =>
      page.evaluate(() =>
        document
          .getAnimations()
          .filter(
            (animation): animation is CSSTransition =>
              animation instanceof CSSTransition && animation.playState === 'running',
          )
          .map((transition) => transition.transitionProperty),
      ),
    )
    .toEqual([]);
  await settleFrames(page);
}

interface ClipCapture {
  readonly clip: ScreenClip;
  readonly card: Buffer;
  readonly backdrop: Buffer;
}

async function captureCardAndBackdrop(page: Page, card: Locator): Promise<ClipCapture[]> {
  const stack = page.getByTestId(CORNER_STACK_TEST_ID);
  const captures: ClipCapture[] = [];
  for (const clip of await innerClipsOf(card)) {
    const cardShot = await page.screenshot({ clip });
    await stack.evaluate((el) => {
      el.style.visibility = 'hidden';
    });
    const backdropShot = await page.screenshot({ clip });
    await stack.evaluate((el) => {
      el.style.removeProperty('visibility');
    });
    captures.push({ clip, card: cardShot, backdrop: backdropShot });
  }
  return captures;
}

interface BackdropLayout {
  readonly name: string;
  readonly compared: boolean;
  readonly arrange: (page: Page) => Promise<void>;
}

const BACKDROP_LAYOUTS: readonly BackdropLayout[] = [
  {
    name: 'editor shown with the file sidebar open, over its bottom row',
    compared: false,
    arrange: async (page) => {
      await expect(sidebarTrigger(page)).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('nav#app-file-sidebar')).toBeVisible();
    },
  },
  {
    name: 'editor shown with the file sidebar collapsed, over a document',
    compared: true,
    arrange: async (page) => {
      await sidebarTrigger(page).click();
      await expect(sidebarTrigger(page)).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator(EDITOR_PANE_CARD)).toBeVisible();
    },
  },
  {
    name: 'editor hidden with the terminal at the bottom',
    compared: true,
    arrange: async (page) => {
      await setHeaderPane(page, 'terminal', true);
      await setHeaderPane(page, 'editor', false);
      await expectEditorHidden(page);
      await expect(page.locator(terminalPaneCard('bottom'))).toBeVisible();
    },
  },
  {
    name: 'editor hidden with chat alone',
    compared: true,
    arrange: async (page) => {
      await setHeaderPane(page, 'terminal', false);
      await setHeaderPane(page, 'agents', true);
      await expect(page.locator(CHAT_PANE_CARD)).toBeVisible();
      await expect(page.locator(terminalPaneCard('bottom'))).toBeHidden();
    },
  },
  {
    name: 'Nothing open',
    compared: false,
    arrange: async (page) => {
      await setHeaderPane(page, 'agents', false);
      await expect(page.getByRole('region', { name: 'Nothing open', exact: true })).toBeVisible();
    },
  },
];

interface BackdropCapture {
  readonly layout: string;
  readonly clips: readonly ClipCapture[];
}

for (const theme of THEMES) {
  test.describe(`floating card surface, ${theme} theme`, () => {
    test('fake desktop: the feedback card and the success, default and error notices share the floating card surface, each notice edge in its tone', async ({
      page,
      api,
      workerServer,
    }) => {
      const docName = await seedFeedbackDocs(api, `kinds-${theme}`);
      await seedFeedbackNudgeStateBeforeLoad(page);
      await seedNewsletterStateBeforeLoad(page, NEWSLETTER_USED_UP);
      await openOn(page, workerServer, 'desktop', theme, docName);

      const records: ContrastRecord[] = [];
      const edges = new Map<CardKind, RgbaBytes>();
      for (const kind of [FEEDBACK, ...DESKTOP_NOTICES]) {
        await test.step(kind.name, async () => {
          const reading = await expectSharedSurface(page, kind);
          records.push(...reading.contrast);
          edges.set(kind, reading.edge);
        });
      }
      await attachContrast(`fake desktop, ${theme}`, records);

      const edgeOf = (kind: CardKind): RgbaBytes => {
        const edge = edges.get(kind);
        if (edge === undefined) throw new Error(`expected a border reading for the ${kind.name}`);
        return edge;
      };
      expect(edgeOf(ERROR_NOTICE), 'error notice edge against the default notice edge').not.toEqual(
        edgeOf(DEFAULT_NOTICE),
      );
      expect(
        edgeOf(SUCCESS_NOTICE),
        'success notice edge against the default notice edge',
      ).not.toEqual(edgeOf(DEFAULT_NOTICE));
    });

    test('fake desktop: the newsletter card shares the floating card surface', async ({
      page,
      api,
      workerServer,
    }) => {
      const docName = `corner-surface-newsletter-${theme}-w${test.info().workerIndex}`;
      await api.seedDocs([
        { name: docName, markdown: `# ${docName}\n\nUnder the newsletter card.\n` },
      ]);
      await openOn(page, workerServer, 'desktop', theme, docName);

      const reading = await expectSharedSurface(page, NEWSLETTER);
      await attachContrast(`newsletter, fake desktop, ${theme}`, reading.contrast);
    });

    test('web: the feedback card shares the floating card surface and fits a phone-width window', async ({
      page,
      api,
      workerServer,
    }) => {
      const docName = await seedFeedbackDocs(api, `web-${theme}`);
      await seedFeedbackNudgeStateBeforeLoad(page);
      await openOn(page, workerServer, 'web', theme, docName);

      const reading = await expectSharedSurface(page, FEEDBACK);
      await attachContrast(`web, ${theme}`, reading.contrast);

      await page.setViewportSize(PHONE);
      await settleForCapture(page, PHONE);
      await expect(feedbackCard(page)).toBeInViewport({ ratio: 1 });
      await attachScreenshot(page, `${theme}: web at ${PHONE.width} wide`);
    });

    test('fake desktop: the feedback card paints the same pixels over a document, the terminal and chat', async ({
      page,
      api,
      workerServer,
    }) => {
      const docName = await seedFeedbackDocs(api, `backdrops-${theme}`);
      await seedFeedbackNudgeStateBeforeLoad(page);
      await openOn(page, workerServer, 'desktop', theme, docName);
      const card = feedbackCard(page);
      await expect(card).toBeVisible({ timeout: FEEDBACK_LATCH_TIMEOUT_MS });

      const captures: BackdropCapture[] = [];
      for (const layout of BACKDROP_LAYOUTS) {
        await test.step(layout.name, async () => {
          await layout.arrange(page);
          await expect(card).toBeVisible();
          await settleForCapture(page, WIDE);
          await attachScreenshot(page, `${theme}: ${layout.name}`);
          if (!layout.compared) return;
          captures.push({ layout: layout.name, clips: await captureCardAndBackdrop(page, card) });
        });
      }

      const [reference, ...others] = captures;
      if (reference === undefined) throw new Error('expected compared backdrop layouts');
      expect(others).toHaveLength(2);
      for (const other of others) {
        expect(
          other.clips.map(({ clip }) => clip),
          `${other.layout}: the card moved`,
        ).toEqual(reference.clips.map(({ clip }) => clip));
        for (const [index, base] of reference.clips.entries()) {
          const shot = other.clips[index];
          if (shot === undefined) throw new Error('expected a capture for every clip');
          const where = `inside ${JSON.stringify(base.clip)}, ${other.layout} against ${reference.layout}`;
          expect(
            await countDifferingPixels(page, base.backdrop, shot.backdrop),
            `the backdrops ${where} should differ`,
          ).toBeGreaterThan(0);
          const differing = await countDifferingPixels(page, base.card, shot.card);
          if (differing > 0) {
            await test.info().attach(`${theme}: card over ${reference.layout}`, {
              body: base.card,
              contentType: 'image/png',
            });
            await test.info().attach(`${theme}: card over ${other.layout}`, {
              body: shot.card,
              contentType: 'image/png',
            });
          }
          expect(differing, `card pixels ${where}`).toBe(0);
        }
      }
    });
  });
}
