import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import {
  HISTORY_DOCKED_MIN_PANE_WIDTH_PX,
  HISTORY_PANEL_WIDTH_PX,
} from '../../src/hooks/use-history-presentation-mode';
import { AGENTS_PANEL_WIDTH_KEY } from '../../src/lib/agents-panel-width-store';
import {
  contrastRatioOf,
  expect,
  readContrastPair,
  servedModuleRoute,
  stubAgentCatalog,
  switchColorThemeAndSettleFade,
  test,
} from './_helpers';

const AGENTS_PANEL_MOUNT = '[data-agents-panel-mount]';
const SESSIONS_HOST_SOURCE = 'src/components/SessionsHost.tsx';
const CONFIG_RESPONSE_GLOB = '**/api/config';
const AGENTS_ORDER_STORAGE_KEY = 'ok-agent-session-order-v1';
const SEED_AGENT_ID = 'panel-level-fixture-agent';
const SEED_AGENT_NAME = 'Panel Level Fixture';
const REGISTERED_AGENTS_KEY = 'ok-acp-registered-agents-v1';
const BOOT_TIMEOUT_MS = 30_000;
const ROSTER_TIMEOUT_MS = 30_000;
const AGENTS_HEADER_BUTTON = 'header-pane-button-agents';
const STORED_AGENTS_PANEL_WIDTH_PX = 400;
const THREAD_COMPOSER = '[data-testid="agent-thread-composer"]';
const HEADER_DRAFT = 'Draft kept across a header hide';
const SELECTION_DOC_TEXT = 'The quick brown fox jumps over the lazy dog.';

interface ThreadFrame {
  op: string;
  reqId?: string;
  threads?: Array<{ threadId: string; archived?: boolean }>;
  info?: { threadId: string };
}

type SocketFrameSender = (frame: Record<string, unknown>) => void;

interface FrameRecorder {
  readonly frames: ThreadFrame[];
  unparseableCount: number;
}

type RouteMarkRoute = 'config-response' | 'roster-frame' | 'sessions-chunk-response';

interface RouteMark {
  route: RouteMarkRoute;
  at: number;
}

async function expectContrast(
  foreground: Locator,
  background: Locator,
  minimum: number,
): Promise<void> {
  const pair = await readContrastPair(foreground, background);
  const ratio = contrastRatioOf(pair);
  expect(
    ratio,
    `contrast ${ratio.toFixed(4)} is below the required ${minimum} for foreground rgba(${pair.foreground.join(', ')}) composited over background rgba(${pair.background.join(', ')})`,
  ).toBeGreaterThanOrEqual(minimum);
}

function observedOrder(marks: RouteMark[]): RouteMarkRoute[] {
  const seen = new Set<RouteMarkRoute>();
  const order: RouteMarkRoute[] = [];
  for (const mark of marks) {
    if (seen.has(mark.route)) continue;
    seen.add(mark.route);
    order.push(mark.route);
  }
  return order;
}

async function waitForRouteMark(
  marks: RouteMark[],
  route: RouteMarkRoute,
  timeoutMessage: string,
): Promise<void> {
  const deadline = Date.now() + ROSTER_TIMEOUT_MS;
  while (!marks.some((mark) => mark.route === route)) {
    if (Date.now() >= deadline) throw new Error(timeoutMessage);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function withThreadSocket<T>(
  port: number,
  run: (send: SocketFrameSender, frames: ThreadFrame[], recorder: FrameRecorder) => Promise<T>,
): Promise<T> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/collab/thread`);
  const recorder: FrameRecorder = { frames: [], unparseableCount: 0 };
  ws.addEventListener('message', (ev) => {
    try {
      recorder.frames.push(JSON.parse(String(ev.data)) as ThreadFrame);
    } catch {
      recorder.unparseableCount += 1;
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('thread socket open timeout')), 15_000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('thread socket failed to open'));
    });
  });
  try {
    return await run((frame) => ws.send(JSON.stringify(frame)), recorder.frames, recorder);
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

async function latestRoster(
  send: SocketFrameSender,
  frames: ThreadFrame[],
  recorder: FrameRecorder,
  timeoutMs = 10_000,
): Promise<Array<{ threadId: string; archived?: boolean }>> {
  send({ op: 'list' });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = frames.filter((frame) => frame.op === 'threads').at(-1);
    if (snapshot?.threads) return snapshot.threads;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `thread roster never arrived (${recorder.unparseableCount} unparseable frame(s) observed)`,
  );
}

async function purgeLiveThreads(port: number): Promise<void> {
  const live = (await withThreadSocket(port, latestRoster)).filter(
    (thread) => thread.archived !== true,
  );
  for (const thread of live) {
    await withThreadSocket(port, async (send, frames, recorder) => {
      send({ op: 'close', threadId: thread.threadId });
      const closeDeadline = Date.now() + 20_000;
      let archived = false;
      let discarded = false;
      while (Date.now() < closeDeadline) {
        const errored = recorder.frames.find((frame) => frame.op === 'error');
        if (errored) {
          throw new Error(
            `purge close rejected for ${thread.threadId}: ${JSON.stringify(errored)}`,
          );
        }
        const snapshot = frames.filter((frame) => frame.op === 'threads').at(-1);
        const entry = snapshot?.threads?.find((t) => t.threadId === thread.threadId);
        if (entry === undefined) {
          discarded = true;
          break;
        }
        if (entry.archived === true) {
          archived = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!archived && !discarded) {
        throw new Error(
          `purge close confirmation never arrived for ${thread.threadId} (${recorder.unparseableCount} unparseable frame(s) observed)`,
        );
      }
      if (discarded) return;
      send({ op: 'delete', threadId: thread.threadId });
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const errored = recorder.frames.find((frame) => frame.op === 'error');
        if (errored) {
          throw new Error(
            `purge delete rejected for ${thread.threadId}: ${JSON.stringify(errored)}`,
          );
        }
        const snapshot = frames.filter((frame) => frame.op === 'threads').at(-1);
        if (snapshot?.threads && !snapshot.threads.some((t) => t.threadId === thread.threadId)) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(
        `purge delete confirmation never arrived for ${thread.threadId} (${recorder.unparseableCount} unparseable frame(s) observed)`,
      );
    });
  }
  const remaining = (await withThreadSocket(port, latestRoster)).filter(
    (thread) => thread.archived !== true,
  );
  if (remaining.length > 0) {
    throw new Error(
      `live threads survived the roster purge: ${remaining.map((t) => t.threadId).join(', ')}`,
    );
  }
}

function writeSeedAgentFile(contentDir: string): void {
  const agentsFile = join(contentDir, '.ok', 'local', 'acp-agents.json');
  mkdirSync(dirname(agentsFile), { recursive: true });
  writeFileSync(
    agentsFile,
    `${JSON.stringify(
      [{ id: SEED_AGENT_ID, name: SEED_AGENT_NAME, command: '/bin/false' }],
      null,
      2,
    )}\n`,
  );
}

async function registerSeedAgentAsDefault(page: Page): Promise<void> {
  await page.addInitScript(
    ({ key, agent }) => {
      window.localStorage.setItem(
        key,
        JSON.stringify({ agents: [agent], defaultKey: `${agent.source}:${agent.id}` }),
      );
    },
    {
      key: REGISTERED_AGENTS_KEY,
      agent: { source: 'custom', id: SEED_AGENT_ID, name: SEED_AGENT_NAME },
    },
  );
}

async function liveThreadCount(port: number): Promise<number> {
  const roster = await withThreadSocket(port, latestRoster);
  return roster.filter((thread) => thread.archived !== true).length;
}

async function seedLiveThread(port: number, contentDir: string): Promise<void> {
  writeSeedAgentFile(contentDir);

  await withThreadSocket(port, async (send, frames) => {
    send({ op: 'create', reqId: 'e2e-seed-1', agent: { source: 'custom', id: SEED_AGENT_ID } });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const created = frames.find(
        (frame) => frame.op === 'created' && frame.reqId === 'e2e-seed-1',
      );
      if (created?.info) return;
      const errored = frames.find((frame) => frame.op === 'error');
      if (errored) throw new Error(`seed create failed: ${JSON.stringify(errored)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('seed create never returned a created frame');
  });
}

