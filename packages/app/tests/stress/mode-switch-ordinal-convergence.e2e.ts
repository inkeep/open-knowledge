import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  assertLanded,
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
const EOL_TAIL_LINE = '- https://arxiv.org/abs/2409.14252 (eg-walker paper)';

function docName(label: string): string {
  return `msoc-${label}-${randomUUID().slice(0, 8)}`;
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

function adjacentListPairs(pm: readonly string[]): number {
  return pm.filter((kind, i) => kind.startsWith('list[') && (pm[i + 1] ?? '').startsWith('list['))
    .length;
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

async function openMergedListDoc(
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
    .poll(async () => (await ordinalTable(page)).source.includes('SPLITMARKER'), {
      timeout: 10_000,
      message: 'the deletion did not reach Y.Text',
    })
    .toBe(false);

  const { pm } = await ordinalTable(page);
  expect(
    adjacentListPairs(pm),
    'the document held two adjacent list nodes — a projection block table can no longer spell that, so either the re-derive stopped firing or the block table adopted a doc it disagrees with',
  ).toBe(0);
}

test('deleting the paragraph between two lists merges them instead of diverging the ordinals', async ({
  page,
  api,
}) => {
  const name = docName('merge');
  await openMergedListDoc(page, api, name);

  const { pm, source } = await ordinalTable(page);
  expect(pm.filter((kind) => kind.startsWith('list[')).length).toBe(3);
  expect(source).toContain('tailscale.com');
  expect(source).toContain('youtube.com');
});

test('view-in-source lands on the block it was invoked from after the merge', async ({
  page,
  api,
}) => {
  const name = docName('jump');
  await openMergedListDoc(page, api, name);

  await selectText(page, EOL_TAIL);
  const bubble = page.getByTestId(VIEW_IN_SOURCE_BUBBLE);
  await expect(bubble, 'the View in source bubble entry did not appear').toBeVisible();

  const before = await landingMarkCount(page);
  await bubble.click();
  const mark = await waitForLandingSettled(page, { since: before });
  expect(mark.kind, `jump did not land (grade ${mark.grade})`).toBe('land');
  expect(mark.grade).toBe('exact');

  const landed = await caretLine(page);
  expect(landed.text).toBe(EOL_TAIL_LINE);

  await expect.poll(() => page.locator(LANDING_FLASH).count()).toBeGreaterThan(0);
});

test('the mode toggle keeps the anchored block after the merge', async ({ page, api }) => {
  const name = docName('toggle');
  await openMergedListDoc(page, api, name, PADDING);

  const anchor = 'BLOCK-060';
  const residual = await scrollWysiwygBlockToTop(page, anchor);
  expect(Math.abs(residual), 'setup scroll did not converge').toBeLessThan(40);

  const before = await landingMarkCount(page);
  await toggleMode(page, 'source');
  const mark = await waitForLandingSettled(page, { since: before });
  expect(mark.kind, `toggle did not land (grade ${mark.grade})`).toBe('land');
  expect(mark.grade).toBe('exact');

  await assertLanded(page, {
    mode: 'source',
    targetText: `${anchor} padding paragraph`,
    placement: 'top',
  });
});
