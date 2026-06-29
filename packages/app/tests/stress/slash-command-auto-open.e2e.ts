
import { expect, test, waitForActiveProviderSynced, waitForSlashMenuFirstOption } from './_helpers';


const PROP_PANEL_TIMEOUT = 1_000;


test('SLASH-AUTOOPEN-IMG: slash-inserting Image auto-opens its PropPanel', async ({
  page,
  api,
}) => {
  const docName = `slash-autoopen-img-${Math.random().toString(36).slice(2, 10)}`;
  await api.createPage(`${docName}.md`);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror');
  await waitForActiveProviderSynced(page);
  await page.click('.ProseMirror');

  await page.keyboard.type('/image');
  await waitForSlashMenuFirstOption(page, 'image');
  await page.keyboard.press('Enter');

  await expect(page.locator('[data-prop-panel]')).toBeVisible({ timeout: PROP_PANEL_TIMEOUT });
});

test('SLASH-AUTOOPEN-VIDEO: slash-inserting Video auto-opens its PropPanel', async ({
  page,
  api,
}) => {
  const docName = `slash-autoopen-video-${Math.random().toString(36).slice(2, 10)}`;
  await api.createPage(`${docName}.md`);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror');
  await waitForActiveProviderSynced(page);
  await page.click('.ProseMirror');

  await page.keyboard.type('/video');
  await waitForSlashMenuFirstOption(page, 'video');
  await page.keyboard.press('Enter');

  await expect(page.locator('[data-prop-panel]')).toBeVisible({ timeout: PROP_PANEL_TIMEOUT });
});

test('SLASH-AUTOOPEN-CALLOUT: slash-inserting Callout auto-opens its PropPanel', async ({
  page,
  api,
}) => {
  const docName = `slash-autoopen-callout-${Math.random().toString(36).slice(2, 10)}`;
  await api.createPage(`${docName}.md`);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror');
  await waitForActiveProviderSynced(page);
  await page.click('.ProseMirror');

  await page.keyboard.type('/callout');
  await waitForSlashMenuFirstOption(page, 'callout');
  await page.keyboard.press('Enter');

  await expect(page.locator('[data-prop-panel]')).toBeVisible({ timeout: PROP_PANEL_TIMEOUT });
});

test('SLASH-AUTOOPEN-IMG-MULTI: slash-inserting Image with a prior Image auto-opens the NEW one', async ({
  page,
  api,
}) => {
  const docName = `slash-autoopen-img-multi-${Math.random().toString(36).slice(2, 10)}`;
  await api.seedDocs([{ name: docName, markdown: '<img src="prior-marker.png" />\n\n\n' }]);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror');
  await waitForActiveProviderSynced(page);

  await expect(page.locator('[data-jsx-component]')).toHaveCount(1);

  await page.click('.ProseMirror');
  await page.keyboard.press('ControlOrMeta+End');

  await page.keyboard.type('/image');
  await waitForSlashMenuFirstOption(page, 'image');
  await page.keyboard.press('Enter');

  await expect(page.locator('[data-jsx-component]')).toHaveCount(2);
  await expect(page.locator('[data-prop-panel]')).toBeVisible({ timeout: PROP_PANEL_TIMEOUT });

  const selectedSrc = await page.evaluate(() => {
    const ed = (window as unknown as { __activeEditor?: { state: { selection: unknown } } })
      .__activeEditor;
    if (!ed) return null;
    const sel = ed.state.selection as {
      node?: { attrs: { componentName?: string; props?: Record<string, unknown> } };
    };
    if (!sel.node) return null;
    return {
      componentName: sel.node.attrs.componentName,
      src: sel.node.attrs.props?.src ?? null,
    };
  });

  expect(selectedSrc).not.toBeNull();
  expect(selectedSrc?.componentName).toBe('img');
  expect(selectedSrc?.src).not.toBe('prior-marker.png');
});

test('PLACEHOLDER-RENDERS-FRESH: slash-inserted img shows placeholder + auto-opens panel', async ({
  page,
  api,
}) => {
  const docName = `placeholder-renders-fresh-${Math.random().toString(36).slice(2, 10)}`;
  await api.createPage(`${docName}.md`);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror');
  await waitForActiveProviderSynced(page);
  await page.click('.ProseMirror');

  await page.keyboard.type('/image');
  await waitForSlashMenuFirstOption(page, 'image');
  await page.keyboard.press('Enter');

  await expect(page.locator('[data-descriptor-placeholder]')).toBeVisible({
    timeout: PROP_PANEL_TIMEOUT,
  });
  await expect(page.locator('[data-prop-panel]')).toBeVisible({ timeout: PROP_PANEL_TIMEOUT });
});