function nextRosterDelivery(page: Page, marks?: RouteMark[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('thread socket never delivered its roster')),
      ROSTER_TIMEOUT_MS,
    );
    page.on('websocket', (socket) => {
      if (!socket.url().includes('/collab/thread')) return;
      socket.on('framereceived', (frame) => {
        if (typeof frame.payload !== 'string') return;
        if (!frame.payload.includes('"op":"threads"')) return;
        marks?.push({ route: 'roster-frame', at: Date.now() });
        clearTimeout(timer);
        resolve();
      });
    });
  });
}

function settleAfterRoster(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      }),
  );
}

async function openAppWithRoster(page: Page, path = '/'): Promise<void> {
  const roster = nextRosterDelivery(page);
  await page.goto(path);
  await page.waitForFunction(() => Boolean(window.__acpThreadHarness), null, {
    timeout: BOOT_TIMEOUT_MS,
  });
  await roster;
  await settleAfterRoster(page);
}

function agentsHeaderButton(page: Page): Locator {
  return page.getByTestId(AGENTS_HEADER_BUTTON);
}

async function expectAgentsPanelShown(page: Page, shown: boolean): Promise<void> {
  await expect(agentsHeaderButton(page)).toHaveAttribute('aria-pressed', String(shown), {
    timeout: BOOT_TIMEOUT_MS,
  });
  if (shown) await expect(page.locator(AGENTS_PANEL_MOUNT)).toBeVisible();
  else await expect(page.locator(AGENTS_PANEL_MOUNT)).not.toBeVisible();
}

async function expectFocusInsideAgentsPanel(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (mount) => document.activeElement?.closest(mount) != null,
          AGENTS_PANEL_MOUNT,
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
}

async function openInjectedThread(page: Page, title: string): Promise<void> {
  await page.evaluate((threadTitle) => {
    const harness = window.__acpThreadHarness;
    if (harness === undefined) throw new Error('ACP thread harness is not installed');
    harness.openThread({
      agent: { id: 'header-agents-button', name: 'Header Agent', source: 'registry' },
      title: threadTitle,
    });
  }, title);
}

async function showChatWithInjectedThread(page: Page, title: string): Promise<Locator> {
  await agentsHeaderButton(page).click();
  await expectAgentsPanelShown(page, true);
  await waitForAgentsHostSettled(page);
  await openInjectedThread(page, title);
  const composer = page.locator(AGENTS_PANEL_MOUNT).locator(THREAD_COMPOSER);
  await expect(composer).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  return composer;
}

async function storeAgentsPanelWidth(page: Page, widthPx: number): Promise<void> {
  await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, value), {
    key: AGENTS_PANEL_WIDTH_KEY,
    value: String(widthPx),
  });
}

async function openAgentsPanel(page: Page): Promise<void> {
  const mount = page.locator(AGENTS_PANEL_MOUNT);
  const button = agentsHeaderButton(page);
  await expect(button).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  const revealed = (await button.getAttribute('aria-pressed')) !== 'true';
  if (revealed) await button.click({ timeout: 5_000 });
  await expect(mount).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  if (revealed) await expectFocusInsideAgentsPanel(page);
  await settleAfterRoster(page);
}

async function resizeAgentsPanel(page: Page, targetWidth: number): Promise<void> {
  const mount = page.locator(AGENTS_PANEL_MOUNT);
  const panel = mount.locator('xpath=ancestor::*[@data-slot="resizable-panel"][1]');
  const handle = panel.locator('xpath=preceding-sibling::*[1]');
  await expect(handle).toHaveAttribute('data-slot', 'resizable-handle');
  await handle.focus();
  const currentWidth = await mount.evaluate((element) => element.getBoundingClientRect().width);
  const grows = currentWidth < targetWidth;
  for (let index = 0; index < 20; index += 1) {
    const width = await mount.evaluate((element) => element.getBoundingClientRect().width);
    if (grows ? width >= targetWidth : width <= targetWidth) break;
    await page.keyboard.press(grows ? 'ArrowLeft' : 'ArrowRight');
    await settleAfterRoster(page);
  }
  const observedWidth = await mount.evaluate((element) => element.getBoundingClientRect().width);
  if (grows) expect(observedWidth).toBeGreaterThanOrEqual(targetWidth);
  else expect(observedWidth).toBeLessThanOrEqual(targetWidth);
}

