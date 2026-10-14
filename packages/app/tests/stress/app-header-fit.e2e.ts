import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PICKER_LOCALES } from '@inkeep/open-knowledge-core';
import {
  acpCatalogBody,
  DESKTOP_HEADER_PLATFORM_NAMES,
  DESKTOP_HEADER_PLATFORMS,
  type DesktopHeaderHost,
  expect,
  openDesktopHeader,
  settledHeaderFit,
  test,
  windowControlsOf,
} from './_helpers';

const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'ok-header-fit-home-'));

test.use({ workerServerEnv: { HOME: ISOLATED_HOME } });

const APP_HEADER_PX = 44;
const DESKTOP_MINIMUM_WINDOW = { width: 720, height: 480 } as const;
const ONE_ZOOM_STEP_IN = 1.2 ** 0.5;
const DESKTOP_MINIMUM_WINDOW_ONE_ZOOM_STEP_IN = {
  width: Math.floor(DESKTOP_MINIMUM_WINDOW.width / ONE_ZOOM_STEP_IN),
  height: Math.floor(DESKTOP_MINIMUM_WINDOW.height / ONE_ZOOM_STEP_IN),
} as const;

const BUILD_BADGES = '[data-testid="beta-badge"], [data-testid="instance-badge"]';

const BUILDS = [
  { key: 'stable', label: 'the stable build', host: {}, badges: false },
  {
    key: 'beta',
    label: 'the Beta build with an instance badge',
    host: { channel: 'beta', instanceLabel: 'wt-layout-header-buttons' },
    badges: true,
  },
] as const;

test.beforeEach(async ({ page }) => {
  await page.route('**/api/acp/catalog', (route) => route.fulfill({ json: acpCatalogBody([]) }));
});
for (const locale of PICKER_LOCALES) {
  test.describe(`in ${locale}`, () => {
    test.use({ locale });

    for (const platform of DESKTOP_HEADER_PLATFORMS) {
      for (const build of BUILDS) {
        test(`on ${DESKTOP_HEADER_PLATFORM_NAMES[platform]}, ${build.label} at the 720px minimum keeps one ${APP_HEADER_PX}px header row with the pane buttons in view`, async ({
          page,
          api,
          workerServer,
        }) => {
          const name = `app-header-fit-${platform}-${build.key}-${locale.toLowerCase()}`;
          await api.seedDocs([{ name, markdown: `# ${name}\n\nbody\n` }]);
          const host: DesktopHeaderHost = { platform, ...build.host };
          await page.setViewportSize({ width: 1280, height: 800 });
          await openDesktopHeader(page, workerServer, name, host);
          await expect(page.locator('html')).toHaveAttribute('lang', locale, { timeout: 15_000 });

          await page.setViewportSize(DESKTOP_MINIMUM_WINDOW);
          const fit = await settledHeaderFit(page, windowControlsOf(host));
          expect(fit.controls).toBeGreaterThan(0);
          expect(fit).toMatchObject({
            top: 0,
            height: APP_HEADER_PX,
            outsideRow: [],
            overlapping: [],
            underWindowControls: [],
          });

          const header = page.locator('header[data-app-header]');
          await expect(header.getByTestId('header-pane-divider')).toBeVisible();
          await expect(header.getByTestId('header-pane-button-agents')).toBeVisible();
          await expect(header.getByTestId('header-pane-button-terminal')).toBeVisible();

          const leadingBadges = header.locator('[data-app-header-leading]').locator(BUILD_BADGES);
          const trigger = header.getByTestId('header-overflow-actions-trigger');
          const folded = (await trigger.count()) > 0;
          if (build.badges && platform !== 'darwin') expect(folded).toBe(true);
          const badgesFold = build.badges && folded && platform !== 'darwin';
          if (build.badges && !badgesFold) {
            await expect(leadingBadges).toHaveCount(2);
          } else {
            await expect(leadingBadges).toHaveCount(0);
          }
          if (!folded) return;

          await trigger.click();
          const panel = page.locator('[data-header-overflow-actions]');
          await expect(panel).toBeVisible();
          await expect(panel.locator('[data-testid^="header-pane-"]')).toHaveCount(0);
          if (badgesFold) {
            await expect(panel.getByTestId('beta-badge')).toBeVisible();
            await expect(panel.getByTestId('instance-badge')).toBeVisible();
          } else {
            await expect(panel.locator(BUILD_BADGES)).toHaveCount(0);
          }
        });
      }
    }
  });
}

test.describe('in en, zoomed in one step', () => {
  test.use({ locale: 'en', deviceScaleFactor: ONE_ZOOM_STEP_IN });

  for (const platform of DESKTOP_HEADER_PLATFORMS) {
    for (const build of BUILDS) {
      test(`on ${DESKTOP_HEADER_PLATFORM_NAMES[platform]}, ${build.label} at the 720px minimum zoomed in one step keeps one ${APP_HEADER_PX}px header row with the pane buttons in view`, async ({
        page,
        api,
        workerServer,
      }) => {
        const name = `app-header-fit-zoom-${platform}-${build.key}`;
        await api.seedDocs([{ name, markdown: `# ${name}\n\nbody\n` }]);
        const host: DesktopHeaderHost = { platform, ...build.host };
        await page.setViewportSize({ width: 1280, height: 800 });
        await openDesktopHeader(page, workerServer, name, host);

        await page.setViewportSize(DESKTOP_MINIMUM_WINDOW_ONE_ZOOM_STEP_IN);
        const fit = await settledHeaderFit(page, windowControlsOf(host));
        expect(fit.controls).toBeGreaterThan(0);
        expect(fit).toMatchObject({
          top: 0,
          height: APP_HEADER_PX,
          outsideRow: [],
          overlapping: [],
          underWindowControls: [],
        });

        const header = page.locator('header[data-app-header]');
        await expect(header.getByTestId('header-pane-divider')).toBeVisible();
        await expect(header.getByTestId('header-pane-button-agents')).toBeVisible();
        await expect(header.getByTestId('header-pane-button-terminal')).toBeVisible();
      });
    }
  }
});
