import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

const EDITOR = '.ProseMirror:not(.composer-prosemirror)';
const FIRST_LINE = 'First line';
const AGENT_LINE = 'The agent added this line.';
const PEAK_MS = 160;
const LATE_MS = 1900;

interface FlashFrame {
  transform: string;
  background: string;
  barAlpha: number;
}

interface FlashReading {
  reducedMotion: boolean;
  dark: boolean;
  flashState: string | null;
  animationCount: number;
  peak: FlashFrame;
  late: FlashFrame;
}

function readFlashedBlock(page: Page): Promise<FlashReading> {
  return page.evaluate(
    ({ editorSelector, agentLine, peakMs, lateMs }) => {
      const root = document.querySelector(editorSelector);
      if (!root) throw new Error('editor not found');
      const block = Array.from(root.children).find((el) => el.textContent?.includes(agentLine));
      if (!block) throw new Error('agent block not found');
      const animations = block.getAnimations();
      for (const animation of animations) animation.pause();
      const barAlpha = (boxShadow: string): number => {
        if (!boxShadow.includes('inset')) return 0;
        const channels = boxShadow.match(/rgba?\(([^)]+)\)/)?.[1].split(',') ?? [];
        if (channels.length === 3) return 1;
        if (channels.length === 4) return Number(channels[3]);
        throw new Error(`cannot read the accent bar color from box-shadow "${boxShadow}"`);
      };
      const frameAt = (ms: number) => {
        for (const animation of animations) animation.currentTime = ms;
        const style = getComputedStyle(block);
        return {
          transform: style.transform,
          background: style.backgroundColor,
          barAlpha: barAlpha(style.boxShadow),
        };
      };
      return {
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        dark: document.documentElement.classList.contains('dark'),
        flashState:
          root.closest('[data-agent-flash-state]')?.getAttribute('data-agent-flash-state') ?? null,
        animationCount: animations.length,
        peak: frameAt(peakMs),
        late: frameAt(lateMs),
      };
    },
    { editorSelector: EDITOR, agentLine: AGENT_LINE, peakMs: PEAK_MS, lateMs: LATE_MS },
  );
}

for (const theme of ['light', 'dark'] as const) {
  test(`under reduced motion, an agent flash in the ${theme} theme shows only the accent bar`, async ({
    page,
    api,
  }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.addInitScript((value) => window.localStorage.setItem('ok-theme-v1', value), theme);
    const docName = `agent-flash-${theme}-${randomUUID()}`;
    await api.seedDocs([{ name: docName, markdown: `${FIRST_LINE}\n` }]);
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    await expect(page.locator(EDITOR)).toContainText(FIRST_LINE);

    await api.writeAsAgent(docName, `${FIRST_LINE}\n\n${AGENT_LINE}\n`, {
      agentId: 'flash-theme',
      agentName: 'FlashTheme',
    });
    await expect(page.locator(EDITOR)).toContainText(AGENT_LINE);
    await expect(page.locator(`.tiptap-editor:has(${EDITOR})`)).toHaveAttribute(
      'data-agent-flash-state',
      'editing',
    );

    const reading = await readFlashedBlock(page);

    expect(reading).toMatchObject({
      reducedMotion: true,
      dark: theme === 'dark',
      flashState: 'editing',
    });
    expect(reading.animationCount).toBeGreaterThan(0);
    expect(reading.peak).toMatchObject({ transform: 'none', background: 'rgba(0, 0, 0, 0)' });
    expect(reading.late.barAlpha).toBeGreaterThan(0.9);
  });
}
