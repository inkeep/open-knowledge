
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { ApiHelpers } from './_helpers';
import { expect, focusEditor, test, waitForPmSelectionInNode } from './_helpers';

/** Per-test fixture setup: create an isolated doc, seed markdown, navigate.
 *  Each test owns its own docName so parallel workers don't collide. */
async function setupDoc(page: Page, api: ApiHelpers, markdown: string): Promise<string> {
  const docName = `test-sel-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.testReset(docName);
  await api.replaceDoc(docName, markdown);
  await page.goto(`/#/${docName}`);
  await page.waitForFunction(() => Boolean(window.__activeProvider?.isSynced), null, {
    timeout: 15_000,
  });
  await page.waitForSelector('.ProseMirror');
  return docName;
}

/** Programmatically NodeSelect a jsxComponent by componentName (first match).
 *  Uses window.__activeEditor — exposed by TiptapEditor for E2E observability. */
async function selectFirstJsxComponent(page: Page, componentName: string) {
  await page.waitForFunction(() => Boolean(window.__activeEditor), null, { timeout: 5_000 });
  return await page.evaluate((name) => {
    const editor = window.__activeEditor;
    if (!editor) return false;
    let foundPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (foundPos !== -1) return false;
      if (node.type.name === 'jsxComponent' && (node.attrs.componentName as string) === name) {
        foundPos = pos;
        return false;
      }
      return true;
    });
    if (foundPos === -1) return false;
    editor.chain().focus().setNodeSelection(foundPos).run();
    return true;
  }, componentName);
}

/** True when ProseMirror's selection head sits inside a jsxComponent — i.e. the
 *  caret descended into a compound block's body. Mirrors the inline walk S1c
 *  uses; shared by the L2d descent-parity tests (S1c-R/L/U/ACC). */
async function caretInsideCompound(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) return false;
    const sel = editor.state.selection;
    if (!('$head' in sel)) return false;
    const $head = sel.$head as { depth: number; node: (d: number) => { type: { name: string } } };
    for (let d = $head.depth; d >= 0; d--) {
      if ($head.node(d).type.name === 'jsxComponent') return true;
    }
    return false;
  });
}

/** Place the caret at the start or end of the first textblock whose text equals
 *  `text`, via the editor API + DOM-focus commit (the S1f/S1g pattern — click +
 *  Home/End was flaky on loaded CI workers). */
async function caretAtTextblock(page: Page, text: string, edge: 'start' | 'end'): Promise<void> {
  await page.evaluate(
    ({ text, edge }) => {
      const editor = window.__activeEditor;
      if (!editor) return;
      let pos = -1;
      editor.state.doc.descendants((node, p) => {
        if (node.type.name === 'heading' && node.textContent === text) {
          pos = edge === 'start' ? p + 1 : p + 1 + node.textContent.length;
        }
        return true;
      });
      if (pos >= 0) editor.chain().focus().setTextSelection(pos).run();
    },
    { text, edge },
  );
  await focusEditor(page);
  await waitForPmSelectionInNode(page, 'heading');
}


test('S1: ArrowDown auto-NodeSelects self-closing Callout below the cursor', async ({
  page,
  api,
}) => {
  await setupDoc(
    page,
    api,
    '# Title\n\n<Callout type="note" title="Hello" />\n\n<Callout type="tip" title="World" />\n',
  );
  await page.waitForSelector('.jsx-component-wrapper');

  await page.locator('.ProseMirror h1').first().click();
  await page.keyboard.press('End');

  await page.keyboard.press('ArrowDown');

  const firstCallout = page
    .locator('.jsx-component-wrapper[data-component-type="callout"]')
    .first();
  await expect(firstCallout).toHaveAttribute('data-selected', 'true', { timeout: 5_000 });
  await expect(firstCallout).toHaveAttribute('data-selection-origin', 'keyboard');
});


test('S1b: ArrowUp auto-NodeSelects self-closing Callout above the cursor', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="note" title="Above" />\n\n# Footer\n');
  await page.waitForSelector('.jsx-component-wrapper');

  await page.locator('.ProseMirror h1').first().click();
  await page.keyboard.press('Home');

  await page.keyboard.press('ArrowUp');

  const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await expect(callout).toHaveAttribute('data-selected', 'true', { timeout: 5_000 });
  await expect(callout).toHaveAttribute('data-selection-origin', 'keyboard');
});


