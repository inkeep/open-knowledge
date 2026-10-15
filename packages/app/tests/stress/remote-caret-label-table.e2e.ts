import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, placeCaretAtEndOfText, test, waitForActiveProviderSynced } from './_helpers';

const ROLES_TABLE_MARKDOWN = `# Permissions

Who can do what in each workspace role.

## Workspace roles

| Action | Owner | Admin | Member |
|--------|-------|-------|--------|
| Invite people | yes | yes | no |
| Remove people | owner-only | admin-only | never |
| Create projects | yes | yes | sometimes |

Trailing paragraph after the table.

${Array.from({ length: 40 }, (_, i) => `Filler paragraph ${i + 1} so the document scrolls.`).join('\n\n')}
`;

interface LabelHit {
  labels: number;
  width: number;
  height: number;
  hitIsLabel: boolean;
  hitDescription: string;
  gapAboveCaret: number;
  offsetFromCaretLeft: number;
}

async function hitTestRemoteLabel(page: Page): Promise<LabelHit> {
  return page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('.collaboration-cursor__label')).filter(
      (label): label is HTMLElement =>
        label instanceof HTMLElement && label.getClientRects().length > 0,
    );
    const label = labels[0];
    const caret = document.querySelector('.ProseMirror .collaboration-cursor__caret');
    if (!label || !caret) {
      return {
        labels: labels.length,
        width: 0,
        height: 0,
        hitIsLabel: false,
        hitDescription: 'no label',
        gapAboveCaret: Number.NaN,
        offsetFromCaretLeft: Number.NaN,
      };
    }
    const rect = label.getBoundingClientRect();
    const caretRect = caret.getBoundingClientRect();
    const previous = label.style.pointerEvents;
    label.style.pointerEvents = 'auto';
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    label.style.pointerEvents = previous;
    const hitDescription = hit
      ? `${hit.tagName.toLowerCase()}.${Array.from(hit.classList).join('.')}`
      : 'nothing';
    return {
      labels: labels.length,
      width: rect.width,
      height: rect.height,
      hitIsLabel: hit !== null && label.contains(hit),
      hitDescription,
      gapAboveCaret: caretRect.top - rect.bottom,
      offsetFromCaretLeft: caretRect.left - rect.left,
    };
  });
}

async function expectRemoteLabelOnTop(page: Page, cellText: string): Promise<void> {
  await expect
    .poll(async () => (await hitTestRemoteLabel(page)).labels, {
      message: `one rendered label for the remote caret after "${cellText}"`,
    })
    .toBe(1);
  await expect
    .poll(
      async () => {
        const hit = await hitTestRemoteLabel(page);
        return hit.hitIsLabel ? 'label' : hit.hitDescription;
      },
      { message: `the label for the caret after "${cellText}" is painted on top, unclipped` },
    )
    .toBe('label');
  await expect
    .poll(
      async () => {
        const hit = await hitTestRemoteLabel(page);
        return [Math.round(hit.gapAboveCaret), Math.round(hit.offsetFromCaretLeft)];
      },
      { message: `the label sits just above the caret after "${cellText}", flush with its line` },
    )
    .toEqual([2, 1]);
  const hit = await hitTestRemoteLabel(page);
  expect(hit.width).toBeGreaterThan(10);
  expect(hit.height).toBeGreaterThan(10);
}

async function labelCoveredByToolbar(page: Page): Promise<string> {
  return page.evaluate(() => {
    const label = Array.from(
      document.querySelectorAll<HTMLElement>('.collaboration-cursor__label'),
    ).find((element) => element.getClientRects().length > 0);
    const bar = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="editor-toolbar"] > .bg-background'),
    ).find((element) => element.getClientRects().length > 0);
    if (!label || !bar) return `missing label=${Boolean(label)} toolbar=${Boolean(bar)}`;
    const rect = label.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const barRect = bar.getBoundingClientRect();
    if (y < barRect.top || y > barRect.bottom) return `label centre ${y} outside toolbar band`;
    const previousLabel = label.style.pointerEvents;
    const previousBar = bar.style.pointerEvents;
    label.style.pointerEvents = 'auto';
    bar.style.pointerEvents = 'auto';
    const hit = document.elementFromPoint(x, y);
    label.style.pointerEvents = previousLabel;
    bar.style.pointerEvents = previousBar;
    if (hit !== null && label.contains(hit)) return 'label';
    if (hit !== null && bar.contains(hit)) return 'toolbar';
    return hit ? `${hit.tagName.toLowerCase()}.${Array.from(hit.classList).join('.')}` : 'nothing';
  });
}

