import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { AgentCatalog } from '@/lib/acp/catalog';
import { dockUnitRect, expect, test, waitForActiveProviderSynced } from './_helpers';
import { startHiddenChatAgent } from './hidden-chat-transport.test-helper';

async function chatWidth(page: Page): Promise<number> {
  return (await dockUnitRect(page, 'agents'))?.width ?? 0;
}

async function registerFixtureAgent(page: Page, agentId: string): Promise<void> {
  await page.addInitScript((id) => {
    localStorage.setItem(
      'ok-acp-registered-agents-v1',
      JSON.stringify({
        agents: [{ source: 'custom', id, name: 'Hidden activity fixture' }],
        defaultKey: `custom:${id}`,
      }),
    );
  }, agentId);
}
test.beforeEach(async ({ page }) => {
  await page.route('**/api/acp/catalog', async (route) => {
    const response = await route.fetch();
    const catalog = (await response.json()) as AgentCatalog;
    await route.fulfill({
      response,
      json: { ...catalog, agents: catalog.agents.filter((agent) => agent.source !== 'registry') },
    });
  });
});
test('Chat shortcut restores a hidden real thread in the same frame', async ({
  page,
  api,
  workerServer,
}) => {
  const docName = `chat-shortcut-${randomUUID()}`;
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await api.seedDocs([{ name: docName, markdown: '# Chat shortcut fixture\n' }]);
  const fixture = await startHiddenChatAgent(workerServer);
  await registerFixtureAgent(page, fixture.agentId);
  const client = await page.context().newCDPSession(page);
  const frames: string[] = [];
  client.on('Page.screencastFrame', (event) => {
    frames.push(event.data);
    void client.send('Page.screencastFrameAck', { sessionId: event.sessionId });
  });
  try {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    const button = page.getByTestId('header-pane-button-agents');
    await expect(button).toBeVisible();
    await button.click();
    await expect.poll(() => chatWidth(page)).toBeGreaterThan(250);
    const threadTab = page.locator(`[role="tab"][data-tab-id="${fixture.threadId}"]`);
    await expect(threadTab).toHaveCount(1);
    await threadTab.click();
    await button.click();
    await expect.poll(() => chatWidth(page)).toBe(0);
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await page.evaluate(() => {
      const swatch = document.createElement('div');
      Object.assign(swatch.style, {
        position: 'fixed',
        left: '0',
        top: '0',
        width: '32px',
        height: '32px',
        zIndex: '2147483647',
        pointerEvents: 'none',
      });
      document.body.append(swatch);
      const unit = document.querySelector('[data-dock-unit="agents"]');
      const button = document.querySelector('[data-testid="header-pane-button-agents"]');
      const sample = () => {
        const wide =
          unit instanceof HTMLElement &&
          !unit.hidden &&
          !unit.hasAttribute('data-dock-unit-off') &&
          unit.getBoundingClientRect().width > 0;
        const pressed = button?.getAttribute('aria-pressed') === 'true';
        swatch.style.backgroundColor = wide
          ? pressed
            ? 'rgb(0, 255, 0)'
            : 'rgb(255, 0, 0)'
          : pressed
            ? 'rgb(255, 0, 255)'
            : 'rgb(0, 0, 255)';
      };
      const mutation = new MutationObserver(sample);
      if (button) mutation.observe(button, { attributes: true, attributeFilter: ['aria-pressed'] });
      if (unit) {
        mutation.observe(unit, {
          attributes: true,
          attributeFilter: ['hidden', 'data-dock-unit-off', 'style'],
        });
      }
      let running = true;
      const tick = () => {
        if (!running) return;
        sample();
        requestAnimationFrame(tick);
      };
      sample();
      requestAnimationFrame(tick);
      Object.assign(window, {
        __qa009Samples: {
          stop: () => {
            running = false;
            mutation.disconnect();
            swatch.remove();
          },
        },
      });
    });
    await client.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    await expect.poll(() => frames.length).toBeGreaterThan(0);
    await page.keyboard.press('ControlOrMeta+Shift+j');
    await expect.poll(() => chatWidth(page)).toBeGreaterThan(250);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    const firstWidth = await chatWidth(page);
    await page.keyboard.press('ControlOrMeta+Shift+j');
    await expect.poll(() => chatWidth(page)).toBeGreaterThan(250);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => frames.length).toBeGreaterThan(1);
    await client.send('Page.stopScreencast');
    const samples = await page.evaluate(async (paintedFrames) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Canvas 2D context unavailable');
      const painted: Array<{ width: number; pressed: boolean }> = [];
      for (const frame of paintedFrames) {
        const bytes = Uint8Array.from(atob(frame), (character) => character.charCodeAt(0));
        const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        context.drawImage(image, 8, 8, 1, 1, 0, 0, 1, 1);
        image.close();
        const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
        if (red > 200 && green < 50 && blue < 50) {
          painted.push({ width: 1, pressed: false });
        } else if (green > 200 && red < 50 && blue < 50) {
          painted.push({ width: 1, pressed: true });
        } else if (blue > 200 && red < 50 && green < 50) {
          painted.push({ width: 0, pressed: false });
        } else if (red > 200 && blue > 200 && green < 50) {
          painted.push({ width: 0, pressed: true });
        }
      }
      (
        window as Window & {
          __qa009Samples?: { stop(): void };
        }
      ).__qa009Samples?.stop();
      return painted;
    }, frames);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.some((sample) => sample.width > 0)).toBe(true);
    expect(samples.filter((sample) => sample.pressed !== sample.width > 0)).toEqual([]);
    await expect(threadTab).toHaveCount(1);
    await threadTab.focus();
    await expect(threadTab).toBeFocused();
    await page.screenshot({ path: test.info().outputPath('chat-shortcut-restored.png') });
    await test.info().attach('chat-shortcut-observations', {
      body: JSON.stringify(
        { docName, threadId: fixture.threadId, firstWidth, samples, pageErrors },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    expect(pageErrors).toEqual([]);
  } finally {
    await client.detach();
    await fixture.close();
  }
});

