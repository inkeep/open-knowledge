import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

interface ApiSeed {
  seedDocs: (docs: Array<{ name: string; markdown: string }>) => Promise<void>;
}

async function setupDoc(page: Page, api: ApiSeed, markdown: string): Promise<string> {
  const docName = `backspace-${randomUUID().slice(0, 8)}`;
  await api.seedDocs([{ name: docName, markdown }]);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror');
  await page.waitForFunction(() => Boolean(window.__activeEditor), null, { timeout: 5_000 });
  return docName;
}

async function jsxNodeCount(page: Page, componentName: string): Promise<number> {
  return page.evaluate((name) => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    let count = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'jsxComponent' && (node.attrs.componentName as string) === name) {
        count += 1;
      }
      return true;
    });
    return count;
  }, componentName);
}

async function nodeSelectFirstJsx(page: Page, componentName: string) {
  await page.evaluate((name) => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (pos !== -1) return false;
      if (node.type.name === 'jsxComponent' && (node.attrs.componentName as string) === name) {
        pos = p;
        return false;
      }
      return true;
    });
    if (pos === -1) throw new Error(`jsxComponent ${name} not found`);
    editor.chain().focus().setNodeSelection(pos).run();
  }, componentName);
}

async function selectionType(page: Page): Promise<string> {
  return page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    return editor.state.selection.constructor.name;
  });
}

/** Drift PM's selection inside the wrapper's body — mirrors what happens when
 *  Radix `onCloseAutoFocus` returns focus to the trigger button: PM observes
 *  a focus change and resolves a TextSelection at the nearest in-body
 *  position. We do the drift explicitly to keep the test deterministic
 *  across Radix versions. */
async function driftSelectionIntoFirstJsxBody(page: Page, componentName: string) {
  await page.evaluate((name) => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (pos !== -1) return false;
      if (node.type.name === 'jsxComponent' && (node.attrs.componentName as string) === name) {
        pos = p;
        return false;
      }
      return true;
    });
    if (pos === -1) throw new Error(`jsxComponent ${name} not found`);
    editor
      .chain()
      .setTextSelection(pos + 2)
      .run();
  }, componentName);
}

test('AC14: Backspace deletes a NodeSelected Accordion when focus is on <summary>', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Accordion title="A">\n\nbody\n\n</Accordion>\n\nafter\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');
  expect(await jsxNodeCount(page, 'Accordion')).toBe(1);

  await nodeSelectFirstJsx(page, 'Accordion');
  expect(await selectionType(page)).toBe('NodeSelection');

  await page.evaluate(() => {
    const summary = document.querySelector(
      '.jsx-component-wrapper[data-component-type="accordion"] summary',
    ) as HTMLElement | null;
    if (!summary) throw new Error('summary not found');
    summary.focus();
    summary.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }),
    );
  });

  await expect.poll(() => jsxNodeCount(page, 'Accordion'), { timeout: 2_000 }).toBe(0);
});

test('AC14: Delete key deletes a NodeSelected Accordion when focus is on <summary>', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Accordion title="B">\n\nbody\n\n</Accordion>\n\nafter\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');
  expect(await jsxNodeCount(page, 'Accordion')).toBe(1);

  await nodeSelectFirstJsx(page, 'Accordion');
  await page.evaluate(() => {
    const summary = document.querySelector(
      '.jsx-component-wrapper[data-component-type="accordion"] summary',
    );
    (summary as HTMLElement | null)?.focus();
  });

  await page.keyboard.press('Delete');

  await expect.poll(() => jsxNodeCount(page, 'Accordion'), { timeout: 2_000 }).toBe(0);
});

test('AC15: gear-click → Esc-close restores NodeSelection (FR16 round-trip)', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Accordion title="C">\n\nbody\n\n</Accordion>\n\nafter\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');
  expect(await jsxNodeCount(page, 'Accordion')).toBe(1);

  await nodeSelectFirstJsx(page, 'Accordion');
  const wrapper = page.locator('.jsx-component-wrapper[data-component-type="accordion"]').first();
  await wrapper.hover();
  const gear = wrapper.locator('button[aria-label*="properties"]').first();
  await gear.waitFor({ state: 'visible', timeout: 5_000 });
  await gear.click({ force: true });
  await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]');

  await driftSelectionIntoFirstJsxBody(page, 'Accordion');
  expect(await selectionType(page)).toBe('TextSelection');

  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]', {
    state: 'detached',
    timeout: 5_000,
  });

  await expect.poll(() => selectionType(page), { timeout: 2_000 }).toBe('NodeSelection');
});

test('AC16: programmatic close restores NodeSelection on the wrapper', async ({ page, api }) => {
  await setupDoc(page, api, '<Accordion title="D">\n\nbody\n\n</Accordion>\n\nafter\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');

  await nodeSelectFirstJsx(page, 'Accordion');
  const wrapper = page.locator('.jsx-component-wrapper[data-component-type="accordion"]').first();
  await wrapper.hover();
  const gear = wrapper.locator('button[aria-label*="properties"]').first();
  await gear.waitFor({ state: 'visible', timeout: 5_000 });
  await gear.click({ force: true });
  await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]');

  await driftSelectionIntoFirstJsxBody(page, 'Accordion');
  expect(await selectionType(page)).toBe('TextSelection');

  await gear.click({ force: true });
  await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]', {
    state: 'detached',
    timeout: 5_000,
  });

  await expect.poll(() => selectionType(page), { timeout: 2_000 }).toBe('NodeSelection');
});

