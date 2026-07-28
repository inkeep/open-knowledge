/**
 * Compositional E2E coverage for the block-math non-portable-render
 * source-fallback on the clipboard `text/html` flavor. Targets the copy
 * journey that bun/jsdom cannot exercise: the full copy-event → walker →
 * `fragment.appendChild` wiring that turns a `sourceFallbackFormFor`
 * result into clipboard bytes.
 *
 * Block math authored as `$$…$$` parses to a `DollarMath` jsxComponent and
 * ` ```math ` fences parse to `MathFence`; both `rendersAs: 'Math'` so they
 * render as the same non-portable KaTeX span-tree as canonical `Math`, and
 * are the dominant on-disk authoring forms. Copying either must write the
 * same readable `$$\nformula\n$$` source to the `text/html` clipboard flavor
 * that canonical `Math` writes — a KaTeX style clone in the payload is a
 * paste-fidelity regression for rich destinations (Gmail, Google Docs,
 * Notion). These tests pin that both authored forms emit the source
 * fallback and that no KaTeX markup survives.
 *
 * Companion to the unit/DOM coverage in
 * non-portable-render-source-fallback.test.ts (node classifier) and
 * clipboard-walker-fallback-palette.dom-shape.test.ts (palette DOM shape).
 * Mirrors the sibling clipboard-relative-url-source-fallback.e2e.ts
 * harness.
 */

import { randomUUID } from 'node:crypto';
import {
  expect,
  simulateCopyAndRead,
  test,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

async function getYText(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const provider = window.__activeProvider;
    return provider?.document?.getText('source')?.toString() ?? '';
  });
}

test.describe('block-math source-fallback — dollar / fence authored forms on text/html', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-dollarmath-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  });

  test('$$…$$-authored block math (DollarMath) emits readable LaTeX source, not a KaTeX clone', async ({
    page,
    baseURL,
  }) => {
    // `$$…$$` on its own lines parses to a `DollarMath` node that renders
    // as KaTeX. Copying it must write the readable `$$\nformula\n$$` source
    // to text/html so rich destinations (Gmail, Docs, Notion) get LaTeX
    // instead of a broken style clone.
    const formula = 'E = mc^2';
    await fetch(`${baseURL}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        markdown: `$$\n${formula}\n$$\n\nSurrounding prose.\n`,
        position: 'replace',
      }),
    });
    await expect(async () => {
      expect(await getYText(page)).toContain(formula);
    }).toPass({ timeout: 5_000 });
    await page.click('.ProseMirror:not(.composer-prosemirror)');

    const captured = await simulateCopyAndRead(page, 'wysiwyg');

    // text/html carries the source fallback: `<pre class="mdx-component">
    // <code>$$\nformula\n$$</code></pre>`.
    expect(captured.html).toMatch(/<pre class="mdx-component"[ >]/);
    expect(captured.html).toContain('<code>');
    expect(captured.html).toContain(`$$\n${formula}\n$$`);
    // The non-portable KaTeX render must NOT leak into the payload.
    expect(captured.html).not.toContain('class="katex"');
  });

  test('```math-authored block math (MathFence) emits the same dollar source form', async ({
    page,
    baseURL,
  }) => {
    // ` ```math ` fences parse to a `MathFence` node that also renders as
    // KaTeX; the source fallback maps it to the SAME dollar form as
    // canonical `Math`, matching the render identity rather than the
    // authored fence bytes.
    const formula = 'a^2 + b^2 = c^2';
    await fetch(`${baseURL}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        markdown: `\`\`\`math\n${formula}\n\`\`\`\n\nSurrounding prose.\n`,
        position: 'replace',
      }),
    });
    await expect(async () => {
      expect(await getYText(page)).toContain(formula);
    }).toPass({ timeout: 5_000 });
    await page.click('.ProseMirror:not(.composer-prosemirror)');

    const captured = await simulateCopyAndRead(page, 'wysiwyg');

    expect(captured.html).toMatch(/<pre class="mdx-component"[ >]/);
    expect(captured.html).toContain('<code>');
    expect(captured.html).toContain(`$$\n${formula}\n$$`);
    expect(captured.html).not.toContain('class="katex"');
  });
});
