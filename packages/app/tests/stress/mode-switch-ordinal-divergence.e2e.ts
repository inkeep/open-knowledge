/**
 * Pins the OPEN mode-switch mis-landing on ordinal-divergent documents, plus
 * the honest-flash behavior that ships while the mis-landing is open.
 *
 * Shape under test: the WYSIWYG fragment holds TWO ADJACENT `list` nodes, a
 * top-level shape markdown cannot spell. `serialize` emits a blank line between
 * the groups; `parse` merges them back into one list. Every top-level block
 * after the collapse therefore sits one ordinal too far in the parsed-source
 * block array the position resolver indexes into, so both the view-in-source
 * jump and the plain mode toggle land one block past their target.
 *
 * FLIP CONTRACT — the `KNOWN-BUG` tests assert today's WRONG landings on
 * purpose. When a fix lands (content-verified resolution or fragment
 * normalization), they fail loudly; flip their landing assertions to the
 * correct target and retitle them. They are written this way round, rather
 * than as `test.fail()`, so a setup regression (the gesture failing to mint
 * the divergent fragment) cannot be silently swallowed as an expected failure.
 *
 * The two-adjacent-lists state is NOT API-seedable (a markdown seed
 * round-trips through `parse`, which merges), so each test mints it with a
 * real WYSIWYG gesture: seed a paragraph between the two bullet groups, then
 * delete it with real keyboard input.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  expect,
  landingMarkCount,
  readSourceCaretHead,
  scrollWysiwygBlockToTop,
  selectText,
  test,
  toggleMode,
  waitForActiveProviderSynced,
  waitForLandingSettled,
} from './_helpers';

const WYSIWYG = '.ProseMirror:not(.composer-prosemirror)';
const VIEW_IN_SOURCE_BUBBLE = 'view-in-source-bubble-button';
const LANDING_FLASH = '.cm-editor .ok-landing-flash';

/** Two bullet groups with an intervening paragraph the gesture deletes. */
const SEED = [
  'cs',
  '',
  '- https://www.youtube.com/watch?v=0l5XgnQ6rB4 (yjs walkthrough)',
  '- https://www.palanikannan.com/blogs/version-history-and-snapshots-in-yjs (yjs guide)',
  '- https://fosdem.org/2026/schedule/event/8VKQXR-blocknote-yjs-prosemirror/ (yjs v14 talk)',
  '',
  'SPLITMARKER',
  '',
  '- https://tailscale.com/blog/jailbroken-kindle-proxy-tun-modes (tailscale on a kindle?)',
  '- https://mitchellh.com/writing (hashicorp guy)',
  '',
  'research',
  '',
  '- https://arxiv.org/abs/2409.14252 (eg-walker paper)',
  '- https://www.inkandswitch.com/essay/local-first/ (local-first design)',
  '- https://30papers.com/ (foundational AI research/education list)',
  '',
  'competitors',
  '',
  '- https://workbench.md/',
  '- https://plane.so/wiki',
  '',
].join('\n');

/** Blocks appended past the collapse point so a deep toggle has a real anchor. */
const PADDING = `\n${Array.from(
  { length: 120 },
  (_, i) => `BLOCK-${String(i).padStart(3, '0')} padding paragraph`,
).join('\n\n')}\n`;

/** The trailing run of the research bullet the jump is invoked from. */
const EOL_TAIL = 'g-walker paper)';

function docName(label: string): string {
  return `msod-${label}-${randomUUID().slice(0, 8)}`;
}

/** PM top-level child kinds + the live serialized source, read in-page. */
async function ordinalTable(page: Page): Promise<{ pm: string[]; source: string }> {
  return page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('no active editor');
    const pm: string[] = [];
    editor.state.doc.forEach((n: { type: { name: string }; textContent: string }) => {
      pm.push(`${n.type.name}[${n.textContent.slice(0, 26)}]`);
    });
    const source = window.__activeProvider?.document?.getText('source')?.toString() ?? '';
    return { pm, source };
  });
}

