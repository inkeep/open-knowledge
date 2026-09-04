import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  expect,
  filterCriticalErrors,
  type LogEntry,
  test,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

test.use({ workerServerEnv: { OK_RETHROW_BRIDGE_LOSS: '1' } });

const CALLOUT = ['<Callout type="info">', '', 'Note:', '', '</Callout>', ''].join('\n');
const INDENTED_CALLOUT = /\n[ \t]+<\/?Callout\b/;

const readSource = (page: Page): Promise<string> =>
  page.evaluate(() => window.__activeProvider?.document?.getText('source')?.toString() ?? '');

async function placeCaretInCalloutInterior(page: Page): Promise<void> {
  await page
    .locator('.ProseMirror:not(.composer-prosemirror)')
    .getByText('Note:', { exact: false })
    .first()
    .click();
  await page.keyboard.press('End');
  await page.waitForFunction(
    () => {
      const sel = window.__activeEditor?.state.selection;
      return Boolean(sel?.empty && sel.$from.parent.type.name === 'paragraph');
    },
    null,
    { timeout: 5_000 },
  );
}

async function settleSource(page: Page, needle: string): Promise<void> {
  await page.evaluate(
    (n) =>
      new Promise<void>((resolve, reject) => {
        let last = -1;
        let stableTicks = 0;
        let totalTicks = 0;
        const POLL_MS = 100;
        const REQUIRED_STABLE_TICKS = 3;
        const MAX_TICKS = 80;
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

    const typed = 'ALERT42';
    let expected = 'Note:';
    for (const ch of typed) {
      await page.keyboard.type(ch, { delay: 55 });
      expected += ch;
      await settleSource(page, expected);
      const src = await readSource(page);
      expect(src).toContain(expected);
      expect((src.match(/<Callout\b/g) ?? []).length).toBe(1);
      expect((src.match(/<\/Callout>/g) ?? []).length).toBe(1);
      expect(src).not.toMatch(INDENTED_CALLOUT);
    }

    const finalSrc = await readSource(page);
    expect(finalSrc).toContain('Note:ALERT42');
    expect(finalSrc).toContain('type="info"');
    expect(filterCriticalErrors(errors)).toEqual([]);
  });

  test('a second burst after the first keeps the interior intact, tags singular', async ({
    page,
  }) => {
    await placeCaretInCalloutInterior(page);
    await page.keyboard.type('ONE', { delay: 55 });
    await settleSource(page, 'Note:ONE');

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