test('S1c: ArrowDown into compound Callout descends into body (no NodeSelect)', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '# Title\n\n<Callout type="note">\n\nbody content\n\n</Callout>\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');

  await page.locator('.ProseMirror h1').first().click();
  await focusEditor(page);
  await waitForPmSelectionInNode(page, 'heading');
  await page.keyboard.press('End');

  await page.keyboard.press('ArrowDown');

  await expect(page.locator('.jsx-component-wrapper[data-selected="true"]')).toHaveCount(0);

  await waitForPmSelectionInNode(page, 'jsxComponent');

  const insideBody = await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) return false;
    const sel = editor.state.selection;
    if (!('$head' in sel)) return false;
    const $head = sel.$head as { depth: number; node: (d: number) => { type: { name: string } } };
    for (let d = $head.depth; d >= 0; d--) {
      if ($head.node(d).type.name === 'jsxComponent') return true;
    }
    return false;
  });
  expect(insideBody).toBe(true);
});


test('S1d: ArrowUp from inside compound Callout exits to TextSelection above', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '# Title\n\n<Callout type="note">\n\nbody content\n\n</Callout>\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');

  await page.locator('.ProseMirror p').filter({ hasText: 'body content' }).first().click();
  await page.keyboard.press('Home');
  await waitForPmSelectionInNode(page, 'jsxComponent');

  await page.keyboard.press('ArrowUp');

  await expect(page.locator('.jsx-component-wrapper[data-selected="true"]')).toHaveCount(0);

  const outsideCallout = await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) return false;
    const sel = editor.state.selection;
    if (!('$head' in sel)) return false;
    const $head = sel.$head as { depth: number; node: (d: number) => { type: { name: string } } };
    for (let d = $head.depth; d >= 0; d--) {
      if ($head.node(d).type.name === 'jsxComponent') return false;
    }
    return true;
  });
  expect(outsideCallout).toBe(true);
});


test('S1e: Esc inside compound Callout enters NodeSelection mode via L1', async ({ page, api }) => {
  await setupDoc(page, api, '<Callout type="note">\n\nbody content\n\n</Callout>\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');

  await page.locator('.ProseMirror p').filter({ hasText: 'body content' }).first().click();
  await page.keyboard.press('Home');
  await waitForPmSelectionInNode(page, 'jsxComponent');

  const preSelectionType = await page.evaluate(
    () => window.__activeEditor?.state.selection.constructor.name ?? '',
  );
  expect(preSelectionType).toBe('TextSelection');

  await page.keyboard.press('Escape');

  await expect
    .poll(() => page.evaluate(() => window.__activeEditor?.state.selection.constructor.name), {
      timeout: 5_000,
    })
    .toBe('NodeSelection');
});


test('S1f: ArrowRight auto-NodeSelects self-closing Callout to the right of the cursor', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '# Heading\n\n<Callout type="note" title="X" />\n\n# Footer\n');
  await page.waitForSelector('.jsx-component-wrapper');

  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) return;
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (node.type.name === 'heading' && node.textContent === 'Heading') {
        pos = p + 1 + node.textContent.length; // end-of-textblock for "Heading"
      }
      return true;
    });
    if (pos >= 0) {
      editor.chain().focus().setTextSelection(pos).run();
    }
  });

  await focusEditor(page);
  await page.keyboard.press('ArrowRight');

  const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await expect(callout).toHaveAttribute('data-selected', 'true', { timeout: 5_000 });
  await expect(callout).toHaveAttribute('data-selection-origin', 'keyboard');
});


test('S1g: ArrowLeft auto-NodeSelects self-closing Callout to the left of the cursor', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '# Heading\n\n<Callout type="note" title="X" />\n\n# Footer\n');
  await page.waitForSelector('.jsx-component-wrapper');

  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) return;
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (node.type.name === 'heading' && node.textContent === 'Footer') {
        pos = p + 1; // start-of-textblock for "Footer"
      }
      return true;
    });
    if (pos >= 0) {
      editor.chain().focus().setTextSelection(pos).run();
    }
  });

  await focusEditor(page);
  await page.keyboard.press('ArrowLeft');

  const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await expect(callout).toHaveAttribute('data-selected', 'true', { timeout: 5_000 });
  await expect(callout).toHaveAttribute('data-selection-origin', 'keyboard');
});


