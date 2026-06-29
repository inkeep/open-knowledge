
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

const WIDE_VIEWPORT = { width: 1300, height: 800 } as const;
const NARROW_VIEWPORT = { width: 800, height: 800 } as const;

const DOC_BODY = `# Aang Test Heading

This is the test body for the editor-area-viewport-resize regression test. It must
contain enough text to verify TipTap's ProseMirror DOM is fully rendered after each
viewport cycle. The bug under test loses this body content while preserving the
Properties panel.

Paragraph two with [[a wikilink]] and **bold** text and an _emphasized_ phrase.

## Second heading

Final paragraph.`;

const DOC_BODY_TEXT_MARKERS = [
  'Aang Test Heading',
  'Second heading',
  'editor-area-viewport-resize regression test',
] as const;

function frontmatterDoc(name: string): string {
  return `---
title: "${name} title"
description: "Test description"
born: 12 BG
tags:
  - characters
  - air-nomads
  - famous
---

${DOC_BODY}`;
}

async function waitForEditorReady(page: Page) {
  await page.waitForSelector('.ProseMirror', { state: 'attached', timeout: 15_000 });
  await expect(page.locator('.ProseMirror').first()).toBeVisible({ timeout: 10_000 });
}

async function assertBodyEditorRendersContent(page: Page) {
  const editor = page.locator('.ProseMirror').first();
  await expect(editor).toBeVisible({ timeout: 10_000 });

  const editorText = (await editor.textContent()) ?? '';
  for (const marker of DOC_BODY_TEXT_MARKERS) {
    expect(editorText, `expected body editor to contain "${marker}"`).toContain(marker);
  }
}

async function assertPropertyPanelRenders(page: Page, expectedTitle: string) {
  await expect(page.getByText('Properties').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(expectedTitle).first()).toBeVisible({ timeout: 10_000 });
}

async function waitForDocPanel(page: Page, expected: 'open' | 'collapsed') {
  const want = expected === 'open' ? 'true' : 'false';
  await expect
    .poll(() => page.locator('[data-doc-panel-toggle]').getAttribute('aria-expanded'), {
      timeout: 5_000,
    })
    .toBe(want);
}

async function portalTargetGeneration(page: Page, docName: string): Promise<string> {
  return page.evaluate((dn) => {
    const el = document.querySelector(`[data-ok-editor-portal="${dn}"]`);
    if (!el) return 'absent';
    const probeKey = '__okEditorPortalGenProbe';
    const w = window as unknown as Record<string, unknown>;
    let wm = w[probeKey] as WeakMap<Element, string> | undefined;
    if (!wm) {
      wm = new WeakMap<Element, string>();
      w[probeKey] = wm;
    }
    let tag = wm.get(el);
    if (!tag) {
      tag = `gen-${Math.random().toString(36).slice(2, 10)}`;
      wm.set(el, tag);
    }
    return tag;
  }, docName);
}