/** Line (1-based) and text the source caret currently sits on. */
async function caretLine(page: Page): Promise<{ line: number; text: string; head: number }> {
  const head = await readSourceCaretHead(page);
  const source = await page.evaluate(
    () => window.__activeProvider?.document?.getText('source')?.toString() ?? '',
  );
  const before = source.slice(0, head);
  const line = before.split('\n').length;
  return { line, text: source.split('\n')[line - 1] ?? '', head };
}

/**
 * Seed, open, then mint the two-adjacent-lists fragment with a real gesture:
 * select the intervening paragraph and delete it with the keyboard.
 */
async function openSplitDoc(
  page: Page,
  api: { seedDocs: (d: Array<{ name: string; markdown: string }>) => Promise<void> },
  name: string,
  extra = '',
): Promise<void> {
  await api.seedDocs([{ name, markdown: SEED + extra }]);
  await page.goto(`/#/${name}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator(WYSIWYG).first()).toBeVisible();

  // Click into the paragraph first so the keystrokes below reach a focused
  // editor; a programmatic selection alone can leave DOM focus elsewhere.
  await page.locator(`${WYSIWYG} p`, { hasText: 'SPLITMARKER' }).first().click();
  await selectText(page, 'SPLITMARKER');
  await page.keyboard.press('Backspace'); // clears the text, leaves an empty paragraph
  // Wait for the text deletion to land before the join keystroke — pressing both
  // back to back races the first transaction and leaves one list.
  await expect
    .poll(async () => (await ordinalTable(page)).pm.join('|').includes('SPLITMARKER'), {})
    .toBe(false);
  await page.keyboard.press('Backspace'); // removes the now-empty paragraph

  // The gesture is the whole point of the test — fail loudly if it did not mint
  // two adjacent `list` nodes rather than silently testing the healthy shape.
  await expect
    .poll(async () => {
      const { pm } = await ordinalTable(page);
      return pm.some((k, i) => k.startsWith('list[') && (pm[i + 1] ?? '').startsWith('list['));
    }, {})
    .toBe(true);

  // Wait for Observer A to push the serialized fragment back into Y.Text. This is
  // the one poll here that crosses a server round-trip, so give it the same 10s
  // ceiling as `waitForLandingSettled` rather than the 5s `expect` default —
  // under CI contention a bare 5s can time out before propagation lands, which
  // would surface as a setup error rather than the behavioral signal under test.
  await expect
    .poll(async () => (await ordinalTable(page)).source.includes('SPLITMARKER'), {
      timeout: 10_000,
      message: 'Observer A did not propagate the deletion from the fragment into Y.Text',
    })
    .toBe(false);
}

test('KNOWN-BUG: view-in-source jump lands one block past the target on a divergent doc; the unverified landing must not flash', async ({
  page,
  api,
}) => {
  const name = docName('jump');
  await openSplitDoc(page, api, name);

  await selectText(page, EOL_TAIL);
  const bubble = page.getByTestId(VIEW_IN_SOURCE_BUBBLE);
  await expect(bubble, 'the View in source bubble entry did not appear').toBeVisible();

  const before = await landingMarkCount(page);
  await bubble.click();
  const mark = await waitForLandingSettled(page, { since: before });
  expect(mark.kind, `jump did not land (grade ${mark.grade})`).toBe('land');

  const landed = await caretLine(page);
  const flashes = await page.locator(LANDING_FLASH).count();
  console.log(
    `landing: grade=${mark.grade} caret head=${landed.head} -> line ${landed.line}: ${JSON.stringify(landed.text)}, flash spans=${flashes}`,
  );

  // The resolver detects the divergence (count tripwire) and grades the landing
  // an unverified ordinal. Flip on a regrading fix: fragment normalization clears
  // the count mismatch and lifts this to `exact`/`same-type-ordinal`; a fix that
  // only corrects placement while leaving the grade `ordinal` keeps it as-is.
  expect(mark.grade).toBe('ordinal');

  // Flash presence is a function of grade (`clampFlashRange`) AND settle
  // outcome — only a landing that reached `landed` dispatches the flash at all,
  // which is why the `kind` assertion above is load-bearing: without it an
  // abandoned settle satisfies zero-flash for free. This flips WITH the grade
  // above, not unconditionally: keep `toBe(0)` only while the landing stays an
  // unverified `ordinal`; any fix that lifts the grade to a verified one
  // restores the flash — flip to `toBeGreaterThan(0)` and assert the span
  // covers the landed block.
  expect(flashes, 'an ordinal-grade landing must not paint the landing flash').toBe(0);

  // KNOWN BUG (flip on fix): the caret lands on `competitors`, one top-level
  // block past the selected research bullet. A fix must land it on the line
  // containing `arxiv.org/abs/2409.14252` instead.
  expect(
    landed.text,
    'landing moved off the known-wrong block — the mis-landing may be fixed; flip this assertion to the correct target',
  ).toContain('competitors');
});

test('KNOWN-BUG: the plain mode toggle mis-anchors by one block on a divergent doc', async ({
  page,
  api,
}) => {
  // The short doc fits on one screen, so its topmost block is always ordinal 0,
  // which resolves correctly even under a shift. Pad past the collapse point so
  // the toggle has a deep block to preserve.
  const name = docName('toggle');
  await openSplitDoc(page, api, name, PADDING);

  const anchor = 'BLOCK-060';
  const residual = await scrollWysiwygBlockToTop(page, anchor);
  expect(Math.abs(residual), 'setup scroll did not converge').toBeLessThan(40);

  const before = await landingMarkCount(page);
  await toggleMode(page, 'source');
  const mark = await waitForLandingSettled(page, { since: before });
  expect(mark.kind, `toggle did not land (grade ${mark.grade})`).toBe('land');

  // The `kind` assertion above rules out an abandoned settle (the controller
  // stamps the same resolve-time grade on land and abandon marks); the grade
  // then pins that the divergent setup fired the count tripwire, so the
  // mis-anchor below is the ordinal-divergence this test is named for. Flip
  // semantics match the jump test's grade assertion above.
  expect(mark.grade).toBe('ordinal');

  // Read the source line sitting at the top of the readable area through
  // CodeMirror's own coordinate lookup, the way the landing oracle does.
  const topLine = await page.evaluate(() => {
    const scroller = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="editor-scroll-container"]'),
    ).find((el) => el.getClientRects().length > 0);
    if (!scroller) throw new Error('no visible scroll container');
    const content = Array.from(document.querySelectorAll<HTMLElement>('.cm-editor'))
      .find((el) => el.getClientRects().length > 0)
      ?.querySelector('.cm-content');
    const handle = content as
      | (Element & {
          cmTile?: { root?: { view?: unknown } };
          cmView?: { rootView?: { view?: unknown } };
        })
      | null;
    const view = (handle?.cmTile?.root?.view ?? handle?.cmView?.rootView?.view) as
      | {
          posAtCoords: (c: { x: number; y: number }, precise: boolean) => number;
          state: { doc: { lineAt: (p: number) => { number: number; text: string } } };
        }
      | undefined;
    if (!view) throw new Error('no CodeMirror view');
    const box = scroller.getBoundingClientRect();
    const pos = view.posAtCoords({ x: box.left + 40, y: box.top + 56 + 4 }, false);
    const line = view.state.doc.lineAt(pos);
    return `L${line.number}: ${line.text}`;
  });
  console.log(`toggle: grade=${mark.grade} anchored=${anchor} topmost=${JSON.stringify(topLine)}`);

  // KNOWN BUG (flip on fix): the toggle shows the block AFTER the anchored one
  // at the top of the readable area. A fix must keep `anchor` in view.
  expect(
    topLine,
    'the toggle preserved the anchored block — the mis-anchor may be fixed; flip this assertion to require the anchor',
  ).not.toContain(anchor);
});
