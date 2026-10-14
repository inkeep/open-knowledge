import type { ElectronApplication, Page, TestInfo } from '@playwright/test';

const BOUND_MS = 5_000;

function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} exceeded ${BOUND_MS}ms`)), BOUND_MS),
    ),
  ]);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function describeDomState(page: Page): Promise<string> {
  try {
    return await bounded(
      page.evaluate(() => {
        const label = (el: Element) =>
          `${el.tagName.toLowerCase()}[${el.getAttribute('role') ?? '-'}][${
            el.getAttribute('data-testid') ?? el.getAttribute('data-slot') ?? (el.id || '-')
          }]`;
        const active = document.activeElement;
        const paneButtons = document.querySelector(
          'header[data-app-header] [data-testid="header-pane-buttons"]',
        );
        return JSON.stringify({
          hasFocus: document.hasFocus(),
          activeElement: active ? label(active) : null,
          ariaHiddenRoots: [...document.body.children]
            .filter((el) => el.getAttribute('aria-hidden') === 'true')
            .map(label),
          openLayers: [...document.querySelectorAll('[data-state="open"]')].map(label).slice(0, 24),
          menus: document.querySelectorAll('[role="menu"]').length,
          dialogs: document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length,
          crashInviteDialog:
            document.querySelector('[role="dialog"] [data-testid="report-bug-crash-invite"]') !==
            null,
          headerPaneButtons:
            paneButtons === null
              ? 'absent'
              : paneButtons.closest('[aria-hidden="true"]')
                ? 'inside an aria-hidden subtree'
                : 'present',
        });
      }),
      'dom state',
    );
  } catch (error) {
    return `unavailable: ${reasonOf(error)}`;
  }
}

async function ariaSnapshotOf(page: Page): Promise<string> {
  try {
    return await bounded(page.locator('body').ariaSnapshot({ timeout: BOUND_MS }), 'aria snapshot');
  } catch (error) {
    return `unavailable: ${reasonOf(error)}`;
  }
}

export async function attachDomState(testInfo: TestInfo, page: Page, name: string): Promise<void> {
  const [state, aria] = await Promise.all([describeDomState(page), ariaSnapshotOf(page)]);
  try {
    await testInfo.attach(name, {
      body: `${page.url()}\n\n${state}\n\n${aria}`,
      contentType: 'text/plain',
    });
  } catch (error) {
    console.warn(`[smoke-test] ${name} attach failed: ${reasonOf(error)}`);
  }
}

export async function attachDomStateOnFailure(
  testInfo: TestInfo,
  apps: readonly ElectronApplication[],
): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return;
  let index = 0;
  for (const app of apps) {
    for (const page of app.windows()) {
      if (page.isClosed()) continue;
      index += 1;
      await attachDomState(testInfo, page, `dom-state-${index}`);
    }
  }
}
