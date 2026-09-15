import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

const AGENTS_PANEL_MOUNT = '[data-agents-panel-mount]';
const AGENTS_REVEAL_TAB = '[data-terminal-reveal="right"]';
const COLLAPSE_AGENT_PANEL_BUTTON = 'Collapse agent panel';
const SESSIONS_CHUNK_GLOB = '**/src/components/SessionsHost*';
const CONFIG_RESPONSE_GLOB = '**/api/config';
const AGENTS_ORDER_STORAGE_KEY = 'ok-agent-session-order-v1';
const SEED_AGENT_ID = 'panel-level-fixture-agent';
const BOOT_TIMEOUT_MS = 30_000;
const ROSTER_TIMEOUT_MS = 30_000;
const EMPTY_AGENT_CATALOG = { agents: [], stale: false, maxThreads: 8 };

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

async function seedLiveThread(port: number, contentDir: string): Promise<void> {
  const agentsFile = join(contentDir, '.ok', 'local', 'acp-agents.json');
  mkdirSync(dirname(agentsFile), { recursive: true });
  writeFileSync(
    agentsFile,
    `${JSON.stringify(
      [{ id: SEED_AGENT_ID, name: 'Panel Level Fixture', command: '/bin/false' }],
      null,
      2,
    )}\n`,
  );

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

async function stubAgentCatalog(page: Page): Promise<void> {
  await page.route('**/api/acp/catalog', (route) => route.fulfill({ json: EMPTY_AGENT_CATALOG }));
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

async function openAppWithRoster(page: Page): Promise<void> {
  const roster = nextRosterDelivery(page);
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__acpThreadHarness), null, {
    timeout: BOOT_TIMEOUT_MS,
  });
  await roster;
  await settleAfterRoster(page);
}

async function openAgentsPanel(page: Page): Promise<void> {
  const mount = page.locator(AGENTS_PANEL_MOUNT);
  const revealTab = page.locator(AGENTS_REVEAL_TAB);
  await expect
    .poll(async () => (await mount.isVisible()) || (await revealTab.isVisible()), {
      timeout: BOOT_TIMEOUT_MS,
    })
    .toBe(true);
  const revealed = await revealTab.isVisible();
  if (revealed) {
    await revealTab.click({ timeout: 5_000 }).catch(() => {});
  }
  await expect(mount).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  if (revealed) {
    await expect
      .poll(
        () =>
          page.evaluate(() => document.activeElement?.closest('[data-agents-panel-mount]') != null),
        { timeout: 10_000 },
      )
      .toBe(true);
  }
  await settleAfterRoster(page);
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

async function collapseAgentsPanel(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: COLLAPSE_AGENT_PANEL_BUTTON })
    .click({ timeout: BOOT_TIMEOUT_MS });
  await expect(page.locator(AGENTS_REVEAL_TAB)).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
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

test.describe('agents panel reload visibility level', () => {
  test.afterEach(async ({ workerServer }) => {
    await purgeLiveThreads(workerServer.port);
  });

  test('a panel closed before a roster-delayed reload stays closed after it (level written by real open and collapse clicks and asserted in localStorage before reload; storage-coercion edge cases are pinned by the co-located DOM suites)', async ({
    page,
    workerServer,
  }) => {
    await purgeLiveThreads(workerServer.port);
    await seedLiveThread(workerServer.port, workerServer.contentDir);
    await stubAgentCatalog(page);
    await openAppWithRoster(page);

    await openAgentsPanel(page);
    await expectPersistedPanelLevel(page, true);
    await collapseAgentsPanel(page);
    await expectPersistedPanelLevel(page, false);

    const marks: RouteMark[] = [];
    await page.route(SESSIONS_CHUNK_GLOB, async (route) => {
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

    await expect(page.locator(AGENTS_REVEAL_TAB)).toBeVisible();
    await expect(page.locator(AGENTS_PANEL_MOUNT)).not.toBeVisible();
  });

  test('a panel closed before a roster-first reload stays closed and a later thread still reveals (level written by real open and collapse clicks and asserted in localStorage before reload; storage-coercion edge cases are pinned by the co-located DOM suites)', async ({
    page,
    workerServer,
  }) => {
    await purgeLiveThreads(workerServer.port);
    await seedLiveThread(workerServer.port, workerServer.contentDir);
    await stubAgentCatalog(page);
    await openAppWithRoster(page);

    await openAgentsPanel(page);
    await expectPersistedPanelLevel(page, true);
    await collapseAgentsPanel(page);
    await expectPersistedPanelLevel(page, false);

    const marks: RouteMark[] = [];
    await page.route(SESSIONS_CHUNK_GLOB, async (route) => {
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

    await expect(page.locator(AGENTS_REVEAL_TAB)).toBeVisible();
    await expect(page.locator(AGENTS_PANEL_MOUNT)).not.toBeVisible();

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

    await expect(page.locator(AGENTS_PANEL_MOUNT)).toBeVisible();
    await expect(page.locator(AGENTS_REVEAL_TAB)).not.toBeVisible();
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
    await page.route(SESSIONS_CHUNK_GLOB, async (route) => {
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

    await expect(page.locator(AGENTS_PANEL_MOUNT)).toBeVisible();
    await expect(page.locator(AGENTS_REVEAL_TAB)).not.toBeVisible();
  });
});
