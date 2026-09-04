import { expect, test } from './_helpers';

test('renderer boots without Yjs dual-import warning', async ({ page }) => {
  const consoleMessages: { type: string; text: string }[] = [];
  page.on('console', (m) => {
    consoleMessages.push({ type: m.type(), text: m.text() });
  });
  page.on('pageerror', (e) => {
    consoleMessages.push({ type: 'pageerror', text: e.message });
  });

  await page.goto('/#/test-yjs-dual-import-probe');

  await page.waitForFunction(() => Boolean(window.__activeProvider), null, {
    timeout: 15_000,
  });

  const warnings = consoleMessages.filter((m) => /Yjs was already imported/.test(m.text));
  if (warnings.length > 0) {
    const detail = warnings.map((w) => `  [${w.type}] ${w.text}`).join('\n');
    throw new Error(
      `Yjs dual-import warning detected during renderer boot.\n` +
        `This means a y-* intermediary is being resolved twice in the same realm (mixed CJS/ESM, ` +
        `un-deduped intermediary, or a new direct y-prosemirror import). Check ` +
        `\`packages/app/vite.config.ts\` resolve.dedupe + \`y-prosemirror-import-coverage.test.ts\`.\n` +
        `Captured warnings:\n${detail}`,
    );
  }
  expect(warnings).toEqual([]);
});
