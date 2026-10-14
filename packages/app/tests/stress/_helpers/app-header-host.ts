import { realpathSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { installHandoffMocks } from '../fixtures/handoff-mocks';
import { expect } from './fixtures.ts';
import { waitForActiveProviderSynced } from './provider.ts';

export type DesktopHeaderPlatform = 'darwin' | 'win32' | 'linux';

export const DESKTOP_HEADER_PLATFORMS = [
  'darwin',
  'win32',
  'linux',
] as const satisfies readonly DesktopHeaderPlatform[];

export const DESKTOP_HEADER_PLATFORM_NAMES = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
} as const satisfies Record<DesktopHeaderPlatform, string>;

export const MAC_WINDOW_BUTTONS_X_PX = 16;
export const MAC_WINDOW_BUTTONS_WIDTH_PX = 60;
const WINDOWS_CAPTION_WIDTH_PX = 138;
const LINUX_CAPTION_WIDTH_PX = 96;

export interface DesktopHeaderHost {
  readonly projectName?: string;
  readonly instanceLabel?: string;
  readonly channel?: 'latest' | 'beta';
  readonly platform?: DesktopHeaderPlatform;
  readonly captionWidth?: number;
}

export type WindowControls =
  | { readonly corner: 'top-left'; readonly offset: number; readonly width: number }
  | { readonly corner: 'top-right'; readonly width: number };

function captionWidthFor(platform: Exclude<DesktopHeaderPlatform, 'darwin'>): number {
  switch (platform) {
    case 'win32':
      return WINDOWS_CAPTION_WIDTH_PX;
    case 'linux':
      return LINUX_CAPTION_WIDTH_PX;
  }
}

function captionWidthOf(host: DesktopHeaderHost): number | null {
  const platform = host.platform ?? 'darwin';
  return host.captionWidth ?? (platform === 'darwin' ? null : captionWidthFor(platform));
}

export function windowControlsOf(host: DesktopHeaderHost): WindowControls {
  const captionWidth = captionWidthOf(host);
  if (captionWidth === null) {
    return {
      corner: 'top-left',
      offset: MAC_WINDOW_BUTTONS_X_PX,
      width: MAC_WINDOW_BUTTONS_WIDTH_PX,
    };
  }
  return { corner: 'top-right', width: captionWidth };
}

export async function openDesktopHeader(
  page: Page,
  workerServer: { baseURL: string; contentDir: string },
  docName: string,
  host: DesktopHeaderHost,
  search = '',
) {
  let contentDir = workerServer.contentDir;
  try {
    contentDir = realpathSync(contentDir);
  } catch {}
  await installHandoffMocks(page, {
    host: 'electron',
    install: { claude: false, codex: false, cursor: false },
    workerBaseURL: workerServer.baseURL,
    workerContentDir: contentDir,
  });
  await page.addInitScript(
    ({
      overrides,
      captionWidth,
    }: {
      overrides: DesktopHeaderHost;
      captionWidth: number | null;
    }) => {
      const bridge = (
        window as unknown as {
          okDesktop: {
            config: { projectName: string };
            instanceLabel: string | null;
            platform: string;
            state: { query: () => Promise<unknown> };
          };
        }
      ).okDesktop;
      if (overrides.platform !== undefined) bridge.platform = overrides.platform;
      if (overrides.projectName !== undefined) bridge.config.projectName = overrides.projectName;
      if (overrides.instanceLabel !== undefined) bridge.instanceLabel = overrides.instanceLabel;
      const channel = overrides.channel;
      if (channel !== undefined) {
        bridge.state.query = async () => ({ channel, schemaIncompatibility: null });
      }
      if (captionWidth !== null) {
        new MutationObserver((_records, observer) => {
          if (document.documentElement == null) return;
          observer.disconnect();
          document.documentElement.style.setProperty(
            '--ok-titlebar-reserve-right',
            `${captionWidth}px`,
          );
        }).observe(document, { childList: true });
      }
    },
    { overrides: host, captionWidth: captionWidthOf(host) },
  );
  await page.goto(`/${search}#/${docName}`);
  await waitForActiveProviderSynced(page);
  await expect(page.getByTestId('project-switcher-trigger')).toBeVisible();
  if ((host.platform ?? 'darwin') !== 'darwin') {
    await expect(page.getByTestId('app-menubar')).toBeVisible();
  }
  if (host.channel === 'beta') await expect(page.getByTestId('beta-badge')).toBeVisible();
  if (host.instanceLabel !== undefined) {
    await expect(page.getByTestId('instance-badge')).toBeVisible();
  }
}

