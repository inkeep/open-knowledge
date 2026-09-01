import { realpathSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';
import {
  type HandoffMockConfig,
  installHandoffMocks,
  readCapturedHandoff,
} from './fixtures/handoff-mocks';

const DOC_NAME = 'handoff-test-doc';
const DOC_MARKDOWN = '# Handoff Test Doc\n\nBody paragraph for the handoff matrix.';

function resolvedContentDir(contentDir: string): string {
  try {
    return realpathSync(contentDir);
  } catch {
    return contentDir;
  }
}

function seededDocRow(page: Page) {
  return page
    .locator('[data-slot="sidebar-container"]')
    .getByRole('treeitem', { name: `${DOC_NAME}.md`, exact: true });
}

async function seedAndNavigate(
  page: Page,
  api: { seedDocs: (docs: Array<{ name: string; markdown: string }>) => Promise<void> },
): Promise<void> {
  await api.seedDocs([{ name: DOC_NAME, markdown: DOC_MARKDOWN }]);
  await page.goto(`/#/${DOC_NAME}`);
  await waitForActiveProviderSynced(page);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  await expect(seededDocRow(page)).toBeVisible({ timeout: 15_000 });
}

async function openHandoffSubmenu(page: Page): Promise<void> {
  await seededDocRow(page).click({ button: 'right' });
  const submenuTrigger = page.getByRole('menuitem', { name: 'Open with AI' });
  await expect(submenuTrigger).toBeVisible({ timeout: 10_000 });
  await submenuTrigger.click();
}

async function enableDesktopTargets(page: Page, targetIds: readonly string[]): Promise<void> {
  await page.addInitScript((ids: readonly string[]) => {
    const overrides: Record<string, boolean> = {};
    for (const id of ids) overrides[`desktop:${id}`] = true;
    window.localStorage.setItem('ok-acp-enabled-agents-v1', JSON.stringify(overrides));
  }, targetIds);
}

async function registerInAppAgents(
  page: Page,
  agents: ReadonlyArray<{ source: string; id: string; name: string }>,
): Promise<void> {
  await page.addInitScript((list: ReadonlyArray<{ source: string; id: string }>) => {
    const first = list[0];
    window.localStorage.setItem(
      'ok-acp-registered-agents-v1',
      JSON.stringify({ agents: list, defaultKey: first ? `${first.source}:${first.id}` : null }),
    );
  }, agents);
}

async function waitForProbeSettled(page: Page, host: 'electron' | 'web'): Promise<void> {
  if (host === 'electron') {
    await expect
      .poll(async () => (await readCapturedHandoff(page)).detectProtocolCalls.length, {
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(3);
    return;
  }
  await expect
    .poll(
      async () => {
        return await page.evaluate(() => {
          // biome-ignore lint/suspicious/noExplicitAny: test-only global attachment.
          const mocks = (window as any).__handoffMocks__;
          return Boolean(mocks?.installedAgentsFetchResolved);
        });
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

test.describe('handoff — 8-cell matrix', () => {
  test('cell 1: Electron — claude-cowork row stays hidden even when Claude Desktop is installed', async ({
    page,
    api,
    workerServer,
  }) => {
    const cfg: HandoffMockConfig = {
      host: 'electron',
      install: { claude: true, codex: true, cursor: true },
      workerBaseURL: workerServer.baseURL,
      workerContentDir: resolvedContentDir(workerServer.contentDir),
    };
    await installHandoffMocks(page, cfg);
    await seedAndNavigate(page, api);

    await waitForProbeSettled(page, 'electron');
    await openHandoffSubmenu(page);

    await expect(page.getByTestId('file-tree-open-in-claude-code')).toBeVisible();
    await expect(page.getByTestId('file-tree-open-in-codex')).toBeVisible();
    await expect(page.getByTestId('file-tree-open-in-cursor')).toBeVisible();

    await expect(page.getByTestId('file-tree-open-in-claude-cowork')).toHaveCount(0);
  });

  test('cell 2: Electron Cursor two-step spawn → single prompt URL dispatch + success toast', async ({
    page,
    api,
    workerServer,
  }) => {
    const cfg: HandoffMockConfig = {
      host: 'electron',
      install: { claude: true, codex: true, cursor: true },
      workerBaseURL: workerServer.baseURL,
      workerContentDir: resolvedContentDir(workerServer.contentDir),
    };
    await installHandoffMocks(page, cfg);
    await seedAndNavigate(page, api);

    await waitForProbeSettled(page, 'electron');
    await openHandoffSubmenu(page);
    await page.getByTestId('file-tree-open-in-cursor').click();

    await expect
      .poll(async () => (await readCapturedHandoff(page)).handoffApiCalls.length, {
        timeout: 5_000,
      })
      .toBe(1);
    const captured = await readCapturedHandoff(page);
    const call = captured.handoffApiCalls[0];
    expect(call?.target).toBe('cursor');
    expect(call?.workspacePath).toBe(resolvedContentDir(workerServer.contentDir));
    const u = new URL(call?.url ?? '');
    expect(u.protocol).toBe('cursor:');
    expect(u.hostname).toBe('anysphere.cursor-deeplink');
    expect(u.pathname).toBe('/prompt');
    expect(u.searchParams.get('mode')).toBe('agent');
    expect(u.searchParams.get('text')).toBeTruthy();
    expect(u.searchParams.get('workspace')).toBeTruthy();

    await expect(page.getByText('Opened in Cursor.')).toBeVisible();
  });

  test('cell 3: Electron enabled-but-not-installed external app renders and routes to its installer', async ({
    page,
    api,
    workerServer,
  }) => {
    const cfg: HandoffMockConfig = {
      host: 'electron',
      install: { claude: true, codex: false, cursor: true },
      workerBaseURL: workerServer.baseURL,
      workerContentDir: resolvedContentDir(workerServer.contentDir),
    };
    await installHandoffMocks(page, cfg);
    await enableDesktopTargets(page, ['codex']);
    await seedAndNavigate(page, api);

    await waitForProbeSettled(page, 'electron');
    await openHandoffSubmenu(page);

    const codexRow = page.getByTestId('file-tree-open-in-codex');
    await expect(codexRow).toBeVisible();
    await codexRow.click();

    await expect
      .poll(async () => (await readCapturedHandoff(page)).openExternalCalls.length, {
        timeout: 5_000,
      })
      .toBe(1);
    const captured = await readCapturedHandoff(page);
    expect(captured.openExternalCalls[0]).toBe('https://developers.openai.com/codex/app');
    expect(captured.handoffApiCalls.length).toBe(0);
  });

  test('cell 4: Web — claude-cowork row stays hidden even when probe reports installed', async ({
    page,
    api,
    workerServer,
  }) => {
    const cfg: HandoffMockConfig = {
      host: 'web',
      install: { claude: true, codex: true, cursor: true },
      workerBaseURL: workerServer.baseURL,
      workerContentDir: resolvedContentDir(workerServer.contentDir),
    };
    await installHandoffMocks(page, cfg);
    await seedAndNavigate(page, api);

    await waitForProbeSettled(page, 'web');
    await openHandoffSubmenu(page);

    await expect(page.getByTestId('file-tree-open-in-claude-code')).toBeVisible();
    await expect(page.getByTestId('file-tree-open-in-claude-cowork')).toHaveCount(0);
  });

  test('cell 5: Web Cursor happy path → POST /api/handoff (target=cursor, workspacePath) + cursor:// URL', async ({
    page,
    api,
    workerServer,
  }) => {
    const cfg: HandoffMockConfig = {
      host: 'web',
      install: { claude: true, codex: true, cursor: true },
      workerBaseURL: workerServer.baseURL,
      workerContentDir: resolvedContentDir(workerServer.contentDir),
    };
    await installHandoffMocks(page, cfg);
    await seedAndNavigate(page, api);

    await waitForProbeSettled(page, 'web');
    await openHandoffSubmenu(page);

    await page.getByTestId('file-tree-open-in-cursor').click();

    await expect
      .poll(async () => (await readCapturedHandoff(page)).handoffApiCalls.length, {
        timeout: 5_000,
      })
      .toBe(1);
    const captured = await readCapturedHandoff(page);
    const call = captured.handoffApiCalls[0];
    expect(call?.target).toBe('cursor');
    expect(call?.workspacePath).toBe(resolvedContentDir(workerServer.contentDir));
    const u = new URL(call?.url ?? '');
    expect(u.protocol).toBe('cursor:');
    expect(u.hostname).toBe('anysphere.cursor-deeplink');
    expect(u.pathname).toBe('/prompt');
    expect(u.searchParams.get('mode')).toBe('agent');
    expect(u.searchParams.get('text')).toBeTruthy();
    expect(u.searchParams.get('workspace')).toBeTruthy();

    await expect(page.getByText('Opened in Cursor.')).toBeVisible();

    expect(captured.openExternalCalls.length).toBe(0);
    expect(captured.anchorClicks.length).toBe(0);
  });

  test('cell 7: Web — every per-target external-app row hidden, seeded in-app agent rows still offered, no claude.ai fallback', async ({
    page,
    api,
    workerServer,
  }) => {
    const cfg: HandoffMockConfig = {
      host: 'web',
      install: { claude: false, codex: false, cursor: false },
      workerBaseURL: workerServer.baseURL,
      workerContentDir: resolvedContentDir(workerServer.contentDir),
    };
    await installHandoffMocks(page, cfg);
    await registerInAppAgents(page, [{ source: 'registry', id: 'claude-acp', name: 'Claude' }]);
    await seedAndNavigate(page, api);

    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await waitForProbeSettled(page, 'web');
    await openHandoffSubmenu(page);

    for (const id of ['claude-cowork', 'claude-code', 'codex', 'cursor']) {
      await expect(page.getByTestId(`file-tree-open-in-${id}`)).toHaveCount(0);
    }
    await expect(page.getByTestId('open-in-agent-claude-web-fallback')).toHaveCount(0);
    await expect(page.getByTestId('file-tree-open-in-thread-claude-acp')).toBeVisible();
    await expect(page.getByTestId('file-tree-open-in-empty')).toHaveCount(0);

    expect(consoleErrors.filter((e) => !e.includes('net::') && !e.includes('favicon'))).toEqual([]);

    const captured = await readCapturedHandoff(page);
    expect(captured.anchorClicks).toEqual([]);
    expect(captured.openExternalCalls).toEqual([]);
  });

  test('cell 8: Electron Cursor handoff failure → failure toast + error telemetry line', async ({
    page,
    api,
    workerServer,
  }) => {
    const cfg: HandoffMockConfig = {
      host: 'electron',
      install: { claude: true, codex: true, cursor: true },
      workerBaseURL: workerServer.baseURL,
      workerContentDir: resolvedContentDir(workerServer.contentDir),
    };
    await installHandoffMocks(page, cfg);
    await page.unroute('**/api/handoff');
    await page.route('**/api/handoff', async (route) => {
      await route.fulfill({
        status: 422,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'urn:ok:error:handoff-target-not-installed',
          title: 'Cursor CLI not found on this machine.',
          status: 422,
          target: 'cursor',
        }),
      });
    });
    await seedAndNavigate(page, api);

    await waitForProbeSettled(page, 'electron');
    await openHandoffSubmenu(page);
    await page.getByTestId('file-tree-open-in-cursor').click();

    await expect
      .poll(async () => (await readCapturedHandoff(page)).handoffApiCalls.length, {
        timeout: 5_000,
      })
      .toBe(1);

    await expect(page.getByText("Couldn't reach Cursor — try again?")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();

    const captured = await readCapturedHandoff(page);
    expect(captured.openExternalCalls).toEqual([]);

    expect(captured.recordHandoffCalls.length).toBe(1);
    const [line] = captured.recordHandoffCalls;
    expect(line?.target).toBe('cursor');
    expect(line?.host).toBe('electron');
    expect(line?.outcome).toBe('error');
    expect(line?.reason).toBe('not-installed');
  });
});
