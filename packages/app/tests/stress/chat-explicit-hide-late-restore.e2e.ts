import { randomUUID } from 'node:crypto';
import type {
  ThreadClientFrame,
  ThreadServerFrame,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import type { WebSocketRoute } from '@playwright/test';
import { dockUnitRect, expect, test, waitForActiveProviderSynced } from './_helpers';
import { startHiddenChatAgent } from './hidden-chat-transport.test-helper';

// WARN: tracing perturbs the focus race this file's thread-tab toBeFocused assertion depends on.
test.use({ trace: 'off' });

test('a hidden Chat stays hidden through late thread restoration until its shortcut reveals it', async ({
  page,
  context,
  api,
  workerServer,
}) => {
  const docName = `chat-hidden-restore-${randomUUID()}`;
  await api.seedDocs([{ name: docName, markdown: '# Chat late restoration\n' }]);
  const fixture = await startHiddenChatAgent(workerServer);
  const heldServerFrames: string[] = [];
  const observedRosters: string[][] = [];
  const createRequests: ThreadClientFrame[] = [];
  const createdThreadIds = new Set<string>();
  let threadSocket: WebSocketRoute | null = null;
  let holdInitialFrames = true;
  let releaseHost: (() => void) | undefined;

  await page.addInitScript((agentId) => {
    localStorage.setItem(
      'ok-acp-registered-agents-v1',
      JSON.stringify({
        agents: [{ source: 'custom', id: agentId, name: 'Hidden activity fixture' }],
        defaultKey: `custom:${agentId}`,
      }),
    );
  }, fixture.agentId);
  await context.routeWebSocket(/\/collab\/thread$/, (socket) => {
    threadSocket = socket;
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      if (typeof message === 'string') {
        const frame = JSON.parse(message) as ThreadClientFrame;
        if (frame.op === 'create') createRequests.push(frame);
      }
      server.send(message);
    });
    server.onMessage((message) => {
      if (typeof message !== 'string') {
        socket.send(message);
        return;
      }
      const frame = JSON.parse(message) as ThreadServerFrame;
      if (frame.op === 'threads') {
        const ids = frame.threads.map((thread) => thread.threadId);
        observedRosters.push(ids);
        for (const id of ids) {
          if (id !== fixture.threadId) createdThreadIds.add(id);
        }
      }
      if (frame.op === 'created' && frame.info.threadId !== fixture.threadId)
        createdThreadIds.add(frame.info.threadId);
      if (holdInitialFrames && (frame.op === 'threads' || frame.op === 'created'))
        heldServerFrames.push(message);
      else socket.send(message);
    });
  });

  try {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);

    const button = page.getByTestId('header-pane-button-agents');
    const threadTab = page.locator(`[role="tab"][data-tab-id="${fixture.threadId}"]`);
    const panelWidth = () => dockUnitRect(page, 'agents').then((rect) => rect?.width ?? 0);

    await expect
      .poll(() => observedRosters.some((ids) => ids.includes(fixture.threadId)))
      .toBe(true);
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await button.click();
    await expect.poll(panelWidth).toBeGreaterThan(250);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    expect(createRequests).toEqual([]);
    const initialSocket = threadSocket;
    if (initialSocket === null) throw new Error('thread route was not established');
    holdInitialFrames = false;
    for (const frame of heldServerFrames) initialSocket.send(frame);
    await expect(threadTab).toHaveCount(1);
    expect(createRequests).toEqual([]);

    await button.press('ControlOrMeta+Shift+j');
    await expect.poll(panelWidth).toBeGreaterThan(250);

    await button.click();
    await expect.poll(panelWidth).toBe(0);
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await expect(threadTab).toHaveCount(1);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem('ok-agent-session-order-v1') ?? '{}').agentPanelVisible,
        ),
      )
      .toBe(false);

    let heldRequests = 0;
    const heldHost = new Promise<void>((resolve) => {
      releaseHost = resolve;
    });
    await page.route('**/src/components/SessionsHost*', async (route) => {
      heldRequests += 1;
      await heldHost;
      await route.continue();
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect.poll(() => heldRequests).toBeGreaterThan(0);
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(panelWidth).toBe(0);

    await page.evaluate(() => {
      const samples: Array<{ visible: boolean; pressed: boolean }> = [];
      const recordFrame = () => {
        const unit = document.querySelector('[data-dock-unit="agents"]');
        const button = document.querySelector('[data-testid="header-pane-button-agents"]');
        samples.push({
          visible:
            unit instanceof HTMLElement &&
            !unit.hidden &&
            !unit.hasAttribute('data-dock-unit-off') &&
            unit.getBoundingClientRect().width > 0,
          pressed: button?.getAttribute('aria-pressed') === 'true',
        });
        requestAnimationFrame(recordFrame);
      };
      (
        window as Window & {
          __qa009LateRestoreFrames?: typeof samples;
        }
      ).__qa009LateRestoreFrames = samples;
      requestAnimationFrame(recordFrame);
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as Window & {
                __qa009LateRestoreFrames?: Array<{ visible: boolean; pressed: boolean }>;
              }
            ).__qa009LateRestoreFrames?.length ?? 0,
        ),
      )
      .toBeGreaterThan(0);

    await button.press('ControlOrMeta+Shift+j');
    releaseHost();
    await expect.poll(panelWidth).toBeGreaterThan(250);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(threadTab).toBeVisible();
    await threadTab.focus();
    await expect(threadTab).toBeFocused();
    await button.press('ControlOrMeta+Shift+j');
    await expect.poll(panelWidth).toBeGreaterThan(250);
    await expect(button).toHaveAttribute('aria-pressed', 'true');

    const frames = await page.evaluate(
      () =>
        (
          window as Window & {
            __qa009LateRestoreFrames?: Array<{ visible: boolean; pressed: boolean }>;
          }
        ).__qa009LateRestoreFrames ?? [],
    );
    expect(frames.some((frame) => frame.visible)).toBe(true);
    expect(frames.filter((frame) => frame.visible !== frame.pressed)).toEqual([]);
  } finally {
    releaseHost?.();
    try {
      for (const id of createdThreadIds) await fixture.closeThread(id);
    } finally {
      await fixture.close();
    }
  }
});