test('S1c-R: ArrowRight descends into compound Callout body (L2d horizontal)', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '# Title\n\n<Callout type="note">\n\nbody content\n\n</Callout>\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');
  await caretAtTextblock(page, 'Title', 'end');

  await page.keyboard.press('ArrowRight');

  await expect(page.locator('.jsx-component-wrapper[data-selected="true"]')).toHaveCount(0);
  await waitForPmSelectionInNode(page, 'jsxComponent');
  expect(await caretInsideCompound(page)).toBe(true);
});

test('S1c-L: ArrowLeft descends into compound Callout body (L2d horizontal)', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="note">\n\nbody content\n\n</Callout>\n\n# Footer\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');
  await caretAtTextblock(page, 'Footer', 'start');

  await page.keyboard.press('ArrowLeft');

  await expect(page.locator('.jsx-component-wrapper[data-selected="true"]')).toHaveCount(0);
  await waitForPmSelectionInNode(page, 'jsxComponent');
  expect(await caretInsideCompound(page)).toBe(true);
});

test('S1c-U: ArrowUp descends into compound Callout body from below (L2d vertical)', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="note">\n\nbody content\n\n</Callout>\n\n# Footer\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');
  await caretAtTextblock(page, 'Footer', 'start');

  await page.keyboard.press('ArrowUp');

  await expect(page.locator('.jsx-component-wrapper[data-selected="true"]')).toHaveCount(0);
  await waitForPmSelectionInNode(page, 'jsxComponent');
  expect(await caretInsideCompound(page)).toBe(true);
});

test('S1c-ACC: ArrowDown descends into compound Accordion body (L2d type parity)', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '# Title\n\n<Accordion title="X">\n\nbody content\n\n</Accordion>\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');
  await caretAtTextblock(page, 'Title', 'end');

  await page.keyboard.press('ArrowDown');

  await expect(page.locator('.jsx-component-wrapper[data-selected="true"]')).toHaveCount(0);
  await waitForPmSelectionInNode(page, 'jsxComponent');
  expect(await caretInsideCompound(page)).toBe(true);
});



test('S2: NodeSelection on a Callout emits data-selected=true on its wrapper', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="warning" title="Clickable" />\n');
  await page.waitForSelector('.jsx-component-wrapper');

  const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await callout.dispatchEvent('pointerdown');
  await selectFirstJsxComponent(page, 'Callout');

  await expect(callout).toHaveAttribute('data-selected', 'true', { timeout: 5_000 });
  await expect(callout).toHaveAttribute('data-selection-origin', 'pointer');
});


test('S3: nested Callout/Accordion — only innermost paints halo', async ({ page, api }) => {
  await setupDoc(page, api, '<Callout type="note">\n\n<Accordion title="Inner" />\n\n</Callout>\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');

  await selectFirstJsxComponent(page, 'Accordion');

  const innerAccordion = page
    .locator('.jsx-component-wrapper[data-component-type="accordion"]')
    .first();
  const outerCallout = page
    .locator('.jsx-component-wrapper[data-component-type="callout"]')
    .first();

  await expect(innerAccordion).toHaveAttribute('data-selected', 'true', { timeout: 5_000 });
  await expect(outerCallout).toHaveAttribute('data-has-child-selected', 'true');
  const outerDataSelected = await outerCallout.getAttribute('data-selected');
  expect(outerDataSelected).toBeNull();

  await expect(page.locator('[data-selected="true"]')).toHaveCount(1);
});

test('S3b: outer-NodeSelection on Callout with nested Accordion — only outer paints halo', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Callout type="note">\n\n<Accordion title="Inner" />\n\n</Callout>\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');

  await selectFirstJsxComponent(page, 'Callout');

  const outerCallout = page
    .locator('.jsx-component-wrapper[data-component-type="callout"]')
    .first();
  const innerAccordion = page
    .locator('.jsx-component-wrapper[data-component-type="accordion"]')
    .first();

  await expect(outerCallout).toHaveAttribute('data-selected', 'true', { timeout: 5_000 });
  const innerDataSelected = await innerAccordion.getAttribute('data-selected');
  expect(innerDataSelected).toBeNull();

  await expect(page.locator('[data-selected="true"]')).toHaveCount(1);
});


