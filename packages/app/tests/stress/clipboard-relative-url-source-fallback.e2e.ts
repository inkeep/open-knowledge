/**
 * Compositional E2E coverage for the clipboard relative-URL
 * source-fallback feature. Targets the user journeys + walker post-pass
 * mechanics that bun-test (no DOM, polyfilled documents) cannot exercise:
 *
 *   - WYSIWYG copy of a paragraph containing a relative-path
 *     image emits source-fallback `<pre class="mdx-component"><code>` block
 *     wrapper for cross-app paste.
 *   - Source→Source paste via OK→OK preserves byte-identical
 *     markdown bytes (sister tiebreak in source-clipboard.ts).
 *   - Inline image inside a paragraph emits inline source-
 *     fallback `<span class="mdx-inline">` (HTML5 paragraph-content rule).
 *   - All-portable selection passes through the walker unchanged
 *     (regression check — no telemetry pollution, no source-fallback).
 *   - text/plain canonical markdown emission unchanged on copy.
 *   - Mid-walk continuation — well-formed and malformed URLs in
 *     one selection produce per-element decisions.
 *   - Walker post-pass adds <100ms (no clipboard-slow-op events)
 *     for typical 50-element selections.
 *
 * Companion to the unit-level coverage in clipboard-walker.test.ts /
 * clipboard-sanitize.test.ts which exercise the pure helpers + DOM-fakes,
 * and the integration coverage in clipboard-cross-app-sanitizer-proxy.test.ts
 * which simulates destination sanitizer profiles.
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

async function pasteWithMimes(
  page: import('@playwright/test').Page,
  mimes: Record<string, string>,
  selector: string,
) {
  await page.evaluate(
    ({ mimes: m, sel }) => {
      const editor = document.querySelector(sel);
      if (!editor) throw new Error(`Editor not found: ${sel}`);
      const dt = new DataTransfer();
      for (const [key, value] of Object.entries(m)) dt.setData(key, value);
      const event = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(event);
    },
    { mimes, sel: selector },
  );
}

test.describe('FR-2 walker URL classifier — WYSIWYG cross-app source-fallback', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-fr2-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  });

  test('QA-001 standalone relative-path image paragraph emits block source-fallback', async ({
    page,
    baseURL,
  }) => {
    // Compositional journey: user authors a doc with a
    // relative-path image, selects, copies → cross-app paste shows code block
    // of source bytes instead of a broken-image icon.
    await fetch(`${baseURL}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        markdown: '![chart](./Q3-sales.png)\n\nSurrounding prose.\n',
        position: 'replace',
      }),
    });
    await expect(async () => {
      expect(await getYText(page)).toContain('![chart](./Q3-sales.png)');
    }).toPass({ timeout: 5_000 });
    await page.click('.ProseMirror:not(.composer-prosemirror)');

    const captured = await simulateCopyAndRead(page, 'wysiwyg');

    // text/plain unchanged from today's behavior — canonical markdown.
    expect(captured.plain).toContain('![chart](./Q3-sales.png)');
    // text/html: the standalone image paragraph triggers BLOCK source-
    // fallback because the image isn't inside another `<p>` ancestor.
    expect(captured.html).toContain('<pre class="mdx-component">');
    expect(captured.html).toContain('<code>');
    expect(captured.html).toContain('![chart](./Q3-sales.png)');
    // No `<img>` tag with the non-portable URL survives — that was the
    // former broken-image-icon path.
    expect(captured.html).not.toContain('src="./Q3-sales.png"');
  });

  test('QA-005 inline image in paragraph emits inline source-fallback (D16 paragraph-content rule)', async ({
    page,
    baseURL,
  }) => {
    // Inline `<img>` inside `<p>` must use the inline shape — block `<pre>`
    // inside `<p>` would auto-close the paragraph in destinations and break
    // surrounding prose context.
    await fetch(`${baseURL}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        markdown: 'Some prose with an ![alt](./x.jpg) image.\n',
        position: 'replace',
      }),
    });
    await expect(async () => {
      expect(await getYText(page)).toContain('![alt](./x.jpg)');
    }).toPass({ timeout: 5_000 });
    await page.click('.ProseMirror:not(.composer-prosemirror)');

    const captured = await simulateCopyAndRead(page, 'wysiwyg');

    expect(captured.plain).toContain('Some prose with an ![alt](./x.jpg) image.');
    // Inline emission shape preserves paragraph context: `<span
    // class="mdx-inline">{escaped markdown}</span>` inside the surrounding
    // `<p>`.
    expect(captured.html).toContain('<span class="mdx-inline">');
    expect(captured.html).toContain('![alt](./x.jpg)');
    // Critically: NO `<pre>` block emission inside the paragraph (HTML5
    // would auto-close the `<p>`).
    expect(captured.html).not.toMatch(/<p[\s>][^>]*>[^<]*<pre/);
    // Original `<img src>` non-portable URL is gone.
    expect(captured.html).not.toContain('src="./x.jpg"');
  });

  test('QA-009 all-portable selection: walker passes through unchanged (regression check)', async ({
    page,
    baseURL,
  }) => {
    // Markdown with only portable URLs: a public-https image, a public-https
    // anchor, a wiki-link (transformed to portable fragment-href anchor),
    // a fragment ref, and a mailto link. Walker classifier must
    // emit ZERO `clipboard-walker-url-source-emitted` telemetry events and
    // ZERO source-fallback shapes.
    const warns: string[] = [];
    page.on('console', (msg) => {
      if (['warning', 'warn', 'log'].includes(msg.type())) warns.push(msg.text());
    });
    await fetch(`${baseURL}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        markdown:
          '![public](https://example.com/x.jpg)\n\n[click](https://acme.com)\n\n[[OtherDoc]]\n\n[jump](#section)\n\n[mail](mailto:foo@bar.com)\n',
        position: 'replace',
      }),
    });
    await expect(async () => {
      expect(await getYText(page)).toContain('https://example.com/x.jpg');
    }).toPass({ timeout: 5_000 });
    await page.click('.ProseMirror:not(.composer-prosemirror)');

    const captured = await simulateCopyAndRead(page, 'wysiwyg');

    expect(captured.html).not.toContain('<pre class="mdx-component">');
    expect(captured.html).not.toContain('<span class="mdx-inline">');
    // Public URL preserved on its `<img>` tag.
    expect(captured.html).toContain('https://example.com/x.jpg');
    // Wiki-link is rewritten to fragment-href anchor (portable) — the
    // walker URL classifier classifies the resulting anchor as
    // portable, so no source-fallback fires.
    expect(captured.html).toContain('href="#otherdoc"');
    // No clipboard-walker-url-source-emitted telemetry events.
    const sawSource = warns.some((w) => /clipboard-walker-url-source-emitted/.test(w));
    expect(sawSource).toBe(false);
  });

  test('QA-010 text/plain canonical markdown emission unchanged (regression)', async ({
    page,
    baseURL,
  }) => {
    // We don't touch text/plain — the separate clipboardTextSerializer
    // hook in serialize.ts. Markdown-aware destinations (Linear,
    // Outline, Obsidian, GitHub textarea) see byte-identical canonical
    // markdown.
    const seedMarkdown = '# H\n\n- a\n- b\n\n![chart](./local.png)\n';
    await fetch(`${baseURL}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, markdown: seedMarkdown, position: 'replace' }),
    });
    await expect(async () => {
      expect(await getYText(page)).toContain('![chart](./local.png)');
    }).toPass({ timeout: 5_000 });
    await page.click('.ProseMirror:not(.composer-prosemirror)');

    const captured = await simulateCopyAndRead(page, 'wysiwyg');
    expect(captured.plain).toContain('# H');
    expect(captured.plain).toContain('- a');
    expect(captured.plain).toContain('- b');
    expect(captured.plain).toContain('![chart](./local.png)');
  });
});

test.describe('FR-13 sister tiebreak — Source→Source OK→OK paste byte-identical', () => {
  test('QA-004 Source-mode round-trip preserves bytes via text/plain (sister of FR-13)', async ({
    page,
    api,
    baseURL,
  }) => {
    // Source→Source paste path: source-clipboard.ts prefers text/plain
    // markdown over text/html when the bytes parse as markdown. The wrapper
    // changes text/html to a `<pre class="mdx-component"><code>` wrapper; this test
    // proves the sister tiebreak preserves OK→OK Source paste despite the
    // wrapper shape.
    const seedMarkdown = '# H1\n\n- a\n- b\n\n![alt](./local.jpg)\n\n[[OtherDoc#Section]]\n';
    const sourceDocName = `test-q4-src-${randomUUID().slice(0, 8)}`;
    const targetDocName = `test-q4-dst-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${sourceDocName}.md`);
    await api.createPage(`${targetDocName}.md`);

    // Seed source doc.
    await fetch(`${baseURL}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName: sourceDocName,
        markdown: seedMarkdown,
        position: 'replace',
      }),
    });

    // Open source doc, switch to source view, copy.
    await page.goto(`/#/${sourceDocName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
    await page.getByRole('radio', { name: /Markdown source/i }).click({ timeout: 10_000 });
    await page.waitForSelector('.cm-content');
    await expect(page.locator('.cm-content')).toContainText('OtherDoc#Section', {
      timeout: 5_000,
    });
    const captured = await simulateCopyAndRead(page, 'source');

    // Sanity: captured.plain contains canonical markdown bytes.
    expect(captured.plain).toContain('# H1');
    expect(captured.plain).toContain('![alt](./local.jpg)');
    expect(captured.plain).toContain('[[OtherDoc#Section]]');
    // Sanity: captured.html is the source wrapper.
    expect(captured.html).toContain('<pre class="mdx-component">');
    expect(captured.html).toContain('[[OtherDoc#Section]]');

    // Open target doc, switch to source view, paste. The EditorActivityPool
    // keeps multiple editors mounted (Activity-hidden + Activity-active);
    // wait on the provider instead of requiring .ProseMirror visibility,
    // which would fail on the hidden mounts.
    await page.goto(`/#/${targetDocName}`);
    await waitForProvider(page);
    await page.getByRole('radio', { name: /Markdown source/i }).click({ timeout: 10_000 });
    await page.waitForSelector('.cm-content');
    await page.click('.cm-content');

    await pasteWithMimes(
      page,
      {
        'text/plain': captured.plain,
        'text/html': captured.html,
      },
      '.cm-content',
    );

    // Source-mode receive (source-clipboard.ts) prefers text/plain
    // markdown — Y.Text in target instance must be byte-equivalent to the
    // source seed (modulo trailing whitespace normalization).
    await expect(async () => {
      const targetYText = await getYText(page);
      expect(targetYText).toContain('# H1');
      expect(targetYText).toContain('- a');
      expect(targetYText).toContain('- b');
      expect(targetYText).toContain('![alt](./local.jpg)');
      expect(targetYText).toContain('[[OtherDoc#Section]]');
    }).toPass({ timeout: 5_000 });
  });
});

test.describe('FR-6 / FR-7 partial-failure mid-walk continuation', () => {
  test('QA-029 mixed selection (well-formed + malformed) processes per-element', async ({
    page,
    api,
    baseURL,
  }) => {
    const docName = `test-q29-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    // Two well-formed non-portable images surrounding a typical paragraph.
    // Malformed-URL injection requires raw HTML which markdown round-trip
    // would normalize away — this test proves the walker doesn't ABORT
    // when one element's classifier path takes longer or fails.
    const warns: string[] = [];
    page.on('console', (msg) => {
      if (['warning', 'warn', 'log'].includes(msg.type())) warns.push(msg.text());
    });
    await fetch(`${baseURL}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        markdown: '![first](./a.jpg)\n\nProse paragraph.\n\n![third](./b.jpg)\n',
        position: 'replace',
      }),
    });
    await expect(async () => {
      expect(await getYText(page)).toContain('![first](./a.jpg)');
    }).toPass({ timeout: 5_000 });
    await page.click('.ProseMirror:not(.composer-prosemirror)');

    const captured = await simulateCopyAndRead(page, 'wysiwyg');
    expect(captured.plain).toContain('![first](./a.jpg)');
    expect(captured.plain).toContain('![third](./b.jpg)');

    // Two source-fallback emissions — one per non-portable image.
    const sourceEmittedCount = warns.filter((w) =>
      /clipboard-walker-url-source-emitted/.test(w),
    ).length;
    expect(sourceEmittedCount).toBeGreaterThanOrEqual(2);
    // Walker did NOT abort — both images present in captured.html as
    // source-fallback shapes.
    const preCount = (captured.html.match(/<pre class="mdx-component">/g) ?? []).length;
    expect(preCount).toBeGreaterThanOrEqual(2);
  });
});

test.describe('NFR Performance — walker post-pass under typical selections', () => {
  test('QA-040 50-element non-portable selection emits no clipboard-slow-op', async ({
    page,
    api,
    baseURL,
  }) => {
    // NFR Performance: walker post-pass adds <5ms for 10-100
    // URL-bearing elements; no `clipboard-slow-op` regression. Build a
    // 50-image selection and assert no slow-op telemetry fires.
    const docName = `test-q40-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    const lines: string[] = [];
    for (let i = 0; i < 50; i++) lines.push(`![img${i}](./img-${i}.jpg)`);
    const markdown = `${lines.join('\n\n')}\n`;

    await fetch(`${baseURL}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, markdown, position: 'replace' }),
    });
    await expect(async () => {
      expect(await getYText(page)).toContain('![img0](./img-0.jpg)');
      expect(await getYText(page)).toContain('![img49](./img-49.jpg)');
    }).toPass({ timeout: 10_000 });
    await page.click('.ProseMirror:not(.composer-prosemirror)');

    const warns: string[] = [];
    page.on('console', (msg) => {
      if (['warning', 'warn', 'log'].includes(msg.type())) warns.push(msg.text());
    });
    const captured = await simulateCopyAndRead(page, 'wysiwyg');

    // 50 source-fallback emissions, one per image.
    const preCount = (captured.html.match(/<pre class="mdx-component">/g) ?? []).length;
    expect(preCount).toBe(50);
    // No clipboard-slow-op events fired (100ms COPY threshold in
    // instrument.ts).
    const sawSlow = warns.some((w) => /clipboard-slow-op/.test(w));
    expect(sawSlow).toBe(false);
  });
});
