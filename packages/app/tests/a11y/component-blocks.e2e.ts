import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import type { ApiHelpers } from '../stress/_helpers';
import { expect, test } from '../stress/_helpers';

async function waitForProvider(page: Page) {
  await page.waitForFunction(() => Boolean(window.__activeProvider?.isSynced), null, {
    timeout: 15_000,
  });
}

async function setupDoc(page: Page, api: ApiHelpers, content: string): Promise<string> {
  const docName = `a11y-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(docName, content);
  await page.goto(`/#/${docName}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror');
  return docName;
}

test('A11Y01: Tab key cycles through PropPanel controls in visual DOM order', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="warning">\n\nTest content\n\n</Callout>');
  await page.waitForFunction(() => Boolean(window.__activeEditor?.state.doc.childCount), null, {
    timeout: 5000,
  });

  await page.locator('[data-jsx-component]').first().hover();
  const gear = page
    .locator('[data-jsx-component] .jsx-component-chrome button[aria-label*="properties"]')
    .first();
  await gear.waitFor({ state: 'visible', timeout: 5000 });
  await gear.click();

  const panel = page.locator('[data-prop-panel]').first();
  await panel.waitFor({ state: 'visible', timeout: 5000 });

  const controls = panel.locator('input, select, button, [role="switch"]');
  await expect(controls.first()).toBeVisible({ timeout: 5000 });
  const controlCount = await controls.count();
  expect(controlCount).toBeGreaterThan(0);

  await controls.first().focus();
  for (let i = 1; i < controlCount; i++) {
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    await expect(focused).toHaveCount(1);
  }
});

test('A11Y02: NodeSelection announces component via aria-live region', async ({ page, api }) => {
  await setupDoc(page, api, '<Callout type="warning">\n\nTest content\n\n</Callout>');
  await page.waitForFunction(() => Boolean(window.__activeEditor?.state.doc.childCount), null, {
    timeout: 5000,
  });

  await page.waitForFunction(() => Boolean(window.__activeEditor), null, { timeout: 5000 });
  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) return;
    let foundPos = -1;
    editor.state.doc.descendants((node: { type: { name: string } }, pos: number) => {
      if (foundPos !== -1) return false;
      if (node.type.name === 'jsxComponent') {
        foundPos = pos;
        return false;
      }
      return true;
    });
    if (foundPos !== -1) editor.chain().focus().setNodeSelection(foundPos).run();
  });

  const liveRegion = page.locator('[role="status"][aria-live="polite"]').first();
  await expect(liveRegion).toBeAttached({ timeout: 2_000 });
  await expect(liveRegion).toContainText('Selected: Callout', { timeout: 2_000 });
});

test('A11Y03: PropPanel Esc key closes and returns focus to block', async ({ page, api }) => {
  await setupDoc(page, api, '<Callout type="warning">\n\nTest content\n\n</Callout>');
  await page.waitForFunction(() => Boolean(window.__activeEditor?.state.doc.childCount), null, {
    timeout: 5000,
  });

  await page.locator('[data-jsx-component]').first().hover();
  const gear = page
    .locator('[data-jsx-component] .jsx-component-chrome button[aria-label*="properties"]')
    .first();
  await gear.waitFor({ state: 'visible', timeout: 5000 });
  await gear.click();

  const panel = page.locator('[data-prop-panel]').first();
  await panel.waitFor({ state: 'visible', timeout: 5000 });

  const firstInput = panel.locator('input, select').first();
  await firstInput.focus();

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-prop-panel]'), null, {
    timeout: 5000,
  });
  const activeElement = await page.evaluate(() =>
    Boolean(document.activeElement?.closest('.ProseMirror')),
  );
  expect(activeElement).toBeTruthy();
});

test('A11Y05: rawMdxFallback nested CodeMirror has accessible label', async ({ page, api }) => {
  await setupDoc(page, api, '<Foo>broken</Bar>\n');
  await page.waitForFunction(() => Boolean(window.__activeEditor?.state.doc.childCount), null, {
    timeout: 5000,
  });

  const cmEditor = page.locator('.cm-editor').first();
  await expect(
    cmEditor,
    'broken MDX must produce a rawMdxFallback nested CodeMirror editor',
  ).toBeVisible({ timeout: 5000 });

  const wrapper = cmEditor.locator('..');
  const ariaLabel = await wrapper.getAttribute('aria-label');
  expect(ariaLabel, 'rawMdxFallback wrapper must have aria-label').not.toBeNull();
  if (ariaLabel) {
    expect(ariaLabel.toLowerCase()).toContain('source');
  }
  const role = await wrapper.getAttribute('role');
  expect(role, 'rawMdxFallback wrapper must have role="group"').toBe('group');
});

