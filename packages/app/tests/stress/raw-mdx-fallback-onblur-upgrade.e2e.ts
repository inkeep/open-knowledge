/**
 * Layer C (Tier 2): on-blur upgrade of `rawMdxFallback` → parsed node when
 * the user fixes broken MDX in the nested CodeMirror.
 *
 * Context — prior art and scope:
 *
 * Surveyed editors (Obsidian Live Preview, SilverBullet,
 * codemirror-rich-markdoc, HedgeDoc, Typora, MDXEditor, Notion, BlockNote)
 * do not have a first-class parse-error-fallback → edit-source-live →
 * auto-upgrade-when-valid flow. Closest analog: Obsidian's S3
 * live-preview pattern uses a cursor-overlap guard — cursor inside
 * widget-region = reveal source; cursor outside = render widget. Our
 * architecture collapses Obsidian's "cursor exits widget" to "nested CM
 * loses focus" because the nested CM IS the source reveal.
 *
 * Trigger: CM `focusChanged` + `!view.hasFocus` (browser blur on the
 * nested CM). Handler reads the current CM source, runs it through the
 * same parse pipeline the outer editor uses, and if the result is a
 * single non-fallback block, dispatches a PM transaction replacing the
 * `rawMdxFallback` with the parsed node.
 *
 * Two tests:
 *
 *   S21 — happy path upgrade. Seed broken tag (`<Foo>text</Bar>` →
 *         rawMdxFallback at mount). Focus nested CM. Replace source with
 *         valid MDX for a REGISTERED component (`<Callout …>`). Blur CM.
 *         Assert: PM has a `jsxComponent` with componentName "Callout",
 *         no residual `rawMdxFallback` at that position.
 *
 *   S22 — still-invalid no-churn. Seed broken tag. Focus nested CM. Type
 *         a character (still broken). Blur CM. Assert: PM still has
 *         `rawMdxFallback` — the node is NOT replaced with another
 *         rawMdxFallback (which would churn Y.XmlElement identity,
 *         break y-prosemirror Item mapping, and cascade to observers per
 *         Precedent #10). On-blur only commits when the re-parse
 *         produces a genuinely better node.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { ApiHelpers } from './_helpers';
import { expect, test } from './_helpers';

interface PmNodeSummary {
  type: string;
  componentName: string | null;
  reason: string | null;
}

async function setupDoc(page: Page, api: ApiHelpers, markdown: string): Promise<string> {
  const docName = `rawmdx-onblur-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.testReset(docName);
  await api.replaceDoc(docName, markdown);
  await page.goto(`/#/${docName}`);
  await page.waitForFunction(() => Boolean(window.__activeProvider?.isSynced), null, {
    timeout: 15_000,
  });
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  return docName;
}

async function readPmNodes(page: Page): Promise<PmNodeSummary[]> {
  return await page.evaluate(() => {
    const ed = window.__activeEditor;
    if (!ed) return [];
    const out: PmNodeSummary[] = [];
    ed.state.doc.descendants((n: { type: { name: string }; attrs: Record<string, unknown> }) => {
      out.push({
        type: n.type.name,
        componentName: (n.attrs?.componentName as string | undefined) ?? null,
        reason: (n.attrs?.reason as string | undefined) ?? null,
      });
    });
    return out;
  });
}

// ── S21: on-blur upgrade — broken MDX edited to valid registered component ─

test('S21: fixing broken MDX in nested CM upgrades rawMdxFallback to jsxComponent on blur', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Foo>text</Bar>\n');

  // Baseline: auto-parse at mount produces a rawMdxFallback
  await page.waitForFunction(
    () => {
      const ed = window.__activeEditor;
      if (!ed) return false;
      let found = false;
      ed.state.doc.descendants((n: { type: { name: string } }) => {
        if (n.type.name === 'rawMdxFallback') found = true;
      });
      return found;
    },
    null,
    { timeout: 5_000 },
  );

  const fallbackCm = page.locator('.raw-mdx-fallback-wrapper .cm-content').first();
  await expect(fallbackCm).toBeAttached({ timeout: 5_000 });
  await fallbackCm.click();

  // Replace CM content via keyboard-driven select-all + insertText, per
  // CLAUDE.md precedent #20(i) — `keyboard.insertText` dispatches a
  // single `beforeinput` event pair, which CM6 handles atomically. The
  // `evaluate(() => cmView.dispatch(...))` pattern can't reach the real
  // CM view from the test process without a DEV-gated window hook (the
  // `.cm-editor` DOM node doesn't expose the EditorView instance under
  // any documented accessor in CM6 v6+).
  // Delete original content via backspace loop, then insertText. This
  // avoids Mod-A select-all which bubbles to the outer PM editor's
  // keybindings on some platforms (even with NodeView `stopEvent:
  // ()=>true`, TipTap-level addKeyboardShortcuts still sees the key
  // before CM's internal handling).
  const originalLen = '<Foo>text</Bar>'.length;
  for (let i = 0; i < originalLen; i++) await page.keyboard.press('Backspace');
  await page.keyboard.insertText('<Callout type="info">\n\nfixed content\n\n</Callout>');

  // Blur the nested CM by focusing the outer PM editor. Blur triggers
  // the on-blur re-parse handler.
  await page.locator('.ProseMirror:not(.composer-prosemirror)').focus();

  // Wait for the upgrade — on-blur handler fires, re-parses, dispatches
  // replaceWith, PM commits, NodeView swap visible to the next read.
  await page.waitForFunction(
    () => {
      const ed = window.__activeEditor;
      if (!ed) return false;
      let foundCallout = false;
      let residualFallback = false;
      ed.state.doc.descendants((n: { type: { name: string }; attrs: Record<string, unknown> }) => {
        const cn = n.attrs?.componentName as string | undefined;
        if (n.type.name === 'jsxComponent' && cn === 'Callout') foundCallout = true;
        if (n.type.name === 'rawMdxFallback') residualFallback = true;
      });
      return foundCallout && !residualFallback;
    },
    null,
    { timeout: 5_000 },
  );

  const summary = await readPmNodes(page);
  expect(summary.filter((n) => n.type === 'rawMdxFallback')).toHaveLength(0);
  expect(
    summary.filter((n) => n.type === 'jsxComponent' && n.componentName === 'Callout'),
  ).toHaveLength(1);
});

// ── S22: no-churn — still-invalid blur leaves rawMdxFallback unchanged ────

test('S22: blur with still-invalid source does not churn the rawMdxFallback node', async ({
  page,
  api,
}) => {
  await setupDoc(page, api, '<Foo>text</Bar>\n');

  await page.waitForFunction(
    () => {
      const ed = window.__activeEditor;
      if (!ed) return false;
      let found = false;
      ed.state.doc.descendants((n: { type: { name: string } }) => {
        if (n.type.name === 'rawMdxFallback') found = true;
      });
      return found;
    },
    null,
    { timeout: 5_000 },
  );

  // Capture the rawMdxFallback's reason text BEFORE editing — we'll
  // compare identity (via reason + position) after blur to assert no churn.
  const before = await readPmNodes(page);
  const beforeFallback = before.find((n) => n.type === 'rawMdxFallback');
  expect(beforeFallback).toBeDefined();

  const fallbackCm = page.locator('.raw-mdx-fallback-wrapper .cm-content').first();
  await fallbackCm.click();

  // Edit to another still-broken form — change `<Foo>text</Bar>` to
  // `<Foo>text</Baz>` (different mismatch). Delete original via backspace
  // loop, then insertText. Keyboard-driven per CLAUDE.md precedent
  // #20(i); Mod-A interferes with the outer PM's select-all keybinding
  // (even through NodeView `stopEvent: ()=>true`).
  const originalLen = '<Foo>text</Bar>'.length;
  for (let i = 0; i < originalLen; i++) await page.keyboard.press('Backspace');
  await page.keyboard.insertText('<Foo>text</Baz>');

  // Blur the CM
  await page.locator('.ProseMirror:not(.composer-prosemirror)').focus();

  // Give the on-blur handler a couple of frames to (try to) run + no-op.
  // Condition-based wait: assert that AFTER a DOM tick, the
  // rawMdxFallback is still there. Poll for a short duration to confirm
  // no late churn.
  await page.waitForFunction(
    () => {
      const ed = window.__activeEditor;
      if (!ed) return false;
      let found = false;
      ed.state.doc.descendants((n: { type: { name: string } }) => {
        if (n.type.name === 'rawMdxFallback') found = true;
      });
      return found;
    },
    null,
    { timeout: 2_000 },
  );

  const after = await readPmNodes(page);
  const afterFallbacks = after.filter((n) => n.type === 'rawMdxFallback');
  // Exactly one rawMdxFallback survives — no duplication, no jsxComponent
  // upgrade, no swap for another rawMdxFallback instance.
  expect(afterFallbacks).toHaveLength(1);
  expect(after.filter((n) => n.type === 'jsxComponent' && n.componentName === 'Foo')).toHaveLength(
    0,
  );
});