async function dragAgentsPanel(
  page: Page,
  targetWidth: number,
  termination: 'pointerup' | 'pointercancel' = 'pointerup',
): Promise<number> {
  const mount = page.locator(AGENTS_PANEL_MOUNT);
  const panel = mount.locator('xpath=ancestor::*[@data-slot="resizable-panel"][1]');
  const handle = panel.locator('xpath=preceding-sibling::*[1]');
  const [handleBounds, startWidth] = await Promise.all([
    handle.boundingBox(),
    panel.evaluate((element) => element.getBoundingClientRect().width),
  ]);
  expect(handleBounds).not.toBeNull();
  if (handleBounds === null) throw new Error('Agents panel handle has no bounds');
  const startX = handleBounds.x + handleBounds.width / 2;
  const y = handleBounds.y + handleBounds.height / 2;
  const targetX = startX + startWidth - targetWidth;

  await page.mouse.move(startX, y);
  await page.mouse.down();
  await expect(page.locator('[data-dragging="true"]')).toHaveCount(1);
  await page.mouse.move(targetX, y, { steps: 8 });
  const transientWidth = await panel.evaluate((element) => element.getBoundingClientRect().width);

  if (termination === 'pointercancel') {
    await page.evaluate(() => {
      document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }));
    });
  }
  await page.mouse.up();
  await expect(page.locator('[data-dragging="true"]')).toHaveCount(0);
  return transientWidth;
}

async function agentsPanelWidth(page: Page): Promise<number> {
  return page
    .locator(AGENTS_PANEL_MOUNT)
    .locator('xpath=ancestor::*[@data-slot="resizable-panel"][1]')
    .evaluate((element) => element.getBoundingClientRect().width);
}

async function persistedAgentsPanelWidth(page: Page): Promise<number | null> {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : Number.parseInt(raw, 10);
  }, AGENTS_PANEL_WIDTH_KEY);
}

async function waitForAgentsHostSettled(page: Page): Promise<void> {
  await expect(page.locator(`${AGENTS_PANEL_MOUNT} [role="tablist"]`)).toHaveCount(1, {
    timeout: BOOT_TIMEOUT_MS,
  });
}

async function settleAgentsHostAfterReload(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean(window.__acpThreadHarness), null, {
    timeout: BOOT_TIMEOUT_MS,
  });
  await waitForAgentsHostSettled(page);
}

async function closeAgentsPanel(page: Page): Promise<void> {
  await expect(agentsHeaderButton(page)).toHaveAttribute('aria-pressed', 'true', {
    timeout: BOOT_TIMEOUT_MS,
  });
  await agentsHeaderButton(page).click({ timeout: BOOT_TIMEOUT_MS });
  await expectAgentsPanelShown(page, false);
  await settleAfterRoster(page);
}

async function expectPersistedPanelLevel(page: Page, level: boolean): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate((key) => {
          const raw = window.localStorage.getItem(key);
          if (raw === null) return null;
          const record = JSON.parse(raw) as Record<string, unknown>;
          return typeof record.agentPanelVisible === 'boolean' ? record.agentPanelVisible : null;
        }, AGENTS_ORDER_STORAGE_KEY),
      { timeout: BOOT_TIMEOUT_MS },
    )
    .toBe(level);
}

async function reloadAndSettle(page: Page, marks?: RouteMark[]): Promise<void> {
  const roster = nextRosterDelivery(page, marks);
  await page.reload();
  await roster;
  await settleAfterRoster(page);
}

test.setTimeout(180_000);

test.describe('agents panel resize', () => {
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => window.__acpThreadHarness?.reset());
  });

  test('the panel follows the pointer below its settled minimum and reverses before release', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await stubAgentCatalog(page);
    await openAppWithRoster(page);
    await page.evaluate(() => {
      const harness = window.__acpThreadHarness;
      if (harness === undefined) throw new Error('ACP thread harness is not installed');
      harness.openThread({
        agent: { id: 'resize-fluid', name: 'Resize Agent', source: 'registry' },
        title: 'Resize conversation',
      });
    });
    await openAgentsPanel(page);

    const mount = page.locator(AGENTS_PANEL_MOUNT);
    const panel = mount.locator('xpath=ancestor::*[@data-slot="resizable-panel"][1]');
    const handle = panel.locator('xpath=preceding-sibling::*[1]');
    const handleBounds = await handle.boundingBox();
    expect(handleBounds).not.toBeNull();
    if (handleBounds === null) return;

    const startWidth = await panel.evaluate((element) => element.getBoundingClientRect().width);
    expect(startWidth).toBeGreaterThan(420);
    expect(startWidth).toBeLessThan(540);
    const handleX = handleBounds.x + handleBounds.width / 2;
    const handleY = handleBounds.y + handleBounds.height / 2;

    await page.mouse.move(handleX, handleY);
    await page.mouse.down();
    await expect(page.locator('[data-dragging="true"]')).toHaveCount(1);

    await page.mouse.move(handleX + 145, handleY, { steps: 8 });
    const firstShrinkWidth = await panel.evaluate(
      (element) => element.getBoundingClientRect().width,
    );
    expect(firstShrinkWidth).toBeLessThan(startWidth - 100);

    await page.mouse.move(handleX + 190, handleY, { steps: 4 });
    const belowMinimumWidth = await panel.evaluate(
      (element) => element.getBoundingClientRect().width,
    );
    expect(belowMinimumWidth).toBeGreaterThan(200);
    expect(belowMinimumWidth).toBeLessThan(320);

    await page.mouse.move(handleX + 110, handleY, { steps: 6 });
    const reversedWidth = await panel.evaluate((element) => element.getBoundingClientRect().width);
    expect(reversedWidth).toBeGreaterThan(belowMinimumWidth + 50);
    expect(reversedWidth).toBeLessThan(startWidth);

    await page.mouse.up();
    await expect(page.locator('[data-dragging="true"]')).toHaveCount(0);
    await expect(mount).toBeVisible();
    await expect.poll(() => agentsPanelWidth(page)).toBeCloseTo(reversedWidth, -1);
    await expect.poll(() => persistedAgentsPanelWidth(page)).toBeCloseTo(reversedWidth, -1);
  });

  test('keyboard reveal of an empty agents panel keeps focus in the revealed surface', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await stubAgentCatalog(page);
    await openAppWithRoster(page);
    await page.evaluate(() => window.__acpThreadHarness?.reset());
    await settleAfterRoster(page);

    const mount = page.locator(AGENTS_PANEL_MOUNT);
    const button = agentsHeaderButton(page);
    await expect(button).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
    if ((await button.getAttribute('aria-pressed')) === 'true') await button.click();
    await expectAgentsPanelShown(page, false);

    await button.focus();
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter');
    await expectAgentsPanelShown(page, true);
    await waitForAgentsHostSettled(page);
    await expect(mount.getByRole('tab')).toHaveCount(0);
    await expectFocusInsideAgentsPanel(page);
  });

  test('release bands, cancellation, keyboard resizing, reveal, and reload preserve the settled contract', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await stubAgentCatalog(page);
    await openAppWithRoster(page);
    await page.evaluate(() => {
      const harness = window.__acpThreadHarness;
      if (harness === undefined) throw new Error('ACP thread harness is not installed');
      harness.openThread({
        agent: { id: 'resize-settlement', name: 'Resize Agent', source: 'registry' },
        title: 'Resize settlement conversation',
      });
    });
    await openAgentsPanel(page);

    const middleTransientWidth = await dragAgentsPanel(page, 250);
    expect(middleTransientWidth).toBeGreaterThan(200);
    expect(middleTransientWidth).toBeLessThan(320);
    await expect.poll(() => agentsPanelWidth(page)).toBeCloseTo(320, -1);
    await expect.poll(() => persistedAgentsPanelWidth(page)).toBe(320);

    await dragAgentsPanel(page, 520);
    const preferredWidth = await agentsPanelWidth(page);
    expect(preferredWidth).toBeGreaterThan(500);
    expect(preferredWidth).toBeLessThan(540);
    await expect.poll(() => persistedAgentsPanelWidth(page)).toBeCloseTo(preferredWidth, -1);

    const cancelledTransientWidth = await dragAgentsPanel(page, 240, 'pointercancel');
    expect(cancelledTransientWidth).toBeGreaterThan(200);
    expect(cancelledTransientWidth).toBeLessThan(320);
    await expect.poll(() => agentsPanelWidth(page)).toBeCloseTo(preferredWidth, -1);
    await expect.poll(() => persistedAgentsPanelWidth(page)).toBeCloseTo(preferredWidth, -1);

    const mount = page.locator(AGENTS_PANEL_MOUNT);
    const panel = mount.locator('xpath=ancestor::*[@data-slot="resizable-panel"][1]');
    const handle = panel.locator('xpath=preceding-sibling::*[1]');
    await handle.focus();
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press('ArrowRight');
      await settleAfterRoster(page);
    }
    await expect(handle).toBeFocused();
    await expect.poll(() => agentsPanelWidth(page)).toBeCloseTo(320, -1);
    await expect.poll(() => persistedAgentsPanelWidth(page)).toBeCloseTo(preferredWidth, -1);

    const closeTransientWidth = await dragAgentsPanel(page, 100);
    expect(closeTransientWidth).toBeLessThan(160);
    await expectAgentsPanelShown(page, false);
    await expect.poll(() => persistedAgentsPanelWidth(page)).toBeCloseTo(preferredWidth, -1);

    await openAgentsPanel(page);
    await expect.poll(() => agentsPanelWidth(page)).toBeCloseTo(preferredWidth, -1);
    await reloadAndSettle(page);
    await expect(mount).toBeVisible();
    await expect.poll(() => agentsPanelWidth(page)).toBeCloseTo(preferredWidth, -1);
  });
});