test('S4: dragstart/dragend toggles data-dragging', async ({ page, api }) => {
  await setupDoc(page, api, '<img src="/p.png" alt="Draggable" />\n');
  await page.waitForSelector('.jsx-component-wrapper');

  await selectFirstJsxComponent(page, 'img');
  const card = page.locator('.jsx-component-wrapper[data-component-type="img"]').first();
  await expect(card).toHaveAttribute('data-selected', 'true');

  await card.dispatchEvent('dragstart');
  await expect(card).toHaveAttribute('data-dragging', 'true', { timeout: 2_000 });

  await card.dispatchEvent('dragend');
  await expect(card).not.toHaveAttribute('data-dragging', 'true', { timeout: 2_000 });
});


test('S5: forced-colors emulation shows non-transparent halo border', async ({ page, api }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await setupDoc(page, api, '<img src="/p.png" alt="WHCM" />\n');
  await page.waitForSelector('.jsx-component-wrapper');

  await selectFirstJsxComponent(page, 'img');
  const card = page.locator('.jsx-component-wrapper[data-component-type="img"]').first();
  await expect(card).toHaveAttribute('data-selected', 'true', { timeout: 5_000 });

  const borderColor = await card.evaluate((el) => {
    const computed = window.getComputedStyle(el, '::after');
    return computed.borderColor || computed.borderTopColor;
  });
  expect(borderColor).not.toBe('transparent');
  expect(borderColor).not.toBe('rgba(0, 0, 0, 0)');
});


test('S6: prefers-reduced-motion:reduce → halo transition-duration is 0s', async ({
  page,
  api,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await setupDoc(page, api, '<img src="/p.png" alt="Motion" />\n');
  await page.waitForSelector('.jsx-component-wrapper');

  const card = page.locator('.jsx-component-wrapper[data-component-type="img"]').first();
  const transitionDuration = await card.evaluate((el) => {
    return window.getComputedStyle(el, '::after').transitionDuration;
  });
  expect(transitionDuration === '0s' || transitionDuration === '').toBe(true);
});


test('S7: selecting a Callout/Accordion renders no breadcrumb chrome', async ({ page, api }) => {
  await setupDoc(
    page,
    api,
    '<Callout type="note">\n<Accordion title="Inner">\n\nbody\n\n</Accordion>\n</Callout>\n',
  );
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');

  await expect(page.locator('.jsx-component-breadcrumb')).toHaveCount(0);
  await expect(page.locator('nav[aria-label="Block ancestor navigation"]')).toHaveCount(0);

  await selectFirstJsxComponent(page, 'Callout');
  const outer = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await expect(outer).toHaveAttribute('data-selected', 'true');
  await expect(page.locator('.jsx-component-breadcrumb')).toHaveCount(0);
  await expect(page.locator('nav[aria-label="Block ancestor navigation"]')).toHaveCount(0);

  await selectFirstJsxComponent(page, 'Accordion');
  const inner = page.locator('.jsx-component-wrapper[data-component-type="accordion"]').first();
  await expect(inner).toHaveAttribute('data-selected', 'true');
  await expect(page.locator('.jsx-component-breadcrumb')).toHaveCount(0);
  await expect(page.locator('nav[aria-label="Block ancestor navigation"]')).toHaveCount(0);
});


test('S8: aria-live textContent announces the selected block', async ({ page, api }) => {
  await setupDoc(
    page,
    api,
    '<Callout type="note">\n<Accordion title="Inner">\n\nbody\n\n</Accordion>\n</Callout>\n',
  );
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="accordion"]');

  await selectFirstJsxComponent(page, 'Accordion');

  const liveRegion = page.locator('[role="status"][aria-live="polite"]');
  await expect(liveRegion).toContainText('Selected: Accordion', { timeout: 2_000 });
});