test('PLACEHOLDER-CLICK-OPENS-PANEL: clicking placeholder NodeSelects + reopens PropPanel', async ({
  page,
  api,
}) => {
  const docName = `placeholder-click-opens-${Math.random().toString(36).slice(2, 10)}`;
  await api.createPage(`${docName}.md`);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror');
  await waitForActiveProviderSynced(page);
  await page.click('.ProseMirror');

  await page.keyboard.type('/image');
  await waitForSlashMenuFirstOption(page, 'image');
  await page.keyboard.press('Enter');

  await expect(page.locator('[data-prop-panel]')).toBeVisible({ timeout: PROP_PANEL_TIMEOUT });

  await page.keyboard.press('Escape');
  await expect(page.locator('[data-prop-panel]')).toBeHidden({ timeout: PROP_PANEL_TIMEOUT });
  await expect(page.locator('[data-descriptor-placeholder]')).toBeVisible();

  await page.locator('[data-descriptor-placeholder]').click();
  await expect(page.locator('[data-prop-panel]')).toBeVisible({ timeout: PROP_PANEL_TIMEOUT });

  const selected = await page.evaluate(() => {
    const ed = (window as unknown as { __activeEditor?: { state: { selection: unknown } } })
      .__activeEditor;
    if (!ed) return null;
    const sel = ed.state.selection as {
      node?: { attrs: { componentName?: string } };
    };
    return sel.node?.attrs.componentName ?? null;
  });
  expect(selected).toBe('img');
});

test('PLACEHOLDER-FILL-DISMISSES: filling src dismisses placeholder, real img renders', async ({
  page,
  api,
}) => {
  const docName = `placeholder-fill-dismisses-${Math.random().toString(36).slice(2, 10)}`;
  await api.createPage(`${docName}.md`);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror');
  await waitForActiveProviderSynced(page);
  await page.click('.ProseMirror');

  await page.keyboard.type('/image');
  await waitForSlashMenuFirstOption(page, 'image');
  await page.keyboard.press('Enter');

  await expect(page.locator('[data-descriptor-placeholder]')).toBeVisible({
    timeout: PROP_PANEL_TIMEOUT,
  });
  const autofocusedInput = page.locator('[data-prop-autofocus]');
  await expect(autofocusedInput).toBeVisible();

  await autofocusedInput.fill('/test.png');
  await page.keyboard.press('Tab');

  await expect(page.locator('[data-descriptor-placeholder]')).toHaveCount(0);
  await expect(
    page.locator('.jsx-component-wrapper[data-component-type="img"] img'),
  ).toHaveAttribute('src', '/test.png');
});

test('PLACEHOLDER-CONTAINER-EXCLUDED: slash-inserting /callout does NOT show placeholder', async ({
  page,
  api,
}) => {
  const docName = `placeholder-container-excluded-${Math.random().toString(36).slice(2, 10)}`;
  await api.createPage(`${docName}.md`);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror');
  await waitForActiveProviderSynced(page);
  await page.click('.ProseMirror');

  await page.keyboard.type('/callout');
  await waitForSlashMenuFirstOption(page, 'callout');
  await page.keyboard.press('Enter');

  await expect(page.locator('[data-jsx-component][data-component-type="callout"]')).toBeVisible({
    timeout: PROP_PANEL_TIMEOUT,
  });
  await expect(page.locator('[data-descriptor-placeholder]')).toHaveCount(0);
});

test('PLACEHOLDER-CHROME-VISIBLE: chrome bar (gear, delete) renders alongside the placeholder pill', async ({
  page,
  api,
}) => {
  const docName = `placeholder-chrome-visible-${Math.random().toString(36).slice(2, 10)}`;
  await api.createPage(`${docName}.md`);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror');
  await waitForActiveProviderSynced(page);
  await page.click('.ProseMirror');

  await page.keyboard.type('/image');
  await waitForSlashMenuFirstOption(page, 'image');
  await page.keyboard.press('Enter');

  await expect(page.locator('[data-descriptor-placeholder]')).toBeVisible({
    timeout: PROP_PANEL_TIMEOUT,
  });

  await page.keyboard.press('Escape');

  const wrapper = page.locator('[data-jsx-component]').first();
  await expect(wrapper.locator('.jsx-component-chrome')).toBeAttached();
  await expect(wrapper.locator('button[aria-label*="properties"]')).toBeAttached();
  await expect(wrapper.locator('button[aria-label*="Delete"]')).toBeAttached();
});

test('PLACEHOLDER-DOM-SHAPE: placeholder is a div (not button) and is full-width', async ({
  page,
  api,
}) => {
  const docName = `placeholder-dom-shape-${Math.random().toString(36).slice(2, 10)}`;
  await api.createPage(`${docName}.md`);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror');
  await waitForActiveProviderSynced(page);
  await page.click('.ProseMirror');

  await page.keyboard.type('/image');
  await waitForSlashMenuFirstOption(page, 'image');
  await page.keyboard.press('Enter');

  const placeholder = page.locator('[data-descriptor-placeholder]');
  await expect(placeholder).toBeVisible({ timeout: PROP_PANEL_TIMEOUT });

  const shape = await placeholder.evaluate((el) => {
    const wrapper = el.closest('[data-jsx-component]');
    return {
      tagName: el.tagName,
      role: el.getAttribute('role'),
      placeholderWidth: el.getBoundingClientRect().width,
      editorWidth: wrapper?.parentElement?.getBoundingClientRect().width ?? 0,
    };
  });

  expect(shape.tagName).toBe('DIV');
  expect(shape.role).toBe('button');
  expect(shape.placeholderWidth).toBeGreaterThanOrEqual(shape.editorWidth - 2);
});

