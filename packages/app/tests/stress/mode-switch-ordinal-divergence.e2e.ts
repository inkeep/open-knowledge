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

const PADDING = `\n${Array.from(
  { length: 120 },
  (_, i) => `BLOCK-${String(i).padStart(3, '0')} padding paragraph`,
).join('\n\n')}\n`;

const EOL_TAIL = 'g-walker paper)';

function docName(label: string): string {
  return `msod-${label}-${randomUUID().slice(0, 8)}`;
}

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

async function caretLine(page: Page): Promise<{ line: number; text: string; head: number }> {
  const head = await readSourceCaretHead(page);
  const source = await page.evaluate(
    () => window.__activeProvider?.document?.getText('source')?.toString() ?? '',
  );
  const before = source.slice(0, head);
  const line = before.split('\n').length;
  return { line, text: source.split('\n')[line - 1] ?? '', head };
}

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

  await page.locator(`${WYSIWYG} p`, { hasText: 'SPLITMARKER' }).first().click();
  await selectText(page, 'SPLITMARKER');
  await page.keyboard.press('Backspace');
  await expect
    .poll(async () => (await ordinalTable(page)).pm.join('|').includes('SPLITMARKER'), {})
    .toBe(false);
  await page.keyboard.press('Backspace');

  await expect
    .poll(async () => {
      const { pm } = await ordinalTable(page);
      return pm.some((k, i) => k.startsWith('list[') && (pm[i + 1] ?? '').startsWith('list['));
    }, {})
    .toBe(true);

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

  expect(mark.grade).toBe('ordinal');

  expect(flashes, 'an ordinal-grade landing must not paint the landing flash').toBe(0);

  expect(
    landed.text,
    'landing moved off the known-wrong block — the mis-landing may be fixed; flip this assertion to the correct target',
  ).toContain('competitors');
});

test('KNOWN-BUG: the plain mode toggle mis-anchors by one block on a divergent doc', async ({
  page,
  api,
}) => {
  const name = docName('toggle');
  await openSplitDoc(page, api, name, PADDING);

  const anchor = 'BLOCK-060';
  const residual = await scrollWysiwygBlockToTop(page, anchor);
  expect(Math.abs(residual), 'setup scroll did not converge').toBeLessThan(40);

  const before = await landingMarkCount(page);
  await toggleMode(page, 'source');
  const mark = await waitForLandingSettled(page, { since: before });
  expect(mark.kind, `toggle did not land (grade ${mark.grade})`).toBe('land');

  expect(mark.grade).toBe('ordinal');

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

  expect(
    topLine,
    'the toggle preserved the anchored block — the mis-anchor may be fixed; flip this assertion to require the anchor',
  ).not.toContain(anchor);
});