for (const action of [
  'send queued comments',
  'open Ask AI in a new tab',
  'reuse the active thread with Ask AI',
  'launch an agent thread',
] as const) {
  test(`${action} reveals a hidden Chat pane with an existing thread`, async ({
    page,
    api,
    workerServer,
  }) => {
    const docName = `chat-shortcut-${randomUUID()}`;
    await api.seedDocs([{ name: docName, markdown: '# Chat reveal fixture\n' }]);
    const fixture = await startHiddenChatAgent(workerServer);
    await registerFixtureAgent(page, fixture.agentId);
    try {
      await page.setViewportSize({ width: 1600, height: 900 });
      await page.goto(`/#/${docName}`);
      await waitForActiveProviderSynced(page);
      const button = page.getByTestId('header-pane-button-agents');
      const mount = page.locator('[data-agents-panel-mount]');
      const threadTab = page.locator(`[role="tab"][data-tab-id="${fixture.threadId}"]`);
      await expect(button).toBeVisible();
      await expect(threadTab).toHaveCount(1);
      await button.click();
      await expect.poll(() => chatWidth(page)).toBeGreaterThan(250);
      await expect(threadTab).toHaveCount(1);
      await threadTab.click();
      const tabs = mount.locator('[role="tab"][data-tab-id]');
      await button.click();
      await expect.poll(() => chatWidth(page)).toBe(0);
      await expect(button).toHaveAttribute('aria-pressed', 'false');
      const originalTabIds = await tabs.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-tab-id')).sort(),
      );
      expect(originalTabIds).toContain(fixture.threadId);

      const forwardedCommentThreadId = await page.evaluate(
        ({ action, agentId, docName }) => {
          if (action === 'send queued comments') {
            let forwardedThreadId: string | null = null;
            window.addEventListener(
              'open-knowledge:comments-send-in-thread',
              (event) => {
                forwardedThreadId = (event as CustomEvent<{ threadId: string }>).detail.threadId;
              },
              { once: true },
            );
            window.dispatchEvent(
              new CustomEvent('open-knowledge:comments-send-to-open-chat', {
                detail: { threadIds: [] },
              }),
            );
            return forwardedThreadId;
          } else if (
            action === 'open Ask AI in a new tab' ||
            action === 'reuse the active thread with Ask AI'
          ) {
            window.dispatchEvent(
              new CustomEvent('open-knowledge:active-terminal-input', {
                detail: {
                  text: 'Review this document',
                  newTab: action === 'open Ask AI in a new tab',
                  submit: false,
                  target: 'agents',
                },
              }),
            );
          } else {
            window.dispatchEvent(
              new CustomEvent('open-knowledge:agent-thread-launch', {
                detail: {
                  agentSource: 'custom',
                  agentId,
                  prompt: null,
                  docName,
                  titleHint: null,
                  attachments: null,
                },
              }),
            );
          }
          return null;
        },
        { action, agentId: fixture.agentId, docName },
      );

      if (action === 'send queued comments') {
        expect(forwardedCommentThreadId).toBe(fixture.threadId);
      } else if (action === 'open Ask AI in a new tab') {
        await expect
          .poll(async () => {
            const currentTabIds = await tabs.evaluateAll((elements) =>
              elements.map((element) => element.getAttribute('data-tab-id')),
            );
            return {
              retained: originalTabIds.every((id) => currentTabIds.includes(id)),
              added: currentTabIds.filter((id) => !originalTabIds.includes(id)).length,
            };
          })
          .toEqual({ retained: true, added: 1 });
        if (originalTabIds.length === 1) await expect(tabs).toHaveCount(2);
      } else if (action === 'reuse the active thread with Ask AI') {
        await expect(
          mount.getByRole('textbox', { name: 'Message Hidden activity fixture' }),
        ).toContainText('Review this document');
        expect(
          await tabs.evaluateAll((elements) =>
            elements.map((element) => element.getAttribute('data-tab-id')).sort(),
          ),
        ).toEqual(originalTabIds);
      } else {
        await expect
          .poll(async () => {
            const currentTabIds = await tabs.evaluateAll((elements) =>
              elements.map((element) => element.getAttribute('data-tab-id')),
            );
            return {
              retained: originalTabIds.every((id) => currentTabIds.includes(id)),
              added: currentTabIds.filter((id) => !originalTabIds.includes(id)).length,
            };
          })
          .toEqual({ retained: true, added: 1 });
        if (originalTabIds.length === 1) await expect(tabs).toHaveCount(2);
      }

      await expect.poll(() => chatWidth(page)).toBeGreaterThan(250);
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      await expect(threadTab).toBeVisible();
      await threadTab.focus();
      await expect(threadTab).toBeFocused();
    } finally {
      await fixture.close();
    }
  });
}