test.describe('header Agents button', () => {
  test.afterEach(async ({ page, workerServer }) => {
    await page.evaluate(() => window.__acpThreadHarness?.reset());
    await purgeLiveThreads(workerServer.port);
  });

  test('clicking Agents while chat is hidden shows it at its stored width with focus inside it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await storeAgentsPanelWidth(page, STORED_AGENTS_PANEL_WIDTH_PX);
    await stubAgentCatalog(page);
    await openAppWithRoster(page);
    await expectAgentsPanelShown(page, false);

    await agentsHeaderButton(page).click();
    await expectAgentsPanelShown(page, true);
    await expect.poll(() => agentsPanelWidth(page)).toBeCloseTo(STORED_AGENTS_PANEL_WIDTH_PX, -1);
    await expectFocusInsideAgentsPanel(page);
  });

  test('an empty chat shown from Agents starts exactly one conversation', async ({
    page,
    workerServer,
  }) => {
    await purgeLiveThreads(workerServer.port);
    writeSeedAgentFile(workerServer.contentDir);
    await registerSeedAgentAsDefault(page);
    await page.setViewportSize({ width: 1600, height: 900 });
    await stubAgentCatalog(page);
    await openAppWithRoster(page);
    await expectAgentsPanelShown(page, false);
    const tabs = page.locator(AGENTS_PANEL_MOUNT).getByRole('tab');

    await agentsHeaderButton(page).click();
    await expectAgentsPanelShown(page, true);
    await expect(tabs).toHaveCount(1, { timeout: ROSTER_TIMEOUT_MS });
    await expect
      .poll(() => liveThreadCount(workerServer.port), { timeout: ROSTER_TIMEOUT_MS })
      .toBe(1);

    await agentsHeaderButton(page).click();
    await expectAgentsPanelShown(page, false);
    await agentsHeaderButton(page).click();
    await expectAgentsPanelShown(page, true);
    await expect(tabs).toHaveCount(1);
    expect(await liveThreadCount(workerServer.port)).toBe(1);
  });

  test('hiding from Agents keeps focus on the button and the chat draft, by click, Enter or Space', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await stubAgentCatalog(page);
    await openAppWithRoster(page);
    const button = agentsHeaderButton(page);
    const composer = await showChatWithInjectedThread(page, 'Header draft conversation');
    await composer.click();
    await page.keyboard.type(HEADER_DRAFT);
    await expect(composer).toHaveText(HEADER_DRAFT);

    await button.click();
    await expectAgentsPanelShown(page, false);
    await expect(button).toBeFocused();
    await button.click();
    await expectAgentsPanelShown(page, true);
    await expect(composer).toHaveText(HEADER_DRAFT);

    for (const key of ['Enter', 'Space'] as const) {
      await button.focus();
      await page.keyboard.press(key);
      await expectAgentsPanelShown(page, false);
      await expect(button).toBeFocused();
      await page.keyboard.press(key);
      await expectAgentsPanelShown(page, true);
      await expectFocusInsideAgentsPanel(page);
      await expect(composer).toHaveText(HEADER_DRAFT);
    }
  });

  test('with text selected, Agents only toggles chat while Cmd/Ctrl+L stages the selection', async ({
    page,
    api,
  }) => {
    const docName = `header-agents-selection-${test.info().workerIndex}`;
    await api.seedDocs([{ name: docName, markdown: `# ${docName}\n\n${SELECTION_DOC_TEXT}\n` }]);
    await page.setViewportSize({ width: 1600, height: 900 });
    await stubAgentCatalog(page);
    await openAppWithRoster(page, `/#/${docName}`);
    const button = agentsHeaderButton(page);
    const composer = await showChatWithInjectedThread(page, 'Selection destination');
    const paragraph = page
      .locator('.ProseMirror:not(.composer-prosemirror) p')
      .filter({ hasText: SELECTION_DOC_TEXT });
    const selectionPublished = page.getByTestId('editor-footer-selected-label');
    await expect(composer).toHaveText('');
    await button.click();
    await expectAgentsPanelShown(page, false);

    await paragraph.selectText();
    await expect(selectionPublished).toBeVisible();
    await button.click();
    await expectAgentsPanelShown(page, true);
    await expect(composer).toHaveText('');
    await button.click();
    await expectAgentsPanelShown(page, false);

    await paragraph.selectText();
    await expect(selectionPublished).toBeVisible();
    await page.keyboard.press('ControlOrMeta+l');
    await expectAgentsPanelShown(page, true);
    await expect(composer).toContainText(SELECTION_DOC_TEXT);
  });
});

