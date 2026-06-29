import { expect, test } from './_helpers';

const SEED_DOCS = [
  { name: 'aa', markdown: '# aa\n\nThe queue manager handles items.\n' },
  { name: 'bb', markdown: '# bb\n\nThe quartz crystal vibrates.\n' },
  { name: 'cc', markdown: '# cc\n\nThe quill writes elegantly.\n' },
  { name: 'dd', markdown: '# dd\n\nThe qantas airline flies.\n' },
];

test.describe('command-palette — per-keystroke render stability', () => {
  test('typing a multi-character query updates the visible list at most once per keystroke', async ({
    page,
    api,
  }) => {
    await api.seedDocs(SEED_DOCS);

    await page.goto('/');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    await page.keyboard.press('ControlOrMeta+k');
    const list = page.locator('[data-slot="command-list"]');
    await expect(list).toBeVisible({ timeout: 5_000 });

    const input = page.locator('[data-slot="command-input"]');
    await expect(input).toBeFocused();

    await page.keyboard.type('q');

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              document.querySelectorAll(
                '[data-slot="command-list"] [data-testid^="command-palette-nav-"]',
              ).length,
          ),
        { timeout: 10_000, intervals: [50, 100, 200] },
      )
      .toBeGreaterThanOrEqual(3);

    await page.evaluate(() => {
      const root = document.querySelector('[data-slot="command-list"]');
      if (!root) throw new Error('command-list not present at sniffer install');
      const snapshots: string[] = [];
      const snapshot = () => {
        const items = Array.from(root.querySelectorAll('[data-testid^="command-palette-nav-"]'));
        const sig = items.map((el) => el.getAttribute('data-testid') ?? '').join('|');
        const last = snapshots[snapshots.length - 1];
        if (last !== sig) snapshots.push(sig);
      };
      snapshot();
      const observer = new MutationObserver(snapshot);
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      window.__paletteSnapshots = snapshots;
      window.__paletteSnapshotsCleanup = () => observer.disconnect();
    });

    await page.keyboard.type('u');

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              document.querySelectorAll(
                '[data-slot="command-list"] [data-testid^="command-palette-nav-"]',
              ).length,
          ),
        { timeout: 10_000, intervals: [50, 100, 200] },
      )
      .toBeGreaterThanOrEqual(1);

    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          let last = window.__paletteSnapshots?.length ?? 0;
          let stableTicks = 0;
          let totalTicks = 0;
          const POLL_MS = 100;
          const REQUIRED_STABLE_TICKS = 5;
          const MAX_TICKS = 50;
          const tick = () => {
            totalTicks += 1;
            if (totalTicks > MAX_TICKS) {
              reject(
                new Error(
                  `quiescence wait exceeded MAX_TICKS=${MAX_TICKS} ` +
                    `(${MAX_TICKS * POLL_MS}ms): snapshots kept growing — ` +
                    `final snapshot count = ${window.__paletteSnapshots?.length ?? 0}`,
                ),
              );
              return;
            }
            const now = window.__paletteSnapshots?.length ?? 0;
            if (now === last) {
              stableTicks += 1;
              if (stableTicks >= REQUIRED_STABLE_TICKS) {
                resolve();
                return;
              }
            } else {
              stableTicks = 0;
              last = now;
            }
            setTimeout(tick, POLL_MS);
          };
          setTimeout(tick, POLL_MS);
        }),
    );

    await page.evaluate(() => window.__paletteSnapshotsCleanup?.());
    const snapshots = await page.evaluate(() => window.__paletteSnapshots ?? []);

    console.log('[command-palette-flicker] populations seen during keystroke:', snapshots);

    expect(snapshots.length).toBeLessThanOrEqual(2);
  });
});

declare global {
  interface Window {
    __paletteSnapshots?: string[];
    __paletteSnapshotsCleanup?: () => void;
  }
}