test.describe('editor-area viewport resize — editor mount stability', () => {
  test('single collapse+expand cycle across 1024px preserves body editor', async ({
    page,
    api,
  }) => {
    const docName = `viewport-resize-single-${test.info().workerIndex}`;
    await api.seedDocs([{ name: docName, markdown: frontmatterDoc(docName) }]);
    await page.setViewportSize(WIDE_VIEWPORT);
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    await waitForEditorReady(page);
    await waitForDocPanel(page, 'open');
    await assertBodyEditorRendersContent(page);
    await assertPropertyPanelRenders(page, `${docName} title`);

    await page.setViewportSize(NARROW_VIEWPORT);
    await waitForDocPanel(page, 'collapsed');
    await page.setViewportSize(WIDE_VIEWPORT);
    await waitForDocPanel(page, 'open');

    await waitForEditorReady(page);
    await assertBodyEditorRendersContent(page);
    await assertPropertyPanelRenders(page, `${docName} title`);
  });

  test('viewport flip across 1024px does not unmount the editor subtree (structural)', async ({
    page,
    api,
  }) => {
    const docName = `viewport-resize-structural-${test.info().workerIndex}`;
    await api.seedDocs([{ name: docName, markdown: frontmatterDoc(docName) }]);
    await page.setViewportSize(WIDE_VIEWPORT);
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    await waitForEditorReady(page);
    await waitForDocPanel(page, 'open');

    const genBefore = await portalTargetGeneration(page, docName);
    expect(genBefore).not.toBe('absent');

    expect(await portalTargetGeneration(page, docName)).toBe(genBefore);

    await page.setViewportSize(NARROW_VIEWPORT);
    await waitForDocPanel(page, 'collapsed');
    await page.setViewportSize(WIDE_VIEWPORT);
    await waitForDocPanel(page, 'open');
    await waitForEditorReady(page);

    const genAfterCycle1 = await portalTargetGeneration(page, docName);
    expect(
      genAfterCycle1,
      'portal target DOM identity must be stable across the doc-panel collapse/expand — a new generation means the editor subtree remounted, violating precedent #18(b)',
    ).toBe(genBefore);

    await page.setViewportSize(NARROW_VIEWPORT);
    await waitForDocPanel(page, 'collapsed');
    await page.setViewportSize(WIDE_VIEWPORT);
    await waitForDocPanel(page, 'open');
    await waitForEditorReady(page);

    const genAfterCycle2 = await portalTargetGeneration(page, docName);
    expect(
      genAfterCycle2,
      'portal target DOM identity must remain stable across two collapse/expand cycles — any change means the editor subtree was unmounted at least once',
    ).toBe(genBefore);
  });

  test('five collapse+expand cycles across 1024px preserve body editor', async ({ page, api }) => {
    const docName = `viewport-resize-multi-${test.info().workerIndex}`;
    await api.seedDocs([{ name: docName, markdown: frontmatterDoc(docName) }]);
    await page.setViewportSize(WIDE_VIEWPORT);
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    await waitForEditorReady(page);
    await waitForDocPanel(page, 'open');
    await assertBodyEditorRendersContent(page);

    const genBefore = await portalTargetGeneration(page, docName);
    expect(genBefore).not.toBe('absent');

    for (let i = 0; i < 5; i++) {
      await page.setViewportSize(NARROW_VIEWPORT);
      await waitForDocPanel(page, 'collapsed');
      await page.setViewportSize(WIDE_VIEWPORT);
      await waitForDocPanel(page, 'open');
    }

    await waitForEditorReady(page);
    await assertBodyEditorRendersContent(page);
    await assertPropertyPanelRenders(page, `${docName} title`);

    expect(
      await portalTargetGeneration(page, docName),
      'portal target DOM identity must be stable across five collapse/expand cycles',
    ).toBe(genBefore);
  });

  test('focus inside the doc-panel moves to the toggle when the panel collapses on resize (FR-9)', async ({
    page,
    api,
  }) => {
    const docName = `viewport-resize-fr9-${test.info().workerIndex}`;
    await api.seedDocs([{ name: docName, markdown: frontmatterDoc(docName) }]);
    await page.setViewportSize(WIDE_VIEWPORT);
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    await waitForEditorReady(page);
    await waitForDocPanel(page, 'open');

    const focusedInside = await page.evaluate(() => {
      const panel = document.getElementById('doc-panel');
      const focusable = panel?.querySelector<HTMLElement>('[role="tab"], button');
      focusable?.focus();
      return panel ? panel.contains(document.activeElement) : false;
    });
    expect(focusedInside, 'precondition: focus is inside the doc-panel').toBe(true);

    await page.setViewportSize(NARROW_VIEWPORT);
    await waitForDocPanel(page, 'collapsed');

    const focusOnToggle = await page.evaluate(
      () => document.activeElement?.closest('[data-doc-panel-toggle]') != null,
    );
    expect(
      focusOnToggle,
      'on collapse, focus must move to the doc-panel toggle (never orphaned inside the collapsed panel)',
    ).toBe(true);
  });
});
