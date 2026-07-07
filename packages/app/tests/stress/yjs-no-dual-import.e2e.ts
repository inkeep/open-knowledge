/**
 * Yjs dual-import absence — Playwright e2e gate.
 *
 * Failure mode this defends against: a future PR upgrades a y-* dependency
 * (or changes the dedupe list in `packages/app/vite.config.ts` /
 * `packages/desktop/electron.vite.config.ts`) in a way that re-introduces
 * the dual-import condition — one y-* intermediary force-resolved CJS while
 * another stays ESM, producing two yjs evaluations sharing the same
 * `globalThis`. yjs's import-guard detects this on the second evaluation
 * and prints `Yjs was already imported. This breaks constructor checks…`.
 * The console warning is the loud SYMPTOM; the latent failure mode is
 * identity-mismatch on `Y.UndoManager.trackedOrigins` which silently
 * corrupts undo behavior. This e2e gates the symptom at boot — the AST
 * meta-test (`y-prosemirror-import-coverage.test.ts`) gates the latent
 * identity surface independently.
 *
 * What this test does NOT do: cover desktop Electron boot. Playwright runs
 * against the dev server (`vite.config.ts`'s `hocuspocusPlugin` topology),
 * not the electron-vite renderer. For the electron-vite path, manual
 * desktop boot during QA is the verification surface.
 */

import { expect, test } from './_helpers';

test('renderer boots without Yjs dual-import warning', async ({ page }) => {
  const consoleMessages: { type: string; text: string }[] = [];
  page.on('console', (m) => {
    consoleMessages.push({ type: m.type(), text: m.text() });
  });
  page.on('pageerror', (e) => {
    consoleMessages.push({ type: 'pageerror', text: e.message });
  });

  // Fresh navigation — observe the boot path. Hash route to a non-existent
  // doc is fine; the renderer initializes Yjs/HocuspocusProvider early enough
  // that the dual-import warning (if it fires) lands before the provider is
  // active. Hash route prevents the navigator from showing instead of the
  // editor mount.
  await page.goto('/#/test-yjs-dual-import-probe');

  // The yjs import-guard fires synchronously during module evaluation —
  // by the time `__activeProvider` is set, every static import has
  // completed and the guard has either fired or didn't fire. No idle wait
  // beyond this point adds detection value (no `page.waitForTimeout` per
  // the codebase's E2E STOP rule).
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