async function placeCaretAtStartOfText(page: Page, text: string): Promise<void> {
  const end = (await placeCaretAtEndOfText(page, text)).pmCaret;
  await page.evaluate((start) => {
    window.__activeEditor?.chain().focus().setTextSelection({ from: start, to: start }).run();
  }, end - text.length);
}

async function remoteCaretLinePixels(page: Page): Promise<number> {
  const caret = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>(
      '.ProseMirror .collaboration-cursor__caret',
    );
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left,
      y: rect.top,
      height: rect.height,
      color: getComputedStyle(element).borderLeftColor,
    };
  });
  if (!caret || caret.height < 4) return 0;
  const shot = await page.screenshot({
    clip: {
      x: Math.floor(caret.x) - 2,
      y: Math.floor(caret.y),
      width: 5,
      height: Math.floor(caret.height),
    },
  });
  return page.evaluate(
    async ({ png, color }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      if (!context) return 0;
      context.drawImage(image, 0, 0);
      const [r, g, b] = (color.match(/\d+/g) ?? []).map(Number);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let rows = 0;
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const i = (y * canvas.width + x) * 4;
          const close =
            Math.abs((data[i] ?? 0) - (r ?? 0)) < 40 &&
            Math.abs((data[i + 1] ?? 0) - (g ?? 0)) < 40 &&
            Math.abs((data[i + 2] ?? 0) - (b ?? 0)) < 40;
          if (close) {
            rows++;
            break;
          }
        }
      }
      return rows / canvas.height;
    },
    { png: shot.toString('base64'), color: caret.color },
  );
}

test('a remote caret and its label paint on top, unclipped, in table cells and on block edges', async ({
  page,
  api,
}) => {
  const docName = `test-remote-caret-label-table-${randomUUID().slice(0, 8)}`;
  await api.seedDocs([{ name: docName, markdown: ROLES_TABLE_MARKDOWN }]);

  const remoteTab = await page.context().newPage();
  await Promise.all([page.goto(`/#/${docName}`), remoteTab.goto(`/#/${docName}`)]);
  await Promise.all([waitForActiveProviderSynced(page), waitForActiveProviderSynced(remoteTab)]);
  await expect(page.locator('.ProseMirror table th').first()).toHaveText('Action');
  await expect.poll(() => remoteTab.evaluate(() => Boolean(window.__activeEditor))).toBe(true);

  await placeCaretAtEndOfText(remoteTab, 'Action');
  await expect(page.locator('.ProseMirror th .collaboration-cursor__caret')).toHaveCount(1);
  await expectRemoteLabelOnTop(page, 'Action');

  await placeCaretAtEndOfText(remoteTab, 'Invite people');
  await expect(page.locator('.ProseMirror td .collaboration-cursor__caret')).toHaveCount(1);
  await expectRemoteLabelOnTop(page, 'Invite people');

  await placeCaretAtEndOfText(remoteTab, 'owner-only');
  await expect(page.locator('.ProseMirror td .collaboration-cursor__caret')).toHaveCount(1);
  await expectRemoteLabelOnTop(page, 'owner-only');

  await placeCaretAtEndOfText(remoteTab, 'Who can do what');
  await expect(page.locator('.ProseMirror p .collaboration-cursor__caret')).toHaveCount(1);
  await expectRemoteLabelOnTop(page, 'Who can do what');

  await placeCaretAtStartOfText(remoteTab, 'Trailing paragraph');
  await expect(page.locator('.ProseMirror p .collaboration-cursor__caret')).toHaveCount(1);
  await expect
    .poll(() => remoteCaretLinePixels(page), {
      message: 'a remote caret at the start of a paragraph paints its line along its height',
    })
    .toBeGreaterThan(0.8);
  await expectRemoteLabelOnTop(page, 'the start of "Trailing paragraph"');

  await page.evaluate(() => {
    const caret = document.querySelector('.ProseMirror .collaboration-cursor__caret');
    const scroller = caret?.closest<HTMLElement>('[data-testid="editor-scroll-container"]');
    if (!caret || !scroller) throw new Error('caret or editor scroll container missing');
    scroller.scrollTop +=
      caret.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 30;
  });
  await expect
    .poll(() => labelCoveredByToolbar(page), {
      message: 'a label whose caret sits under the editor toolbar stays beneath the toolbar',
    })
    .toBe('toolbar');
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('[data-testid="editor-scroll-container"]')?.scrollTo(0, 0);
  });

  await page.evaluate(() => {
    document.documentElement.dir = 'rtl';
  });
  await placeCaretAtEndOfText(remoteTab, 'Invite people');
  await expect(page.locator('.ProseMirror td .collaboration-cursor__caret')).toHaveCount(1);
  await expectRemoteLabelOnTop(page, 'Invite people, in a right-to-left interface');

  await remoteTab.close();
});