test('S9: three-axis composition — dragging dominates over selected + needs-config', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<img src="/p.png" />\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="img"]');

  const card = page.locator('.jsx-component-wrapper[data-component-type="img"]').first();
  await expect(card).toHaveAttribute('data-needs-config', 'true', { timeout: 5_000 });

  await expect(page.locator('[data-descriptor-placeholder]')).toHaveCount(0);

  await selectFirstJsxComponent(page, 'img');
  await expect(card).toHaveAttribute('data-selected', 'true');
  await card.dispatchEvent('dragstart');
  await expect(card).toHaveAttribute('data-dragging', 'true');

  const attrs = await card.evaluate((el) => ({
    selected: el.getAttribute('data-selected'),
    needsConfig: el.getAttribute('data-needs-config'),
    dragging: el.getAttribute('data-dragging'),
  }));
  expect(attrs.selected).toBe('true');
  expect(attrs.needsConfig).toBe('true');
  expect(attrs.dragging).toBe('true');

  const haloState = await card.evaluate((el) => {
    const cs = window.getComputedStyle(el, '::after');
    return { opacity: cs.opacity, transitionDuration: cs.transitionDuration };
  });
  expect(haloState.opacity).toBe('0');
  expect(haloState.transitionDuration).toBe('0s');

  await card.dispatchEvent('dragend');
});


test('S9b: alt="" decorative opt-in does NOT fire data-needs-config', async ({ page, api }) => {
  await setupDoc(page, api, '<img src="/p.png" alt="" />\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="img"]');

  const wrapper = page.locator('.jsx-component-wrapper[data-component-type="img"]').first();
  await expect(wrapper).not.toHaveAttribute('data-needs-config', 'true', { timeout: 5_000 });
});


test('S9c: descriptive alt does NOT fire data-needs-config', async ({ page, api }) => {
  await setupDoc(page, api, '<img src="/p.png" alt="A picnic table at dusk" />\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="img"]');

  const wrapper = page.locator('.jsx-component-wrapper[data-component-type="img"]').first();
  await expect(wrapper).not.toHaveAttribute('data-needs-config', 'true', { timeout: 5_000 });
});


type InsetCase = { fixture: string; componentType: string };
const INSET_CASES: InsetCase[] = [
  {
    fixture: '<Callout type="note" title="X" />\n',
    componentType: 'callout',
  },
  {
    fixture: '<Accordion title="X" />\n',
    componentType: 'accordion',
  },
  {
    fixture: '<img src="/p.png" alt="Plain" />\n',
    componentType: 'img',
  },
  {
    fixture: '<video src="/sample.mp4" />\n',
    componentType: 'video',
  },
  {
    fixture: '<audio src="/sample.mp3" />\n',
    componentType: 'audio',
  },
];

for (const { fixture, componentType } of INSET_CASES) {
  test(`S11: [${componentType}] --selection-halo-inset resolves to -4px (uniform)`, async ({
    page,
    api,
  }) => {
    await setupDoc(page, api, fixture);
    await page.waitForSelector(`.jsx-component-wrapper[data-component-type="${componentType}"]`);

    const wrapper = page
      .locator(`.jsx-component-wrapper[data-component-type="${componentType}"]`)
      .first();
    const inset = await wrapper.evaluate((el) =>
      window.getComputedStyle(el).getPropertyValue('--selection-halo-inset').trim(),
    );
    expect(inset).toBe('-4px');
  });
}


test('S12: halo z-index is -1 and .component-children is fully visible when selected', async ({
  page,
  api,
}) => {
  await setupDoc(
    page,
    api,
    '<Callout type="note">\n<Accordion title="Visible">\n\nbody\n\n</Accordion>\n</Callout>\n',
  );
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');

  await selectFirstJsxComponent(page, 'Callout');
  const cards = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
  await expect(cards).toHaveAttribute('data-selected', 'true');

  const zIndex = await cards.evaluate((el) => window.getComputedStyle(el, '::after').zIndex);
  expect(zIndex).toBe('-1');

  const contentState = await cards.evaluate((el) => {
    const content = el.querySelector('.component-children') as HTMLElement | null;
    if (!content) return { present: false };
    const cs = window.getComputedStyle(content);
    const rect = content.getBoundingClientRect();
    return {
      present: true,
      opacity: cs.opacity,
      visibility: cs.visibility,
      display: cs.display,
      width: rect.width,
      height: rect.height,
    };
  });
  expect(contentState.present).toBe(true);
  expect(contentState.opacity).toBe('1');
  expect(contentState.visibility).toBe('visible');
  expect(contentState.display).not.toBe('none');
  expect(contentState.width).toBeGreaterThan(0);
  expect(contentState.height).toBeGreaterThan(0);
});