test('PLACEHOLDER-CLOSE-ADVANCES-CARET: PM selection lands past the image after panel close', async ({
  page,
  api,
}) => {
  const docName = `placeholder-close-caret-${Math.random().toString(36).slice(2, 10)}`;
  await api.createPage(`${docName}.md`);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror');
  await waitForActiveProviderSynced(page);
  await page.click('.ProseMirror');

  await page.keyboard.type('/image');
  await waitForSlashMenuFirstOption(page, 'image');
  await page.keyboard.press('Enter');

  await expect(page.locator('[data-prop-panel]')).toBeVisible({ timeout: PROP_PANEL_TIMEOUT });

  const srcInput = page.locator('[data-prop-panel] input#prop-src');
  await srcInput.fill('https://example.com/test.png');

  await page.keyboard.press('Escape');
  await expect(page.locator('[data-prop-panel]')).toBeHidden({ timeout: PROP_PANEL_TIMEOUT });

  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

  const result = await page.evaluate(() => {
    interface PmNode {
      type: { name: string };
      nodeSize: number;
      attrs: { componentName?: string };
    }
    interface WindowEditor {
      state: {
        selection: { from: number };
        doc: PmNode & {
          descendants: (cb: (n: PmNode, p: number) => boolean | undefined) => void;
        };
      };
    }
    const ed = (window as unknown as { __activeEditor?: WindowEditor }).__activeEditor;
    if (!ed) return null;
    let imgPos = -1;
    let imgSize = 0;
    ed.state.doc.descendants((n, p) => {
      if (n.type.name === 'jsxComponent' && n.attrs.componentName === 'img' && imgPos === -1) {
        imgPos = p;
        imgSize = n.nodeSize;
      }
    });
    return { selectionFrom: ed.state.selection.from, imgPos, imgEnd: imgPos + imgSize };
  });

  expect(result).not.toBeNull();
  expect(result?.imgPos).toBeGreaterThanOrEqual(0);
  expect(result?.selectionFrom).toBeGreaterThanOrEqual(result?.imgEnd ?? 0);
});

test('PLACEHOLDER-CLOSE-RETURNS-DOM-FOCUS: typing after Escape lands keystrokes in the editor', async ({
  page,
  api,
}) => {
  const docName = `placeholder-close-focus-${Math.random().toString(36).slice(2, 10)}`;
  await api.createPage(`${docName}.md`);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror');
  await waitForActiveProviderSynced(page);
  await page.click('.ProseMirror');

  await page.keyboard.type('/image');
  await waitForSlashMenuFirstOption(page, 'image');
  await page.keyboard.press('Enter');

  await expect(page.locator('[data-prop-panel]')).toBeVisible({ timeout: PROP_PANEL_TIMEOUT });

  const srcInput = page.locator('[data-prop-panel] input#prop-src');
  await srcInput.fill('https://example.com/test.png');

  await page.keyboard.press('Escape');
  await expect(page.locator('[data-prop-panel]')).toBeHidden({ timeout: PROP_PANEL_TIMEOUT });

  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

  const SENTINEL = 'keep-typing-canary';
  await page.keyboard.type(SENTINEL);

  const result = await page.evaluate((sentinel) => {
    interface PmNode {
      type: { name: string };
      nodeSize: number;
      attrs: { componentName?: string };
    }
    interface WindowEditor {
      state: {
        doc: PmNode & {
          textContent: string;
          descendants: (cb: (n: PmNode, p: number) => boolean | undefined) => void;
        };
      };
      view: { dom: HTMLElement };
    }
    const ed = (window as unknown as { __activeEditor?: WindowEditor }).__activeEditor;
    if (!ed) return null;
    const focusInEditor = ed.view.dom.contains(document.activeElement);
    const docText = ed.state.doc.textContent;
    let imgPos = -1;
    ed.state.doc.descendants((n, p) => {
      if (n.type.name === 'jsxComponent' && n.attrs.componentName === 'img' && imgPos === -1) {
        imgPos = p;
      }
    });
    return {
      focusInEditor,
      sentinelInDoc: docText.includes(sentinel),
      imgFound: imgPos >= 0,
    };
  }, SENTINEL);

  expect(result).not.toBeNull();
  expect(result?.imgFound).toBe(true);
  expect(result?.focusInEditor).toBe(true);
  expect(result?.sentinelInDoc).toBe(true);
});