const WIDE_TABLE_MARKDOWN = `# Quarterly metrics

| Metric | Jan | Feb | Mar | Apr | May | Jun | Jul | Aug | Sep | Oct | Nov | Dec | Far right column |
|--------|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|------------------|
| Revenue | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | rightmost-value |

Paragraph after the wide table.
`;

test('a label whose caret is scrolled out of a wide table does not widen the document', async ({
  page,
  api,
}) => {
  const docName = `test-remote-caret-label-wide-${randomUUID().slice(0, 8)}`;
  await api.seedDocs([{ name: docName, markdown: WIDE_TABLE_MARKDOWN }]);

  const remoteTab = await page.context().newPage();
  await Promise.all([page.goto(`/#/${docName}`), remoteTab.goto(`/#/${docName}`)]);
  await Promise.all([waitForActiveProviderSynced(page), waitForActiveProviderSynced(remoteTab)]);
  await expect.poll(() => remoteTab.evaluate(() => Boolean(window.__activeEditor))).toBe(true);
  await expect.poll(() => page.evaluate(() => Boolean(window.__activeEditor))).toBe(true);

  const overflow = () =>
    page.evaluate(() => {
      const wrapper = Array.from(
        document.querySelectorAll<HTMLElement>('.ProseMirror .tableWrapper'),
      ).find((element) => element.getClientRects().length > 0);
      const scroller = wrapper?.closest<HTMLElement>('[data-testid="editor-scroll-container"]');
      if (!wrapper || !scroller)
        throw new Error('table wrapper or editor scroll container missing');
      return {
        tableScrolls: wrapper.scrollWidth > wrapper.clientWidth,
        documentExtraWidth: scroller.scrollWidth - scroller.clientWidth,
      };
    });
  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('no active editor');
    const { state } = editor;
    const tr = state.tr;
    state.doc.descendants((node, pos) => {
      const role = node.type.spec.tableRole;
      if (role === 'cell' || role === 'header_cell') {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, colwidth: [160] });
      }
    });
    editor.view.dispatch(tr);
  });
  await expect
    .poll(async () => (await overflow()).tableScrolls, {
      message: 'the table overflows its wrapper',
    })
    .toBe(true);
  const baseline = (await overflow()).documentExtraWidth;

  await placeCaretAtEndOfText(remoteTab, 'rightmost-value');
  await expect(page.locator('.ProseMirror td .collaboration-cursor__caret')).toHaveCount(1);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            document.querySelector<HTMLElement>('.collaboration-cursor__label')?.style.visibility,
        ),
      { message: 'the label of a caret scrolled out of the table is hidden' },
    )
    .toBe('hidden');
  expect((await overflow()).documentExtraWidth, 'the hidden label adds no horizontal scroll').toBe(
    baseline,
  );

  await remoteTab.close();
});
