import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import {
  DESKTOP_HEADER_PLATFORM_NAMES,
  DESKTOP_HEADER_PLATFORMS,
  type DesktopHeaderHost,
  expect,
  openDesktopHeader,
  settledHeaderFit,
  test,
  type WindowControls,
  waitForActiveProviderSynced,
  windowControlsOf,
} from './_helpers';

const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'ok-header-locale-home-'));

test.use({ workerServerEnv: { HOME: ISOLATED_HOME }, locale: 'pt-BR' });

const APP_HEADER_PX = 44;

function plainMessages(locale: string): Record<string, string> {
  const path = fileURLToPath(new URL(`../../src/locales/${locale}/messages.json`, import.meta.url));
  const { messages } = JSON.parse(readFileSync(path, 'utf8')) as {
    messages: Record<string, unknown[]>;
  };
  const plain: Record<string, string> = {};
  for (const [id, parts] of Object.entries(messages)) {
    if (parts.length === 1 && typeof parts[0] === 'string') plain[id] = parts[0];
  }
  return plain;
}

const EN = plainMessages('en');

function translate(english: string, target: Record<string, string>): string {
  const id = Object.keys(EN).find((key) => EN[key] === english);
  const translated = id === undefined ? undefined : target[id];
  if (translated === undefined || translated === english) {
    throw new Error(`"${english}" has no distinct translation in the target catalog`);
  }
  return translated;
}

function untranslatedEnglish(target: Record<string, string>): Set<string> {
  const english = new Set<string>();
  for (const [id, text] of Object.entries(EN)) {
    if (target[id] !== undefined && target[id] !== text) english.add(text);
  }
  return english;
}

const LOCALES = [
  { label: 'the pseudolocale', search: '?lang=pseudo', messages: plainMessages('pseudo') },
  { label: 'Brazilian Portuguese', search: '', messages: plainMessages('pt-BR') },
] as const;

async function headerControlNames(page: Page): Promise<string[]> {
  const header = page.locator('header[data-app-header]');
  const snapshot = await header.ariaSnapshot();
  const controls = Array.from(
    snapshot.matchAll(/^\s*- (?:button|link)(?: "((?:[^"\\]|\\.)*)")?/gm),
    (match) => match[1] ?? '',
  );
  const badges = await header.locator('[data-testid$="-badge"]').evaluateAll((elements) =>
    elements.map((el) => {
      const label = el.getAttribute('aria-label');
      if (label !== null) return label;
      const announced = el.cloneNode(true) as Element;
      for (const hidden of announced.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
      return announced.textContent?.trim() ?? '';
    }),
  );
  return [...controls, ...badges];
}

async function measureHeaderFit(page: Page) {
  return await page.evaluate(() => {
    const header = document.querySelector('header[data-app-header]');
    if (!(header instanceof HTMLElement)) throw new Error('the app header is not in the document');
    const box = header.getBoundingClientRect();
    const labelOf = (el: Element) =>
      el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName;
    const outside: string[] = [];
    const wrapped: string[] = [];
    let controls = 0;
    for (const el of header.querySelectorAll('button, a, [data-testid$="-badge"]')) {
      if (!(el instanceof HTMLElement) || !el.checkVisibility()) continue;
      controls++;
      const r = el.getBoundingClientRect();
      if (r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5) outside.push(labelOf(el));
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const lines = new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top)));
        if (lines.size > 1) wrapped.push(labelOf(el));
      }
    }
    return {
      top: box.top,
      height: box.height,
      overflowsInline: header.scrollWidth > header.clientWidth + 1,
      controls,
      outside,
      wrapped,
    };
  });
}

async function expectHeaderFitsIn(
  page: Page,
  messages: Record<string, string>,
  windowControls: WindowControls | null,
) {
  const placement = await settledHeaderFit(page, windowControls);
  expect(placement).toMatchObject({ overlapping: [], underWindowControls: [] });
  const fit = await measureHeaderFit(page);
  expect(fit.controls).toBeGreaterThan(0);
  expect(fit).toMatchObject({
    top: 0,
    height: APP_HEADER_PX,
    overflowsInline: false,
    outside: [],
    wrapped: [],
  });

  const names = await headerControlNames(page);
  expect(names.length).toBeGreaterThan(0);
  expect(names.filter((name) => name === '')).toEqual([]);
  const english = untranslatedEnglish(messages);
  expect(names.filter((name) => english.has(name))).toEqual([]);
}

for (const locale of LOCALES) {
  test(`on web in ${locale.label} the header stays one ${APP_HEADER_PX}px row with every control named in that language`, async ({
    page,
    api,
  }) => {
    const name = `app-header-locale-web-${locale.search === '' ? 'pt' : 'pseudo'}`;
    await api.seedDocs([{ name, markdown: `# ${name}\n\nbody\n` }]);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/${locale.search}#/${name}`);
    await waitForActiveProviderSynced(page);
    await expect(
      page.getByRole('banner', { name: translate('Application', locale.messages), exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    await expectHeaderFitsIn(page, locale.messages, null);
    await page.setViewportSize({ width: 393, height: 852 });
    await expectHeaderFitsIn(page, locale.messages, null);
  });

  for (const platform of DESKTOP_HEADER_PLATFORMS) {
    test(`on ${DESKTOP_HEADER_PLATFORM_NAMES[platform]} desktop in ${locale.label} the header stays one ${APP_HEADER_PX}px row with every control named in that language and none under the window controls`, async ({
      page,
      api,
      workerServer,
    }) => {
      const name = `app-header-locale-${platform}-${locale.search === '' ? 'pt' : 'pseudo'}`;
      await api.seedDocs([{ name, markdown: `# ${name}\n\nbody\n` }]);
      await page.setViewportSize({ width: 1280, height: 800 });
      const host: DesktopHeaderHost = { platform, channel: 'beta', instanceLabel: 'wt-locale' };
      await openDesktopHeader(page, workerServer, name, host, locale.search);
      await expect(
        page.getByRole('banner', { name: translate('Application', locale.messages), exact: true }),
      ).toBeVisible({ timeout: 15_000 });

      await expectHeaderFitsIn(page, locale.messages, windowControlsOf(host));
      await page.setViewportSize({ width: 720, height: 800 });
      await expectHeaderFitsIn(page, locale.messages, windowControlsOf(host));
    });
  }
}