export async function settleFrames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

export interface HeaderFit {
  readonly top: number;
  readonly height: number;
  readonly controls: number;
  readonly outsideRow: readonly string[];
  readonly overlapping: readonly string[];
  readonly underWindowControls: readonly string[];
  readonly layout: string;
}

async function probeHeaderFit(
  page: Page,
  windowControls: WindowControls | null,
): Promise<HeaderFit> {
  return await page.evaluate((corner) => {
    const header = document.querySelector('header[data-app-header]');
    if (!(header instanceof HTMLElement)) throw new Error('header fit: the app header is missing');
    const box = header.getBoundingClientRect();
    const cornerRect =
      corner === null
        ? null
        : corner.corner === 'top-left'
          ? { left: corner.offset, right: corner.offset + corner.width }
          : { left: window.innerWidth - corner.width, right: window.innerWidth };
    const labelOf = (el: Element) =>
      el.getAttribute('aria-label') ??
      el.getAttribute('data-testid') ??
      (el.textContent?.trim() || el.tagName);
    const controls = Array.from(
      header.querySelectorAll(
        'button, a, [data-testid$="-badge"], [data-testid="header-pane-divider"]',
      ),
    ).filter((el): el is HTMLElement => el instanceof HTMLElement && el.checkVisibility());
    const rects = controls.map((el) => el.getBoundingClientRect());
    const outsideRow: string[] = [];
    const underWindowControls: string[] = [];
    const overlapping: string[] = [];
    controls.forEach((el, i) => {
      const r = rects[i];
      if (r === undefined) return;
      if (r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5) outsideRow.push(labelOf(el));
      if (
        cornerRect !== null &&
        r.left < cornerRect.right - 0.5 &&
        r.right > cornerRect.left + 0.5 &&
        r.top < box.bottom
      ) {
        underWindowControls.push(labelOf(el));
      }
      controls.forEach((other, j) => {
        const o = rects[j];
        if (j <= i || o === undefined || el.contains(other) || other.contains(el)) return;
        if (
          r.left < o.right - 0.5 &&
          o.left < r.right - 0.5 &&
          r.top < o.bottom - 0.5 &&
          o.top < r.bottom - 0.5
        ) {
          overlapping.push(`${labelOf(el)} | ${labelOf(other)}`);
        }
      });
    });
    return {
      top: box.top,
      height: box.height,
      controls: controls.length,
      outsideRow,
      overlapping,
      underWindowControls,
      layout: controls
        .map((el, i) => `${labelOf(el)}@${Math.round(rects[i]?.left ?? -1)}`)
        .join(','),
    };
  }, windowControls);
}

export async function settledHeaderFit(
  page: Page,
  windowControls: WindowControls | null,
): Promise<HeaderFit> {
  await page.evaluate(() => document.fonts.ready);
  await settleFrames(page);
  let fit = await probeHeaderFit(page, windowControls);
  for (let pass = 0; pass < 20; pass += 1) {
    await settleFrames(page);
    const next = await probeHeaderFit(page, windowControls);
    if (next.layout === fit.layout) return next;
    fit = next;
  }
  throw new Error(`header fit: the header layout never settled (last: ${fit.layout})`);
}