test.describe('chat history navigation', () => {
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => window.__acpThreadHarness?.reset());
  });

  test('chat history unifies live navigation with the selected tab', async ({ page }) => {
    await stubAgentCatalog(page);
    await openAppWithRoster(page);
    const threadIds = await page.evaluate(() => {
      const harness = window.__acpThreadHarness;
      if (harness === undefined) throw new Error('ACP thread harness is not installed');
      return [
        harness.openThread({
          agent: { id: 'history-a', name: 'First Agent', source: 'registry' },
          title: 'Alpha planning conversation',
        }),
        harness.openThread({
          agent: { id: 'history-b', name: 'Second Agent', source: 'registry' },
          title: 'Beta implementation conversation',
          status: 'running',
        }),
      ];
    });

    await openAgentsPanel(page);
    const panel = page.locator(AGENTS_PANEL_MOUNT);
    const tabs = panel.getByRole('tab');
    await expect(tabs).toHaveCount(2);
    const initialTitles = await tabs.allTextContents();

    await panel.getByRole('button', { name: 'Chat history' }).click();
    const alphaRow = page.locator(`[data-testid="agent-thread-history-open-${threadIds[0]}"]`);
    const betaRow = page.locator(`[data-testid="agent-thread-history-open-${threadIds[1]}"]`);
    await expect(alphaRow).not.toContainText('First Agent');
    await expect(betaRow).not.toContainText('Running');
    await expect(betaRow).toHaveAttribute('aria-current', 'true');
    const alphaListItem = alphaRow.locator('xpath=..');
    await expectContrast(alphaRow.locator('span').last(), alphaListItem, 4.5);
    await expectContrast(betaRow.locator('span').last(), betaRow.locator('xpath=..'), 4.5);
    const accessibility = await new AxeBuilder({ page })
      .include('[data-testid="agent-thread-history-panel"]')
      .analyze();
    expect(accessibility.violations).toEqual([]);
    await alphaRow.hover();
    await expectContrast(alphaRow, alphaListItem, 4.5);
    const alphaRename = page.getByTestId(`agent-thread-history-rename-${threadIds[0]}`);
    await expectContrast(alphaRename, alphaListItem, 4.5);
    await alphaRename.hover();
    await expectContrast(alphaRename, alphaListItem, 4.5);
    await expectContrast(betaRow, betaRow.locator('xpath=..'), 4.5);
    await switchColorThemeAndSettleFade(page, 'solarized');
    await alphaRow.hover();
    await expectContrast(alphaRow, alphaListItem, 4.5);
    await expectContrast(alphaRename, alphaListItem, 4.5);
    await alphaRename.hover();
    await expectContrast(alphaRename, alphaListItem, 4.5);
    await expectContrast(betaRow, betaRow.locator('xpath=..'), 4.5);
    const solarizedAccessibility = await new AxeBuilder({ page })
      .include('[data-testid="agent-thread-history-panel"]')
      .analyze();
    expect(solarizedAccessibility.violations).toEqual([]);
    await switchColorThemeAndSettleFade(page, 'monokai');
    const monokaiAccessibility = await new AxeBuilder({ page })
      .include('[data-testid="agent-thread-history-panel"]')
      .analyze();
    expect(monokaiAccessibility.violations).toEqual([]);

    await alphaRow.click();
    await expect(panel.getByRole('tab', { name: /Alpha planning conversation/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(tabs).toHaveText(initialTitles);

    if ((await page.getByTestId('agent-thread-history-panel').count()) === 0) {
      await panel.getByRole('button', { name: 'Chat history' }).click();
    }
    await expect(alphaRow).toHaveAttribute('aria-current', 'true');
  });

  test('empty chat history fills and centers within the panel body', async ({ page }) => {
    await stubAgentCatalog(page);
    await openAppWithRoster(page);
    await page.evaluate(() => {
      const harness = window.__acpThreadHarness;
      if (harness === undefined) throw new Error('ACP thread harness is not installed');
      harness.openThread({
        agent: { id: 'empty-history', name: 'Empty History', source: 'registry' },
      });
    });
    await openAgentsPanel(page);
    await page.evaluate(() => window.__acpThreadHarness?.reset());
    const panel = page.locator(AGENTS_PANEL_MOUNT);
    await expect(panel.getByRole('tab')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Chat history' }).click();

    const history = page.getByTestId('agent-thread-history-panel');
    const content = history.locator('[data-sidebar="content"]');
    const status = history.getByRole('status');
    const heading = status.getByRole('heading', { name: 'No chats yet.' });
    const [contentBox, statusBox, headingBox] = await Promise.all([
      content.boundingBox(),
      status.boundingBox(),
      heading.boundingBox(),
    ]);
    expect(contentBox).not.toBeNull();
    expect(statusBox).not.toBeNull();
    expect(headingBox).not.toBeNull();
    if (contentBox === null || statusBox === null || headingBox === null) return;
    expect(Math.abs(statusBox.y - contentBox.y)).toBeLessThanOrEqual(2);
    expect(Math.abs(statusBox.height - contentBox.height)).toBeLessThanOrEqual(4);
    const contentCenter = contentBox.y + contentBox.height / 2;
    const headingCenter = headingBox.y + headingBox.height / 2;
    expect(Math.abs(headingCenter - contentCenter)).toBeLessThanOrEqual(2);
  });

  test('chat history searches titles and groups conversations by local date', async ({ page }) => {
    await stubAgentCatalog(page);
    await openAppWithRoster(page);
    await page.evaluate(() => {
      const harness = window.__acpThreadHarness;
      if (harness === undefined) throw new Error('ACP thread harness is not installed');
      const now = Date.now();
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(23, 59, 0, 0);
      harness.openThread({
        threadId: 'history-live-architecture',
        agent: { id: 'history-live', name: 'Live Agent', source: 'registry' },
        title: 'Architecture planning',
        status: 'running',
      });
      harness.openThread({
        threadId: 'history-archived-architecture',
        agent: { id: 'history-archive', name: 'Archive Agent', source: 'registry' },
        title: 'Past ARCHITECTURE review',
        status: 'exited',
      });
      harness.openThread({
        threadId: 'history-release',
        agent: { id: 'history-release', name: 'Release Agent', source: 'registry' },
        title: 'Release checklist',
        status: 'ready',
      });
      harness.frame({
        op: 'threads',
        threads: [
          {
            threadId: 'history-live-architecture',
            agent: { id: 'history-live', name: 'Live Agent', source: 'registry' },
            title: 'Architecture planning',
            status: 'running',
            createdAt: now - 2_000,
            lastActivityAt: now - 1_000,
            modes: null,
            configOptions: null,
            lastSeq: -1,
            archived: false,
          },
          {
            threadId: 'history-archived-architecture',
            agent: { id: 'history-archive', name: 'Archive Agent', source: 'registry' },
            title: 'Past ARCHITECTURE review',
            status: 'exited',
            createdAt: yesterday.getTime(),
            lastActivityAt: yesterday.getTime(),
            modes: null,
            configOptions: null,
            lastSeq: -1,
            archived: true,
          },
          {
            threadId: 'history-release',
            agent: { id: 'history-release', name: 'Release Agent', source: 'registry' },
            title: 'Release checklist',
            status: 'ready',
            createdAt: now - 4_000,
            lastActivityAt: now - 3_000,
            modes: null,
            configOptions: null,
            lastSeq: -1,
            archived: false,
          },
        ],
      });
    });

    await openAgentsPanel(page);
    const panel = page.locator(AGENTS_PANEL_MOUNT);
    await expect(panel.getByRole('tab')).toHaveCount(2);
    await panel.getByRole('button', { name: 'Chat history' }).click();
    await expect(page.getByRole('list', { name: 'Today' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Older' })).toBeVisible();

    await page.getByRole('searchbox', { name: 'Search chat history' }).fill('  aRcHi  ');

    await expect(
      page.getByTestId('agent-thread-history-open-history-live-architecture'),
    ).toBeVisible();
    await expect(
      page.getByTestId('agent-thread-history-open-history-archived-architecture'),
    ).toBeVisible();
    await expect(page.getByTestId('agent-thread-history-open-history-release')).toHaveCount(0);
    const archivedRow = page.getByTestId('agent-thread-history-open-history-archived-architecture');
    const archivedListItem = archivedRow.locator('xpath=..');
    await expectContrast(archivedRow.locator('span').last(), archivedListItem, 4.5);
    await archivedRow.hover();
    const archivedRename = page.getByTestId(
      'agent-thread-history-rename-history-archived-architecture',
    );
    await expectContrast(archivedRename, archivedListItem, 4.5);
    await archivedRename.hover();
    await expectContrast(archivedRename, archivedListItem, 4.5);
    const archivedDelete = page.getByTestId(
      'agent-thread-history-delete-history-archived-architecture',
    );
    await expect(archivedDelete).not.toHaveAttribute('aria-disabled');
    await archivedDelete.hover();
    await expectContrast(archivedDelete, archivedListItem, 3);
    await switchColorThemeAndSettleFade(page, 'solarized');
    await archivedRow.hover();
    await expectContrast(archivedRename, archivedListItem, 4.5);
    await archivedDelete.hover();
    await expectContrast(archivedDelete, archivedListItem, 3);
    const accessibility = await new AxeBuilder({ page })
      .include('[data-testid="agent-thread-history-panel"]')
      .analyze();
    expect(accessibility.violations).toEqual([]);
  });

  test('chat history renders in dark, pseudo-locale, RTL, and reduced-motion modes', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.addInitScript(() => window.localStorage.setItem('ok-theme-v1', 'dark'));
    await stubAgentCatalog(page);

    const roster = nextRosterDelivery(page);
    await page.goto('/?lang=pseudo');
    await page.waitForFunction(() => Boolean(window.__acpThreadHarness), null, {
      timeout: BOOT_TIMEOUT_MS,
    });
    await roster;
    await settleAfterRoster(page);
    await page.evaluate(() => {
      const harness = window.__acpThreadHarness;
      if (harness === undefined) throw new Error('ACP thread harness is not installed');
      const threadId = harness.openThread({
        threadId: 'history-render-matrix',
        agent: { id: 'pseudo-dark', name: 'Pseudo Agent', source: 'registry' },
        title: 'A deliberately long archived conversation title for the RTL action overlay',
        status: 'exited',
      });
      const now = Date.now();
      harness.frame({
        op: 'threads',
        threads: [
          {
            threadId,
            agent: { id: 'pseudo-dark', name: 'Pseudo Agent', source: 'registry' },
            title: 'A deliberately long archived conversation title for the RTL action overlay',
            status: 'exited',
            createdAt: now,
            lastActivityAt: now,
            modes: null,
            configOptions: null,
            lastSeq: -1,
            archived: true,
          },
        ],
      });
    });
    const mount = page.locator(AGENTS_PANEL_MOUNT);
    await openAgentsPanel(page);
    await mount.getByTestId('agent-thread-history').click();
    const historyPanel = page.getByTestId('agent-thread-history-panel');
    await expect(historyPanel).toBeVisible();
    await expect(page.locator('html')).toHaveClass(/dark/);
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
      true,
    );
    const pseudoPlaceholder = await historyPanel
      .locator('input[name="chat-history-search"]')
      .getAttribute('placeholder');
    expect(pseudoPlaceholder).not.toBe('Search chats');
    await page.evaluate(() => {
      document.documentElement.dir = 'rtl';
    });
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const row = page.getByTestId('agent-thread-history-open-history-render-matrix');
    const listItem = row.locator('xpath=..');
    const timestamp = row.locator('span').last();
    await expectContrast(timestamp, listItem, 4.5);
    await listItem.hover({ position: { x: 8, y: 18 } });
    await expectContrast(row, listItem, 4.5);
    await expect(timestamp).toHaveCSS('transition-duration', '0s');
    const rename = page.getByTestId('agent-thread-history-rename-history-render-matrix');
    await listItem.hover();
    expect(await rename.evaluate((element) => element.matches(':hover'))).toBe(false);
    await expectContrast(rename, listItem, 4.5);
    await rename.hover();
    await expectContrast(rename, listItem, 4.5);
    const deleteButton = page.getByTestId('agent-thread-history-delete-history-render-matrix');
    await deleteButton.hover();
    await expectContrast(deleteButton, listItem, 3);
    const listItemBounds = await listItem.boundingBox();
    if (listItemBounds === null) {
      throw new Error('Expected the RTL history row to have layout bounds');
    }
    const renameBounds = await rename.boundingBox();
    if (renameBounds === null) {
      throw new Error('Expected the RTL history rename action to have layout bounds');
    }
    expect(renameBounds.x - listItemBounds.x).toBeLessThan(52);
    const panelAccessibility = await new AxeBuilder({ page })
      .include('[data-testid="agent-thread-history-panel"]')
      .analyze();
    expect(panelAccessibility.violations).toEqual([]);
    await deleteButton.click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    const dialogAccessibility = await new AxeBuilder({ page })
      .include('[role="alertdialog"]')
      .analyze();
    expect(dialogAccessibility.violations).toEqual([]);
  });

  test('shrinking a docked history view closes history before the active chat', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await stubAgentCatalog(page);
    await openAppWithRoster(page);
    await page.evaluate(() => {
      const harness = window.__acpThreadHarness;
      if (harness === undefined) throw new Error('ACP thread harness is not installed');
      harness.openThread({
        threadId: 'history-responsive-alpha',
        agent: { id: 'responsive-alpha', name: 'First Agent', source: 'registry' },
        title: 'Alpha planning conversation with a deliberately long translated-width title',
      });
      harness.openThread({
        threadId: 'history-responsive-beta',
        agent: { id: 'responsive-beta', name: 'Second Agent', source: 'registry' },
        title: 'Beta implementation conversation',
      });
    });
    await openAgentsPanel(page);
    await resizeAgentsPanel(page, 700);

    const mount = page.locator(AGENTS_PANEL_MOUNT);
    await mount.getByRole('button', { name: 'Chat history' }).click();
    const history = page.getByTestId('agent-thread-history-panel');
    await expect(history).toHaveAttribute('data-history-mode', 'docked');
    const historySurfaceBounds = await page
      .getByTestId('agent-thread-history-surface')
      .boundingBox();
    expect(historySurfaceBounds?.width).toBeCloseTo(HISTORY_PANEL_WIDTH_PX, 1);
    await history.getByRole('searchbox', { name: 'Search chat history' }).fill('Alpha');
    await page.getByTestId('agent-thread-history-open-history-responsive-alpha').click();
    await expect(history).toBeVisible();
    await expect(
      mount.getByRole('tab', {
        name: /Alpha planning conversation with a deliberately long translated-width title/,
      }),
    ).toHaveAttribute('aria-selected', 'true');

    await resizeAgentsPanel(page, 500);

    await expect(history).toHaveCount(0);
    await expect(mount.getByTestId('agent-panel-session-surface')).not.toHaveAttribute('inert');
    await expect(
      mount.getByRole('tab', {
        name: /Alpha planning conversation with a deliberately long translated-width title/,
      }),
    ).toHaveAttribute('aria-selected', 'true');
  });

  test('a covered agent pane dragged to zero width reads off and one Agents click brings it back at its width', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await stubAgentCatalog(page);
    await openAppWithRoster(page);
    await page.evaluate(() => {
      const harness = window.__acpThreadHarness;
      if (harness === undefined) throw new Error('ACP thread harness is not installed');
      harness.openThread({
        threadId: 'history-drag-close',
        agent: { id: 'drag-close', name: 'First Agent', source: 'registry' },
        title: 'Drag close conversation',
      });
    });
    await openAgentsPanel(page);
    await dragAgentsPanel(page, 500);
    expect(await agentsPanelWidth(page)).toBeLessThan(HISTORY_DOCKED_MIN_PANE_WIDTH_PX);

    const mount = page.locator(AGENTS_PANEL_MOUNT);
    await mount.getByRole('button', { name: 'Chat history' }).click();
    await expect(page.getByTestId('agent-thread-history-panel')).toHaveAttribute(
      'data-history-mode',
      'cover',
    );
    const history = page.getByTestId('agent-thread-history-panel');
    const historyBounds = await history.boundingBox();
    const mountBounds = await mount.boundingBox();
    expect(historyBounds).not.toBeNull();
    expect(mountBounds).not.toBeNull();
    expect(Math.abs((historyBounds?.x ?? 0) - (mountBounds?.x ?? 0))).toBeLessThanOrEqual(2);
    expect(Math.abs((historyBounds?.y ?? 0) - (mountBounds?.y ?? 0))).toBeLessThanOrEqual(2);
    expect(Math.abs((historyBounds?.width ?? 0) - (mountBounds?.width ?? 0))).toBeLessThanOrEqual(
      2,
    );
    expect(Math.abs((historyBounds?.height ?? 0) - (mountBounds?.height ?? 0))).toBeLessThanOrEqual(
      2,
    );

    await history.getByRole('searchbox', { name: 'Search chat history' }).focus();
    for (let index = 0; index < 10; index += 1) {
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(
          () =>
            document.activeElement?.closest('[data-testid="agent-panel-session-surface"]') != null,
        ),
      ).toBe(false);
    }

    await history.getByRole('button', { name: 'Back' }).click();
    await expect(history).toHaveCount(0);
    await expect(mount.getByRole('button', { name: 'Chat history' })).toBeFocused();
    await mount.getByRole('button', { name: 'Chat history' }).click();
    await expect(history).toHaveAttribute('data-history-mode', 'cover');

    const panel = mount.locator('xpath=ancestor::*[@data-slot="resizable-panel"][1]');
    const handle = panel.locator('xpath=preceding-sibling::*[1]');
    const handleBounds = await handle.boundingBox();
    expect(handleBounds).not.toBeNull();
    const handleX = (handleBounds?.x ?? 0) + (handleBounds?.width ?? 0) / 2;
    const handleY = (handleBounds?.y ?? 0) + (handleBounds?.height ?? 0) / 2;
    const widthBeforeDrag = await agentsPanelWidth(page);
    await page.mouse.move(handleX, handleY);
    await page.mouse.down();
    await page.mouse.move(1598, handleY, { steps: 10 });
    await page.mouse.up();

    await expect(page.locator('[data-dragging="true"]')).toHaveCount(0);
    await expectAgentsPanelShown(page, false);
    await agentsHeaderButton(page).click();
    await expectAgentsPanelShown(page, true);
    await expect.poll(() => agentsPanelWidth(page)).toBeCloseTo(widthBeforeDrag, -1);
    await expect(mount.getByRole('tab', { name: 'Drag close conversation' })).toBeVisible();
  });
});