type CalloutCase = { type: string };
const CALLOUT_TYPES: CalloutCase[] = [
  { type: 'info' },
  { type: 'warning' },
  { type: 'error' },
  { type: 'success' },
  { type: 'idea' },
];

for (const { type } of CALLOUT_TYPES) {
  test(`S13: Callout[type="${type}"] halo border-color is non-transparent when selected`, async ({
    page,
    api,
  }) => {
    await setupDoc(page, api, `<Callout type="${type}">\n\nbody\n\n</Callout>\n`);
    await page.waitForSelector('.jsx-component-wrapper[data-component-type="callout"]');

    await selectFirstJsxComponent(page, 'Callout');
    const callout = page.locator('.jsx-component-wrapper[data-component-type="callout"]').first();
    await expect(callout).toHaveAttribute('data-selected', 'true', { timeout: 5_000 });

    const borderColor = await callout.evaluate((el) => {
      const cs = window.getComputedStyle(el, '::after');
      return cs.borderColor || cs.borderTopColor;
    });

    expect(borderColor).not.toBe('transparent');
    expect(borderColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(borderColor).not.toBe('');
  });
}



test('S14: tr.setMeta(SELECTION_ORIGIN_META_KEY) sets data-selection-origin=programmatic', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<img src="/p.png" alt="Target" />\n');
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="img"]');

  const dispatched = await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) return false;
    let cardPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (cardPos !== -1) return false;
      if (node.type.name === 'jsxComponent' && node.attrs.componentName === 'img') {
        cardPos = pos;
        return false;
      }
      return true;
    });
    if (cardPos === -1) return false;
    editor
      .chain()
      .focus()
      .setNodeSelection(cardPos)
      .command(({ tr }) => {
        tr.setMeta('selectionStatePlugin/origin', 'programmatic');
        return true;
      })
      .run();
    return true;
  });
  expect(dispatched).toBe(true);

  const card = page.locator('.jsx-component-wrapper[data-component-type="img"]').first();
  await expect(card).toHaveAttribute('data-selected', 'true', { timeout: 2_000 });
  await expect(card).toHaveAttribute('data-selection-origin', 'programmatic');
});


test('S16: axe-core — zero critical violations on selection-layer surfaces', async ({
  page,
  api,
}) => {
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  await setupDoc(
    page,
    api,
    '<Callout type="note">\n<Accordion title="A11y">\n\nbody\n\n</Accordion>\n</Callout>\n',
  );
  await page.waitForSelector('.jsx-component-wrapper');
  const selected = await selectFirstJsxComponent(page, 'Callout');
  expect(selected).toBe(true);

  const results = await new AxeBuilder({ page })
    .include('.ProseMirror')
    .include('[role="status"][aria-live="polite"]')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();

  const blocking = results.violations.filter((v) => v.impact === 'critical');
  if (blocking.length > 0) {
    const summary = blocking
      .map((v) => {
        const nodes = v.nodes
          .map((n) => `      target: ${n.target.join(' ')}\n      html: ${n.html.slice(0, 200)}`)
          .join('\n');
        return `  [${v.impact}] ${v.id}: ${v.description}\n${nodes}`;
      })
      .join('\n');
    throw new Error(`axe-core found ${blocking.length} critical violation(s):\n${summary}`);
  }
  expect(blocking.length).toBe(0);
});


