import type { Locator } from '@playwright/test';
import {
  dockSeam,
  expect,
  headerPaneButton,
  setHeaderPane,
  stubAgentCatalog,
  test,
  waitForActiveProviderSynced,
} from './_helpers';

const BOOT_TIMEOUT_MS = 30_000;

interface FocusLook {
  readonly focusVisible: boolean;
  readonly outlineStyle: string;
  readonly outlineWidthPx: number;
  readonly boxShadow: string;
}

async function readFocusLook(seam: Locator): Promise<FocusLook> {
  return await seam.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      focusVisible: element.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidthPx: Number.parseFloat(style.outlineWidth),
      boxShadow: style.boxShadow,
    };
  });
}

test.describe('dock seams', () => {
  test('a keyboard-focused seam keeps a visible focus indicator when the system forces colors', async ({
    page,
    api,
  }) => {
    const name = `dock-seam-focus-${test.info().workerIndex}`;
    await api.seedDocs([{ name, markdown: `# ${name}\n\nA document beside the Agents panel.\n` }]);
    await stubAgentCatalog(page);
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(`/#/${name}`);
    await waitForActiveProviderSynced(page);
    await expect(headerPaneButton(page, 'editor')).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
    await setHeaderPane(page, 'agents', true);

    const seam = dockSeam(page, 'agents');
    await seam.focus();
    await page.keyboard.press('Shift');
    await expect(seam).toBeFocused();

    const normal = await readFocusLook(seam);
    expect(normal.focusVisible).toBe(true);
    expect(normal.boxShadow).not.toBe('none');

    await page.emulateMedia({ forcedColors: 'active' });
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
    const forced = await readFocusLook(seam);
    expect(forced.focusVisible).toBe(true);
    expect(forced.outlineStyle).toBe('solid');
    expect(forced.outlineWidthPx).toBeGreaterThanOrEqual(1);
  });
});