test.describe('agents panel reload visibility level', () => {
  test.afterEach(async ({ workerServer }) => {
    await purgeLiveThreads(workerServer.port);
  });

  test('a panel closed before a roster-delayed reload stays closed after it (level written by real open and close clicks on the header Agents button and asserted in localStorage before reload; storage-coercion edge cases are pinned by the co-located DOM suites)', async ({
    page,
    workerServer,
  }) => {
    await purgeLiveThreads(workerServer.port);
    await seedLiveThread(workerServer.port, workerServer.contentDir);
    await stubAgentCatalog(page);
    await openAppWithRoster(page);

    await openAgentsPanel(page);
    await expectPersistedPanelLevel(page, true);
    await closeAgentsPanel(page);
    await expectPersistedPanelLevel(page, false);

    const marks: RouteMark[] = [];
    await page.route(servedModuleRoute(SESSIONS_HOST_SOURCE), async (route) => {
      await route.continue();
      marks.push({ route: 'sessions-chunk-response', at: Date.now() });
    });
    await page.route(CONFIG_RESPONSE_GLOB, async (route) => {
      await waitForRouteMark(
        marks,
        'sessions-chunk-response',
        'sessions chunk never preceded the config response',
      );
      await route.continue();
      marks.push({ route: 'config-response', at: Date.now() });
    });

    await reloadAndSettle(page, marks);

    await expect
      .poll(() => observedOrder(marks), { timeout: BOOT_TIMEOUT_MS })
      .toEqual(['sessions-chunk-response', 'config-response', 'roster-frame']);

    await settleAgentsHostAfterReload(page);

    await expectAgentsPanelShown(page, false);
  });

  test('a panel closed before a roster-first reload stays closed and a later thread still reveals (level written by real open and close clicks on the header Agents button and asserted in localStorage before reload; storage-coercion edge cases are pinned by the co-located DOM suites)', async ({
    page,
    workerServer,
  }) => {
    await purgeLiveThreads(workerServer.port);
    await seedLiveThread(workerServer.port, workerServer.contentDir);
    await stubAgentCatalog(page);
    await openAppWithRoster(page);

    await openAgentsPanel(page);
    await expectPersistedPanelLevel(page, true);
    await closeAgentsPanel(page);
    await expectPersistedPanelLevel(page, false);

    const marks: RouteMark[] = [];
    await page.route(servedModuleRoute(SESSIONS_HOST_SOURCE), async (route) => {
      await waitForRouteMark(
        marks,
        'roster-frame',
        'roster frame never preceded the sessions chunk',
      );
      await route.continue();
      marks.push({ route: 'sessions-chunk-response', at: Date.now() });
    });

    await reloadAndSettle(page, marks);

    await expect
      .poll(() => observedOrder(marks), { timeout: BOOT_TIMEOUT_MS })
      .toEqual(['roster-frame', 'sessions-chunk-response']);

    await settleAgentsHostAfterReload(page);

    await expectAgentsPanelShown(page, false);

    await page.evaluate(() => {
      const harness = window.__acpThreadHarness;
      if (harness === undefined) throw new Error('ACP thread harness is not installed');
      harness.openThread({
        agent: { id: 'late-arrival-agent', name: 'Late Arrival', source: 'registry' },
        title: 'Late arrival thread',
      });
    });

    await expect(page.locator(AGENTS_PANEL_MOUNT)).toBeVisible({ timeout: ROSTER_TIMEOUT_MS });
  });

  test('a panel open before a natural reload stays open after it (level written by a real open click and asserted in localStorage before reload; storage-coercion edge cases are pinned by the co-located DOM suites)', async ({
    page,
    workerServer,
  }) => {
    await purgeLiveThreads(workerServer.port);
    await seedLiveThread(workerServer.port, workerServer.contentDir);
    await stubAgentCatalog(page);
    await openAppWithRoster(page);

    await openAgentsPanel(page);
    await expectPersistedPanelLevel(page, true);

    await reloadAndSettle(page);

    await expectAgentsPanelShown(page, true);
  });

  test('a panel hidden with the header Agents button stays hidden after a reload, with the button not pressed', async ({
    page,
    workerServer,
  }) => {
    await purgeLiveThreads(workerServer.port);
    await seedLiveThread(workerServer.port, workerServer.contentDir);
    await stubAgentCatalog(page);
    await openAppWithRoster(page);
    await expectAgentsPanelShown(page, false);

    await agentsHeaderButton(page).click();
    await expectAgentsPanelShown(page, true);
    await expectPersistedPanelLevel(page, true);
    await agentsHeaderButton(page).click();
    await expectAgentsPanelShown(page, false);
    await expectPersistedPanelLevel(page, false);

    await reloadAndSettle(page);
    await settleAgentsHostAfterReload(page);

    await expectAgentsPanelShown(page, false);
  });

  test('a panel shown with the header Agents button stays shown after a reload, with the button pressed', async ({
    page,
    workerServer,
  }) => {
    await purgeLiveThreads(workerServer.port);
    await seedLiveThread(workerServer.port, workerServer.contentDir);
    await stubAgentCatalog(page);
    await openAppWithRoster(page);
    await expectAgentsPanelShown(page, false);

    await agentsHeaderButton(page).click();
    await expectAgentsPanelShown(page, true);
    await expectPersistedPanelLevel(page, true);

    await reloadAndSettle(page);
    await settleAgentsHostAfterReload(page);

    await expectAgentsPanelShown(page, true);
  });

  test('a panel open before a roster-first reload stays open after it (level written by a real open click and asserted in localStorage before reload; storage-coercion edge cases are pinned by the co-located DOM suites)', async ({
    page,
    workerServer,
  }) => {
    await purgeLiveThreads(workerServer.port);
    await seedLiveThread(workerServer.port, workerServer.contentDir);
    await stubAgentCatalog(page);
    await openAppWithRoster(page);

    await openAgentsPanel(page);
    await expectPersistedPanelLevel(page, true);

    const marks: RouteMark[] = [];
    await page.route(servedModuleRoute(SESSIONS_HOST_SOURCE), async (route) => {
      await waitForRouteMark(
        marks,
        'roster-frame',
        'roster frame never preceded the sessions chunk',
      );
      await route.continue();
      marks.push({ route: 'sessions-chunk-response', at: Date.now() });
    });

    await reloadAndSettle(page, marks);

    await expect
      .poll(() => observedOrder(marks), { timeout: BOOT_TIMEOUT_MS })
      .toEqual(['roster-frame', 'sessions-chunk-response']);

    await settleAgentsHostAfterReload(page);

    await expectAgentsPanelShown(page, true);
  });
});
