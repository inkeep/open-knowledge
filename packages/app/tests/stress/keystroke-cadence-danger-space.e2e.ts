/**
 * Keystroke-cadence browser probe — real per-keystroke typing INTO a registered
 * Callout interior in WYSIWYG.
 *
 * The integration tier drives the Observer-A producer guard and the structural
 * freshness derivation with a text-leaf wire model; this exercises the same
 * per-drain checks through the REAL editor path — ProseMirror input, the
 * Callout's NodeViewContent hole, the client SourceDirtyObserver flip, and a
 * live caret — one character at a time.
 *
 * This worker's dev server runs in the producer guard's loud (throw) posture
 * (OK_RETHROW_BRIDGE_LOSS=1, dedicated worker via workerServerEnv). A guard
 * false-fire on any keystroke aborts that server drain before the Y.Text write,
 * so the character never echoes back to the client: the per-keystroke assertion
 * that the growing interior text reached the persisted source then fails AT the
 * keystroke that fired, before a later keystroke's full re-serialize can heal it.
 *
 * Oracle: the typed text survives contiguously, the container tags stay singular
 * and un-re-indented, the registered prop survives, and no critical console /
 * page error surfaces across the burst.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  expect,
  filterCriticalErrors,
  type LogEntry,
  test,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

// Dedicated worker in the producer guard's throw posture: a false-fire surfaces
// as an aborted drain (lost keystroke), not a silent packaged-posture log.
test.use({ workerServerEnv: { OK_RETHROW_BRIDGE_LOSS: '1' } });

const CALLOUT = ['<Callout type="info">', '', 'Note:', '', '</Callout>', ''].join('\n');
const INDENTED_CALLOUT = /\n[ \t]+<\/?Callout\b/;

const readSource = (page: Page): Promise<string> =>
  page.evaluate(() => window.__activeProvider?.document?.getText('source')?.toString() ?? '');

/** Place the caret at the end of the Callout's editable interior by clicking the
 *  rendered interior text (the NodeViewContent hole), then End. Clicking the text
 *  places a TextSelection inside the paragraph; a position-math selection near the
 *  jsxComponent boundary snaps to a NodeSelection on the wrapper instead. */
async function placeCaretInCalloutInterior(page: Page): Promise<void> {
  await page
    .locator('.ProseMirror:not(.composer-prosemirror)')
    .getByText('Note:', { exact: false })
    .first()
    .click();
  await page.keyboard.press('End');
  // Confirm the caret is a text cursor inside the interior, not a NodeSelection
  // on the Callout wrapper (which would make the next keystrokes replace/miss).
  await page.waitForFunction(
    () => {
      const sel = window.__activeEditor?.state.selection;
      return Boolean(sel?.empty && sel.$from.parent.type.name === 'paragraph');
    },
    null,
    { timeout: 5_000 },
  );
}

/** Wait until the persisted source contains `needle` and its length has settled
 *  (the Observer-A write-back finished). Condition-based, with a fail-fast tick
 *  ceiling — `page.waitForTimeout` is banned by the e2e STOP rule. */
async function settleSource(page: Page, needle: string): Promise<void> {
  await page.evaluate(
    (n) =>
      new Promise<void>((resolve, reject) => {
        let last = -1;
        let stableTicks = 0;
        let totalTicks = 0;
        const POLL_MS = 100;
        const REQUIRED_STABLE_TICKS = 3;
        const MAX_TICKS = 80; // ~8s ceiling — fail fast, never run to Playwright's default
        const tick = (): void => {
          totalTicks += 1;
          if (totalTicks > MAX_TICKS) {
            reject(
              new Error(
                `settleSource: ${JSON.stringify(n)} did not land + settle within ${MAX_TICKS * POLL_MS}ms — ` +
                  `a producer-guard abort would strand the keystroke here`,
              ),
            );
            return;
          }
          const s = window.__activeProvider?.document?.getText('source')?.toString() ?? '';
          if (s.includes(n) && s.length === last) {
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
    needle,
  );
}

let docName: string;
let errors: LogEntry[];

test.beforeEach(async ({ page, api }) => {
  errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push({ type: 'error', text: msg.text() });
  });
  page.on('pageerror', (err) => {
    errors.push({ type: 'uncaught', text: err.message });
  });

  docName = `keystroke-danger-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  await api.replaceDoc(docName, CALLOUT);
  // Wait for the Callout to render and the live editor handle to be exposed.
  await page.waitForFunction(
    () => Boolean(window.__activeEditor) && (document.body.textContent ?? '').includes('Note:'),
    null,
    { timeout: 10_000 },
  );
});

test.describe('keystroke-cadence browser probe — registered Callout interior (throw posture)', () => {
  test('per-keystroke typing into a Callout interior lands contiguous, guard never aborts a drain', async ({
    page,
  }) => {
    await placeCaretInCalloutInterior(page);

    // Type character by character; settle + assert after EACH so a transient
    // guard abort is caught at the keystroke it fires on (before a later
    // keystroke's full re-serialize can heal it). Non-whitespace chars keep the
    // survival substring exact (no markdown whitespace normalization ambiguity).
    const typed = 'ALERT42';
    let expected = 'Note:';
    for (const ch of typed) {
      await page.keyboard.type(ch, { delay: 55 });
      expected += ch;
      await settleSource(page, expected);
      const src = await readSource(page);
      expect(src).toContain(expected); // contiguous — the keystroke landed
      expect((src.match(/<Callout\b/g) ?? []).length).toBe(1);
      expect((src.match(/<\/Callout>/g) ?? []).length).toBe(1);
      expect(src).not.toMatch(INDENTED_CALLOUT); // no Observer-A re-indent write-back
    }

    const finalSrc = await readSource(page);
    expect(finalSrc).toContain('Note:ALERT42');
    expect(finalSrc).toContain('type="info"'); // registered prop survived
    expect(filterCriticalErrors(errors)).toEqual([]);
  });

  test('a second burst after the first keeps the interior intact, tags singular', async ({
    page,
  }) => {
    await placeCaretInCalloutInterior(page);
    await page.keyboard.type('ONE', { delay: 55 });
    await settleSource(page, 'Note:ONE');

    // Re-anchor the caret (the node view may have re-rendered) and type again.
    await placeCaretInCalloutInterior(page);
    await page.keyboard.type('TWO', { delay: 55 });
    await settleSource(page, 'Note:ONETWO');

    const src = await readSource(page);
    expect(src).toContain('Note:ONETWO');
    expect((src.match(/<Callout\b/g) ?? []).length).toBe(1);
    expect((src.match(/<\/Callout>/g) ?? []).length).toBe(1);
    expect(src).not.toMatch(INDENTED_CALLOUT);
    expect(src).toContain('type="info"');
    expect(filterCriticalErrors(errors)).toEqual([]);
  });
});