test('AC16: selection-still-inside guard does NOT restore when click-outside moves PM into a distant paragraph', async ({
  page,
  api,
}) => {
  await setupDoc(
    page,
    api,
    'first paragraph\n\n<Accordion title="E">\n\nbody\n\n</Accordion>\n\nafter\n',
  );
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');

  await nodeSelectFirstJsx(page, 'Accordion');
  const wrapper = page.locator('.jsx-component-wrapper[data-component-type="accordion"]').first();
  await wrapper.hover();
  const gear = wrapper.locator('button[aria-label*="properties"]').first();
  await gear.waitFor({ state: 'visible', timeout: 5_000 });
  await gear.click({ force: true });
  await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]');

  await page.evaluate(() => {
    const editor = window.__activeEditor;
    editor?.chain().setTextSelection(1).run();
  });
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]', {
    state: 'detached',
    timeout: 5_000,
  });

  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  expect(await selectionType(page)).toBe('TextSelection');
});

test('AC17: Backspace deletes a NodeSelected Callout when focus is on a chrome button', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="note">\n\nbody\n\n</Callout>\n\nafter\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');
  expect(await jsxNodeCount(page, 'Callout')).toBe(1);

  await nodeSelectFirstJsx(page, 'Callout');
  const wrapper = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await wrapper.hover();
  const gear = wrapper.locator('button[aria-label*="properties"]').first();
  await gear.waitFor({ state: 'visible', timeout: 5_000 });
  await gear.focus();

  await page.keyboard.press('Backspace');

  await expect.poll(() => jsxNodeCount(page, 'Callout'), { timeout: 2_000 }).toBe(0);
});

test('FR17 regression: cursor in a regular paragraph + Backspace deletes one character', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, 'hello world\n\n<Callout type="note">\n\nbody\n\n</Callout>\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');

  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    editor.chain().focus().setTextSelection(12).run();
  });
  expect(await selectionType(page)).toBe('TextSelection');

  await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror') as HTMLElement | null;
    pm?.focus();
  });

  await page.keyboard.press('Backspace');

  const firstParagraphText = await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) return '';
    return editor.state.doc.firstChild?.textContent ?? '';
  });
  expect(firstParagraphText).toBe('hello worl');
  expect(await jsxNodeCount(page, 'Callout')).toBe(1);
});

interface PortalKeyCase {
  readonly key: 'Backspace' | 'Delete';
  readonly cursorTo: 'end' | 'start';
  readonly expected: string;
}

const PORTAL_KEY_CASES: readonly PortalKeyCase[] = [
  { key: 'Backspace', cursorTo: 'end', expected: 'Hello Worl' },
  { key: 'Delete', cursorTo: 'start', expected: 'ello World' },
];

for (const { key, cursorTo, expected } of PORTAL_KEY_CASES) {
  test(`portal guard: ${key} in PopoverContent title input edits the input, not the block`, async ({
    page,
    api,
  }) => {
    await setupDoc(
      page,
      api,
      '<Callout type="note" title="Hello">\n\nbody\n\n</Callout>\n\nafter\n',
    );
    await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');
    expect(await jsxNodeCount(page, 'Callout')).toBe(1);

    await nodeSelectFirstJsx(page, 'Callout');
    const wrapper = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
    await wrapper.hover();
    const gear = wrapper.locator('button[aria-label*="properties"]').first();
    await gear.waitFor({ state: 'visible', timeout: 5_000 });
    await gear.click({ force: true });
    await page.waitForSelector('[data-slot="popover-trigger"][data-state="open"]');

    const titleInput = page.locator('[data-slot="popover-content"] input[type="text"]').first();
    await titleInput.waitFor({ state: 'visible', timeout: 5_000 });
    await titleInput.focus();

    await titleInput.fill('Hello World');
    if (cursorTo === 'start') {
      await titleInput.evaluate((el) => {
        (el as HTMLInputElement).setSelectionRange(0, 0);
      });
    }
    await page.keyboard.press(key);

    await expect.poll(() => jsxNodeCount(page, 'Callout'), { timeout: 2_000 }).toBe(1);

    await expect.poll(() => titleInput.inputValue(), { timeout: 2_000 }).toBe(expected);
  });
}

test('AC19: cursor inside a JSX wrapper body + Backspace deletes one character (not the wrapper)', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="note">\n\nhello world\n\n</Callout>\n\nafter\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');
  expect(await jsxNodeCount(page, 'Callout')).toBe(1);

  const beforeText = await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('window.__activeEditor not set');
    let endOfTextPos = -1;
    let bodyText = '';
    editor.state.doc.descendants((node, pos) => {
      if (endOfTextPos !== -1) return false;
      if (node.isText && (node.text ?? '').includes('hello world')) {
        endOfTextPos = pos + (node.text?.length ?? 0);
        bodyText = node.text ?? '';
        return false;
      }
      return true;
    });
    if (endOfTextPos === -1) throw new Error('Callout body text not found');
    editor.chain().focus().setTextSelection(endOfTextPos).run();
    return bodyText;
  });
  expect(beforeText).toBe('hello world');
  expect(await selectionType(page)).toBe('TextSelection');

  await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror') as HTMLElement | null;
    pm?.focus();
  });

  await page.keyboard.press('Backspace');

  const afterText = await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) return '';
    let text = '';
    editor.state.doc.descendants((node) => {
      if (node.type.name !== 'jsxComponent') return true;
      if ((node.attrs.componentName as string) !== 'Callout') return true;
      node.descendants((child) => {
        if (child.isText) {
          text = child.text ?? '';
          return false;
        }
        return true;
      });
      return false;
    });
    return text;
  });
  expect(afterText).toBe('hello worl');
  expect(await jsxNodeCount(page, 'Callout')).toBe(1);
});