test('S18: rapid selection changes coalesce into a single aria-live announcement', async ({
  page,
  api,
}) => {
  await setupDoc(
    page,
    api,
    '<img src="/a.png" alt="A" />\n\n<img src="/b.png" alt="B" />\n\n<img src="/c.png" alt="C" />\n',
  );
  await page.waitForSelector('.jsx-component-wrapper[data-component-type="img"]');

  const liveRegion = page.locator('[role="status"][aria-live="polite"]');
  await expect(liveRegion).toBeAttached();

  await page.evaluate(() => {
    const region = document.querySelector('[role="status"][aria-live="polite"]');
    if (!region) throw new Error('live region not found');
    // biome-ignore lint/suspicious/noExplicitAny: test-only global
    (window as any).__ariaLiveMutations = [];
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData' || r.type === 'childList') {
          // biome-ignore lint/suspicious/noExplicitAny: test-only global
          (window as any).__ariaLiveMutations.push({
            text: region.textContent,
            at: performance.now(),
          });
        }
      }
    });
    obs.observe(region, { characterData: true, childList: true, subtree: true });
    // biome-ignore lint/suspicious/noExplicitAny: test-only global
    (window as any).__ariaLiveObserver = obs;
  });

  await page.evaluate(() => {
    const ed = window.__activeEditor;
    if (!ed) return;
    const positions: number[] = [];
    ed.state.doc.descendants((node, pos) => {
      if (node.type.name === 'jsxComponent' && node.attrs.componentName === 'img') {
        positions.push(pos);
      }
      return true;
    });
    for (let i = 0; i < 3; i++) {
      const pos = positions[i];
      if (pos !== undefined) ed.chain().focus().setNodeSelection(pos).run();
    }
  });

  await page.waitForFunction(
    () => {
      // biome-ignore lint/suspicious/noExplicitAny: test-only global
      const mutations = ((window as any).__ariaLiveMutations ?? []) as Array<{
        text: string;
        at: number;
      }>;
      if (mutations.length === 0) return false;
      const last = mutations[mutations.length - 1];
      const withContent = mutations.filter((m) => m.text?.startsWith('Selected:'));
      return withContent.length >= 1 && performance.now() - last.at > 300;
    },
    null,
    { timeout: 2_000 },
  );

  const mutations = await page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test-only global
    const m = ((window as any).__ariaLiveMutations ?? []) as Array<{ text: string; at: number }>;
    // biome-ignore lint/suspicious/noExplicitAny: test-only global
    (window as any).__ariaLiveObserver?.disconnect();
    return m;
  });

  const contentMutations = mutations.filter(
    (m) => typeof m.text === 'string' && m.text.startsWith('Selected:'),
  );
  expect(contentMutations.length).toBeGreaterThanOrEqual(1);
  expect(contentMutations.length).toBeLessThan(3);
});


test('S19: clicking inside nested CM forwards focus as NodeSelection on rawMdxFallback', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, 'before\n\n<Foo>some text</Bar>\n\nafter\n');
  const fallbackWrapper = page.locator('.raw-mdx-fallback-wrapper').first();
  await expect(fallbackWrapper).toBeAttached({ timeout: 5_000 });

  const cmContent = fallbackWrapper.locator('.cm-content').first();
  await expect(cmContent).toBeAttached({ timeout: 5_000 });

  const baseline = await page.evaluate(() => {
    const ed = window.__activeEditor;
    if (!ed) return null;
    const sel = ed.state.selection;
    return {
      type: sel.constructor.name,
      // biome-ignore lint/suspicious/noExplicitAny: test-only introspection of PM internals
      nodeType: (sel as any).node?.type?.name ?? null,
      from: sel.from,
    };
  });
  expect(baseline).not.toBeNull();
  expect(baseline?.type === 'NodeSelection' && baseline?.nodeType === 'rawMdxFallback').toBe(false);

  await cmContent.click();

  await page.waitForFunction(
    () => {
      const ed = window.__activeEditor;
      if (!ed) return false;
      const sel = ed.state.selection;
      if (sel.constructor.name !== 'NodeSelection') return false;
      // biome-ignore lint/suspicious/noExplicitAny: test-only introspection
      return (sel as any).node?.type?.name === 'rawMdxFallback';
    },
    null,
    { timeout: 5_000 },
  );

  const afterClick = await page.evaluate(() => {
    const ed = window.__activeEditor;
    if (!ed) return null;
    const sel = ed.state.selection;
    return {
      type: sel.constructor.name,
      // biome-ignore lint/suspicious/noExplicitAny: test-only introspection
      nodeType: (sel as any).node?.type?.name ?? null,
    };
  });
  expect(afterClick).toEqual({
    type: 'NodeSelection',
    nodeType: 'rawMdxFallback',
  });
});
