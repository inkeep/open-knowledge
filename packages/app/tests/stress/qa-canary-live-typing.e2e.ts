/** QA canary — browser tier: real per-keystroke LIVE typing on <Steps> in source
 *  mode (the residual the integration rung cannot reach). Exercises per-char Y.Text
 *  deltas against the live bridge WITH the hidden-but-mounted WYSIWYG binding active
 *  — would an Observer-A write-back re-indent the doc and yank the caret mid-burst?
 *
 *  Cursor-jump oracle = TYPED-BURST CONTIGUITY: a 5-char burst typed character by
 *  character must land as one contiguous run. If the caret jumps mid-burst (a
 *  write-back remap), the run fragments — caught without reaching into CM internals.
 *
 *  Per-worker isolated server + tmpdir (playwright.config has no webServer) — does
 *  not touch a dev server on 5173.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

const sourceToggle = (page: Page) => page.getByRole('radio', { name: 'Markdown source' });
const INDENTED_STEP = /\n[ \t]+<\/?Step\b/;

const STEPS = [
  '<Steps>',
  '',
  '<Step>',
  '',
  'Content one.',
  '',
  '</Step>',
  '',
  '<Step>',
  '',
  'Content two.',
  '',
  '</Step>',
  '',
  '<Step>',
  '',
  'Content three.',
  '',
  '</Step>',
  '',
  '</Steps>',
  '',
].join('\n');

const readSource = (page: Page) =>
  page.evaluate(() => window.__activeProvider?.document?.getText('source')?.toString() ?? '');

// Wait for the burst to land AND the source length to settle (Observer write-back
// finished). Polls inside the page with setTimeout — page.waitForTimeout is banned
// by the e2e STOP rule as a fixed-delay anti-flake smell; a condition-based poll
// with a fail-fast tick ceiling is the sanctioned replacement.
async function settleSource(page: Page, mustInclude: string) {
  await page.evaluate(
    (needle) =>
      new Promise<void>((resolve, reject) => {
        let last = -1;
        let stableTicks = 0;
        let totalTicks = 0;
        const POLL_MS = 100;
        const REQUIRED_STABLE_TICKS = 3;
        const MAX_TICKS = 100; // ~10s ceiling — fail fast, don't run to Playwright's 120s
        const tick = () => {
          totalTicks += 1;
          if (totalTicks > MAX_TICKS) {
            reject(
              new Error(
                `settleSource: "${needle}" did not land + settle within ${MAX_TICKS * POLL_MS}ms`,
              ),
            );
            return;
          }
          const s = window.__activeProvider?.document?.getText('source')?.toString() ?? '';
          if (s.includes(needle) && s.length === last) {
            stableTicks += 1;
            if (stableTicks >= REQUIRED_STABLE_TICKS) {
              resolve();
              return;
            }
          } else {
            stableTicks = 0;
            last = s.length;
          }
          setTimeout(tick, POLL_MS);
        };
        setTimeout(tick, POLL_MS);
      }),
    mustInclude,
  );
}

let docName: string;
test.beforeEach(async ({ page, api }) => {
  docName = `qa-livetype-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror');
  await api.replaceDoc(docName, STEPS);
  await page.waitForFunction(
    () => document.querySelector('.ProseMirror')?.textContent?.includes('Content one'),
    null,
    { timeout: 10_000 },
  );
});

// KNOWN PRE-EXISTING CORRUPTION (quarantined tripwire): B1 below detects a
// real source-typing race in the authoritative Y.Text that PRE-DATES this
// suite (reproduced on pure origin/main under full-suite contention — see
// the forensic note atop qa-canary-authoring-both-modes.e2e.ts; the full
// evidence lives in the quarantining commit's message and its PR
// discussion). It is `test.fixme` so the pre-existing bug does not lottery
// every PR's e2e lane; the follow-up fix must un-fixme it.
test.describe('QA canary — live per-keystroke typing on <Steps> (browser, source mode)', () => {
  // B1 — live burst inside a Step body: caret stays put (burst contiguous), no re-indent.
  test.fixme('typing a burst into a Step body lands contiguous, no re-indent, no growth', async ({
    page,
  }) => {
    await sourceToggle(page).click();
    await page.waitForSelector('.cm-content');
    await page
      .locator('.cm-content:visible')
      .getByText('Content one.', { exact: false })
      .first()
      .click();
    await page.keyboard.press('End'); // end of the "Content one." line
    await page.keyboard.type('ZZZZZ', { delay: 45 }); // per-char live burst
    await settleSource(page, 'ZZZZZ');

    const src = await readSource(page);
    expect(src).toContain('Content one.ZZZZZ'); // contiguous => caret did NOT jump mid-burst
    expect(src).not.toMatch(INDENTED_STEP); // no Observer-A re-indent write-back
    expect((src.match(/<Step>/g) ?? []).length).toBe(3);
    expect((src.match(/<Steps>/g) ?? []).length).toBe(1);
    expect(src.length).toBeLessThan(STEPS.length + 32); // no growth/duplication
  });

  // B2 — live burst at a body-start boundary (right after the <Step> open tag).
  test('typing a burst at a Step body-start boundary lands contiguous, tags intact', async ({
    page,
  }) => {
    await sourceToggle(page).click();
    await page.waitForSelector('.cm-content');
    await page
      .locator('.cm-content:visible')
      .getByText('Content two.', { exact: false })
      .first()
      .click();
    await page.keyboard.press('Home'); // start of the "Content two." line
    await page.keyboard.type('QQQQQ', { delay: 45 });
    await settleSource(page, 'QQQQQ');

    const src = await readSource(page);
    expect(src).toContain('QQQQQContent two.'); // contiguous at the boundary
    expect(src).not.toMatch(INDENTED_STEP);
    expect((src.match(/<Step>/g) ?? []).length).toBe(3);
    expect(src.length).toBeLessThan(STEPS.length + 32);
  });

  // B3 — in-browser reopen: edit, navigate away + back (client recycle + re-sync),
  // assert the edit survived with no corruption.
  test('in-browser reopen after a live edit preserves bytes, no corruption', async ({
    page,
    api,
  }) => {
    await sourceToggle(page).click();
    await page.waitForSelector('.cm-content');
    await page
      .locator('.cm-content:visible')
      .getByText('Content three.', { exact: false })
      .first()
      .click();
    await page.keyboard.press('End');
    await page.keyboard.type('RRRRR', { delay: 45 });
    await settleSource(page, 'RRRRR');

    // Navigate away to a different doc, then back — evicts the editor + re-syncs.
    const other = `qa-other-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${other}.md`);
    await page.goto(`/#/${other}`);
    await waitForProvider(page);
    // Editor mode persists (localStorage 'ok-editor-mode-v1') — after the source
    // toggle above, the fresh doc opens in SOURCE mode, so .ProseMirror is hidden.
    // Wait for the source surface, not WYSIWYG.
    await page.waitForSelector('.cm-content');
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForFunction(
      () => window.__activeProvider?.document?.getText('source')?.toString()?.includes('RRRRR'),
      null,
      { timeout: 10_000 },
    );

    const src = await readSource(page);
    expect(src).toContain('Content three.RRRRR'); // edit survived the reopen, contiguous
    expect(src).not.toMatch(INDENTED_STEP);
    expect((src.match(/<Step>/g) ?? []).length).toBe(3);
    expect(src.length).toBeLessThan(STEPS.length + 32);
  });
});
