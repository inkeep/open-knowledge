import type { Locator, Page } from '@playwright/test';
import { expect } from './fixtures.ts';
import { escapeRegExp } from './regexp.ts';

function sidebarTreeItem(page: Page, name: string): Locator {
  return page
    .locator('[data-slot="sidebar-container"]')
    .getByRole('treeitem', { name, exact: true });
}

function activeEditorTabButton(page: Page, name: string): Locator {
  return page.locator('[data-active-tab="true"]').getByRole('button', { name, exact: true });
}

const CREATE_CONVERGED_TIMEOUT = process.env.CI ? 15_000 : 10_000;

const APP_SHELL_CRASH_LOG = '[AppErrorBoundary]';
const PROBE_TIMEOUT = 2_000;

interface EditorTabStripEntry {
  active: boolean;
  paneId: string | null;
  tabId: string | null;
  labels: string[];
}

interface ProbeFailure {
  probeError: string;
}

async function withProbeTimeout<T>(work: Promise<T>): Promise<T | ProbeFailure> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<ProbeFailure>((resolve) => {
    timer = setTimeout(
      () => resolve({ probeError: `probe did not settle within ${PROBE_TIMEOUT}ms` }),
      PROBE_TIMEOUT,
    );
  });
  try {
    return await Promise.race([work, guard]);
  } catch (error: unknown) {
    return { probeError: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function editorTabStrip(page: Page): Promise<EditorTabStripEntry[] | ProbeFailure> {
  return withProbeTimeout(
    page.evaluate(() =>
      Array.from(
        document.querySelectorAll('[data-editor-pane-tabs] [data-editor-tab-sortable]'),
      ).map((tab) => ({
        active: tab.getAttribute('data-active-tab') === 'true',
        paneId: tab.getAttribute('data-editor-pane-id'),
        tabId: tab.getAttribute('data-editor-tab-id'),
        labels: Array.from(tab.querySelectorAll('button')).map(
          (button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '',
        ),
      })),
    ),
  );
}

function persistedTabSessions(page: Page): Promise<Record<string, unknown> | ProbeFailure> {
  return withProbeTimeout(
    page.evaluate(() => {
      const out: Record<string, unknown> = {};
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key?.startsWith('ok-editor-tabs-v1:')) continue;
        const raw = localStorage.getItem(key) ?? '';
        try {
          out[key] = JSON.parse(raw);
        } catch {
          out[key] = raw;
        }
      }
      return out;
    }),
  );
}

interface AppShellCrashLogs {
  total: number;
  matches: string[];
}

function appShellCrashLogs(page: Page): Promise<AppShellCrashLogs | ProbeFailure> {
  return withProbeTimeout(
    page.consoleMessages({ filter: 'all' }).then((messages) => ({
      total: messages.length,
      matches: messages
        .map((message) => message.text())
        .filter((text) => text.includes(APP_SHELL_CRASH_LOG)),
    })),
  );
}

function appShellCrash(page: Page): Promise<string | null | ProbeFailure> {
  return withProbeTimeout(
    page.evaluate(
      () => document.querySelector('[data-slot="app-error-boundary"]')?.textContent?.trim() ?? null,
    ),
  );
}

export async function expectActiveEditorTab(
  page: Page,
  name: string,
  options: { timeout?: number } = {},
): Promise<void> {
  try {
    await expect(activeEditorTabButton(page, name)).toBeVisible({
      timeout: options.timeout ?? CREATE_CONVERGED_TIMEOUT,
    });
  } catch (cause) {
    const strip = await editorTabStrip(page);
    const sessions = await persistedTabSessions(page);
    const crash = await appShellCrash(page);
    const crashLogs = await appShellCrashLogs(page);
    const wrapped = new Error(
      [
        `active editor tab never became "${name}".`,
        `url=${page.url()}`,
        ...(Array.isArray(strip)
          ? [`activeTabCount=${strip.filter((tab) => tab.active).length}`]
          : []),
        `appShellCrash=${JSON.stringify(crash)}`,
        `appShellCrashLogs=${JSON.stringify(crashLogs)}`,
        `strip=${JSON.stringify(strip)}`,
        `persistedTabSessions=${JSON.stringify(sessions)}`,
      ].join(' '),
      { cause },
    );
    if (cause !== null && typeof cause === 'object' && 'matcherResult' in cause) {
      (wrapped as { matcherResult?: unknown }).matcherResult = (
        cause as { matcherResult?: unknown }
      ).matcherResult;
    }
    throw wrapped;
  }
}

export async function createFolderViaSidebar(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  const input = page.getByRole('textbox', { name: /rename New Folder/i });
  await expect(input).toBeVisible({ timeout: CREATE_CONVERGED_TIMEOUT });
  await input.fill(name);
  await input.press('Enter');

  await expect(sidebarTreeItem(page, name)).toBeVisible({ timeout: CREATE_CONVERGED_TIMEOUT });
  await expectActiveEditorTab(page, `${name}/`);
  await expect(page).toHaveURL(new RegExp(`#/${escapeRegExp(name)}/$`), {
    timeout: CREATE_CONVERGED_TIMEOUT,
  });
}

export async function createFileViaSidebar(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  const input = page.getByRole('textbox', { name: /rename Untitled\.md/i });
  await expect(input).toBeVisible({ timeout: CREATE_CONVERGED_TIMEOUT });
  await input.fill(name);
  await input.press('Enter');

  await expect(sidebarTreeItem(page, `${name}.md`)).toBeVisible({
    timeout: CREATE_CONVERGED_TIMEOUT,
  });
  await expectActiveEditorTab(page, `${name}.md`);
  await expect(page).toHaveURL(new RegExp(`#/${escapeRegExp(name)}$`), {
    timeout: CREATE_CONVERGED_TIMEOUT,
  });
}