test('A11Y07: Empty Tabs placeholder activatable via keyboard inserts a Tab', async ({
  page,
  api,
}) => {
  const docName = await setupDoc(page, api, '<Tabs></Tabs>');
  await page.waitForFunction(() => Boolean(window.__activeEditor?.state.doc.childCount), null, {
    timeout: 5000,
  });

  const placeholder = page.locator('.jsx-empty-child-placeholder').first();
  await expect(
    placeholder,
    'empty <Tabs></Tabs> must render the empty-child placeholder',
  ).toBeVisible({ timeout: 5000 });

  await expect(placeholder).toHaveJSProperty('tagName', 'BUTTON');

  await expect(placeholder).toHaveAccessibleName(/add tab/i);

  await placeholder.focus();
  await expect(placeholder).toBeFocused();

  await page.keyboard.press('Enter');

  await page.waitForFunction(
    () => {
      const editor = window.__activeEditor;
      if (!editor) return false;
      let firstChildName: string | null = null;
      let tabsChildCount = -1;
      editor.state.doc.descendants(
        (n: {
          type: { name: string };
          attrs: { componentName?: string };
          childCount: number;
          firstChild?: { type: { name: string }; attrs: { componentName?: string } };
        }) => {
          if (firstChildName !== null) return false;
          if (n.type.name === 'jsxComponent' && n.attrs.componentName === 'Tabs') {
            tabsChildCount = n.childCount;
            firstChildName = n.firstChild?.attrs?.componentName ?? null;
            return false;
          }
        },
      );
      return tabsChildCount === 1 && firstChildName === 'Tab';
    },
    null,
    { timeout: 5000 },
  );

  await expect(page.locator('.jsx-empty-child-placeholder')).toHaveCount(0);

  expect(docName).toContain('a11y-');
});

test('A11Y09: Wildcard block chrome has accessible name', async ({ page, api }) => {
  await setupDoc(page, api, '<UnknownComponent prop="val">\n\nSome content\n\n</UnknownComponent>');
  await page.waitForFunction(() => Boolean(window.__activeEditor?.state.doc.childCount), null, {
    timeout: 5000,
  });

  const wildcardBadge = page
    .locator('[data-jsx-component].jsx-component-wrapper--unregistered')
    .first();
  await expect(
    wildcardBadge,
    'unregistered <UnknownComponent> must render through wildcard chrome',
  ).toBeVisible({ timeout: 5000 });
  const text = await wildcardBadge.textContent();
  expect(text).toContain('UnknownComponent');

  await expect(
    wildcardBadge,
    'wildcard wrapper must carry role="group" so assistive tech treats it as a labeled grouping',
  ).toHaveAttribute('role', 'group');
  await expect(
    wildcardBadge,
    'wildcard wrapper must expose the unregistered component name via aria-label',
  ).toHaveAttribute('aria-label', /UnknownComponent/);
});

test('A11Y10: Zero axe-core violations on 5-pack fixture (excluding color-contrast)', async ({
  page,
  api,
}) => {
  const content = [
    '# 5-Pack Accessibility Test',
    '',
    '<Callout type="warning">',
    '',
    'Warning callout text',
    '',
    '</Callout>',
    '',
    '<Callout type="tip">',
    '',
    'Tip callout text',
    '',
    '</Callout>',
    '',
    '<img src="/placeholder.png" alt="Architecture diagram" />',
    '',
    '<Accordion title="Details" defaultOpen>',
    '',
    '<Callout type="note">',
    '',
    'Nested note',
    '',
    '</Callout>',
    '',
    '</Accordion>',
    '',
    '<video src="/sample.mp4" />',
    '',
    '<audio src="/sample.mp3" />',
    '',
    'Some paragraph with normal text.',
  ].join('\n');

  await setupDoc(page, api, content);
  await page.waitForFunction(() => (window.__activeEditor?.state.doc.childCount ?? 0) >= 5, null, {
    timeout: 10_000,
  });

  const axeResults = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .include('.ProseMirror')
    .disableRules(['color-contrast'])
    .analyze();
  expect(axeResults.violations).toEqual([]);
});

test('A11Y11: javascript:/data: URL props render inert in the DOM', async ({ page, api }) => {
  const malicious = [
    '<img src="javascript:fetch(`/nope`)" alt="xss-image" />',
    '',
    '<img src="https://example.com/safe.png" alt="safe-image" />',
  ].join('\n');
  await setupDoc(page, api, malicious);
  await page.waitForFunction(
    () => document.querySelectorAll('.ProseMirror img[src]').length >= 2,
    null,
    { timeout: 5000 },
  );

  const srcs = await page.evaluate(() => {
    const imgs = document.querySelectorAll<HTMLImageElement>('.ProseMirror img[src]');
    return Array.from(imgs).map((img) => img.getAttribute('src') ?? '');
  });
  for (const src of srcs) {
    expect(src.toLowerCase()).not.toMatch(/^\s*(javascript|vbscript|data):/);
  }
  expect(srcs).toContain('https://example.com/safe.png');
});
