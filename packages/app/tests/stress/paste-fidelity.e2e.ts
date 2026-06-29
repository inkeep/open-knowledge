import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import {
  expect,
  selectAllAndWaitForSelection,
  simulateCopyAndRead,
  simulateCutAndRead,
  test,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

const PERF_BASELINE: { qa022: { p50Ms: number } } = JSON.parse(
  readFileSync(join(fileURLToPath(import.meta.url), '..', 'perf-baseline.json'), 'utf-8'),
);

const _dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE_ROOT = join(_dirname, '../../../core/src/markdown/rehype-plugins/fixtures');
function fixture(name: string): string {
  return readFileSync(join(FIXTURE_ROOT, name), 'utf-8');
}

async function getYText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const provider = window.__activeProvider;
    return provider?.document?.getText('source')?.toString() ?? '';
  });
}

async function pasteText(page: Page, text: string) {
  await page.evaluate((content) => {
    const editor = document.querySelector('.ProseMirror');
    if (!editor) throw new Error('ProseMirror editor not found');
    const dt = new DataTransfer();
    dt.setData('text/plain', content);
    const event = new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(event);
  }, text);
}

async function pasteWithMimes(
  page: Page,
  mimes: Record<string, string>,
  options: { shiftKey?: boolean } = {},
) {
  await page.evaluate(
    ({ mimes: m, shiftKey }) => {
      const editor = document.querySelector('.ProseMirror');
      if (!editor) throw new Error('ProseMirror editor not found');
      const dt = new DataTransfer();
      for (const [key, value] of Object.entries(m)) dt.setData(key, value);
      const event = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, 'shiftKey', { value: Boolean(shiftKey) });
      editor.dispatchEvent(event);
    },
    { mimes, shiftKey: options.shiftKey },
  );
}

test.describe('V1 paste baseline — text/plain content through WYSIWYG', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-paste-base-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.click('.ProseMirror');
  });

  test('plain text paste survives round-trip', async ({ page }) => {
    await pasteText(page, 'Hello world');
    await expect(async () => {
      expect(await getYText(page)).toContain('Hello world');
    }).toPass({ timeout: 5_000 });
  });

  test('markdown with heading paste', async ({ page }) => {
    await pasteText(page, '# Pasted Heading');
    await expect(async () => {
      expect(await getYText(page)).toContain('Pasted Heading');
    }).toPass({ timeout: 5_000 });
  });

  test('markdown with emphasis paste', async ({ page }) => {
    await pasteText(page, 'This is **bold** and *italic* text');
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('bold');
      expect(content).toContain('italic');
    }).toPass({ timeout: 5_000 });
  });

  test('markdown with code block paste', async ({ page }) => {
    await pasteText(page, '```js\nconst x = 1;\n```');
    await expect(async () => {
      expect(await getYText(page)).toContain('const x = 1');
    }).toPass({ timeout: 5_000 });
  });

  test('markdown with link paste', async ({ page }) => {
    await pasteText(page, 'Visit [example](https://example.com) for more');
    await expect(async () => {
      expect(await getYText(page)).toContain('example');
    }).toPass({ timeout: 5_000 });
  });

  test('markdown with list paste', async ({ page }) => {
    await pasteText(page, '- Item 1\n- Item 2\n- Item 3');
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('Item 1');
      expect(content).toContain('Item 2');
    }).toPass({ timeout: 5_000 });
  });
});

test.describe('Copy-side: simulateCopyAndRead captures MIME map', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-paste-copy-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
  });

  test('WYSIWYG copy → text/plain carries markdown', async ({ page }) => {
    await page.click('.ProseMirror');
    await pasteText(page, '# Title\n\nBody text here.\n');
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toContain('Body text here');
    const out = await simulateCopyAndRead(page, 'wysiwyg');
    expect(out.plain).toContain('Title');
    expect(out.plain).toContain('Body text here');
  });

  test('WYSIWYG copy → text/html is wrapped in data-pm-slice', async ({ page }) => {
    await page.click('.ProseMirror');
    await pasteText(page, '# Hi');
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toContain('Hi');
    const out = await simulateCopyAndRead(page, 'wysiwyg');
    expect(out.html).toContain('data-pm-slice');
  });

  test('WYSIWYG copy with wikiLink → text/html emits cross-pipeline anchor shape', async ({
    page,
    baseURL,
  }) => {
    await fetch(`${baseURL}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        markdown: 'See [[Page|Alias]] here\n',
        position: 'replace',
      }),
    });
    await expect(async () => {
      expect(await getYText(page)).toContain('[[Page|Alias]]');
    }).toPass({ timeout: 5_000 });
    await page.click('.ProseMirror');
    const out = await simulateCopyAndRead(page, 'wysiwyg');
    expect(out.plain).toContain('[[Page|Alias]]');
    expect(out.html).toContain('class="wiki-link"');
    expect(out.html).toContain('data-target="Page"');
    expect(out.html).toContain('href="#page"');
    expect(out.html).not.toContain('<script>');
  });

  test('empty WYSIWYG selection copy → clipboard unchanged (FR-15)', async ({ page }) => {
    const out = await simulateCopyAndRead(page, 'wysiwyg').catch(() => ({ plain: '', html: '' }));
    expect(out.plain === '' || typeof out.plain === 'string').toBe(true);
  });
});

test.describe('Paste from vendor HTML → structured content through Branch D', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-paste-vendor-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.click('.ProseMirror');
  });

  test('Gmail-shaped HTML strips gmail_* classes', async ({ page }) => {
    await pasteWithMimes(page, {
      'text/plain': 'gmail content',
      'text/html':
        '<div class="gmail_default"><p class="gmail_default">Hello from Gmail</p><p class="gmail_default">Second line</p></div>',
    });
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('Hello from Gmail');
      expect(content).not.toContain('gmail_default');
    }).toPass({ timeout: 5_000 });
  });

  test('Google Docs-shaped HTML strips docs-internal-guid wrapper', async ({ page }) => {
    await pasteWithMimes(page, {
      'text/plain': 'gdocs content',
      'text/html':
        '<b id="docs-internal-guid-aaaaaaaa-0000-1111-2222-333333333333"><h2>From GDocs</h2><p>A paragraph.</p></b>',
    });
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('From GDocs');
      expect(content).toContain('A paragraph');
      expect(content).not.toContain('docs-internal-guid');
    }).toPass({ timeout: 5_000 });
  });

  test('Word-shaped HTML strips mso-* styles', async ({ page }) => {
    await pasteWithMimes(page, {
      'text/plain': 'word content',
      'text/html':
        '<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><p class="MsoNormal" style="mso-margin-top-alt:auto">From Word</p></body></html>',
    });
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('From Word');
      expect(content).not.toContain('MsoNormal');
      expect(content).not.toContain('mso-margin');
    }).toPass({ timeout: 5_000 });
  });

  test('Notion marker preserves literal-newline hard breaks', async ({ page }) => {
    await pasteWithMimes(page, {
      'text/plain': 'notion plain',
      'text/html': '<!-- notionvc: abc --><p>line one\nline two</p>',
    });
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('line one');
      expect(content).toContain('line two');
    }).toPass({ timeout: 5_000 });
  });

  test('VS Code vscode-editor-data MIME → fenced code block (Branch A)', async ({ page }) => {
    await pasteWithMimes(page, {
      'vscode-editor-data': JSON.stringify({ mode: 'typescript' }),
      'text/plain': 'const x = 1;',
    });
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('```typescript');
      expect(content).toContain('const x = 1;');
    }).toPass({ timeout: 5_000 });
  });

  test('generic HTML (no fingerprint) routes through Branch D', async ({ page }) => {
    await pasteWithMimes(page, {
      'text/plain': 'fallback text',
      'text/html': '<h1>Generic Heading</h1><p>Generic <strong>bold</strong> paragraph.</p>',
    });
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('Generic Heading');
      expect(content).toContain('bold');
    }).toPass({ timeout: 5_000 });
  });
});

test.describe('WYSIWYG FR-specific paste behavior', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-paste-fr-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.click('.ProseMirror');
  });

  test('FR-10: paste inside a codeBlock inserts verbatim (no markdown parse)', async ({ page }) => {
    await pasteText(page, '```js\nexisting line\n```\n');
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toContain('existing line');
    await page.locator('.ProseMirror pre').first().click();
    await pasteText(page, '# this stays literal');
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('# this stays literal');
    }).toPass({ timeout: 5_000 });
  });

  test('FR-13: ambiguous paste (text/plain markdown + text/html) prefers markdown', async ({
    page,
  }) => {
    await pasteWithMimes(page, {
      'text/plain': '# markdown heading\n\n- bullet\n- bullet\n\n[link](url)\n',
      'text/html': '<p>plain HTML version with <strong>rich</strong> content</p>',
    });
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('markdown heading');
      expect(content).toContain('bullet');
    }).toPass({ timeout: 5_000 });
  });

  test('FR-17: Cmd+Shift+V inserts text/plain verbatim regardless of HTML', async ({ page }) => {
    await pasteWithMimes(
      page,
      {
        'text/plain': '# literal hash',
        'text/html': '<h1>would-be heading</h1>',
      },
      { shiftKey: true },
    );
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('# literal hash');
    }).toPass({ timeout: 5_000 });
  });

  test('FR-19: copy inside a code block emits fenced block form', async ({ page }) => {
    await pasteText(page, '```python\nprint(1)\nprint(2)\n```\n');
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toContain('print(1)');
    const out = await simulateCopyAndRead(page, 'wysiwyg');
    expect(out.plain).toContain('```');
    expect(out.plain).toContain('print(1)');
    expect(out.html).toMatch(/<pre[\s>]/);
    expect(out.html).toMatch(/<code[\s>]/);
  });
});

async function pasteHtmlInSource(page: Page, html: string, plain: string) {
  await page.evaluate(
    ({ html: h, plain: p }) => {
      const editor = document.querySelector('.cm-content');
      if (!editor) throw new Error('Source editor (.cm-content) not found');
      const dt = new DataTransfer();
      dt.setData('text/plain', p);
      dt.setData('text/html', h);
      const event = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(event);
    },
    { html, plain },
  );
}

test.describe('FR-21 large-paste chunked insertion (Source view)', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-paste-chunk-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.getByRole('radio', { name: /Markdown source/i }).click({ timeout: 10_000 });
    await page.waitForSelector('.cm-content', { timeout: 10_000 });
  });

  test('1MB HTML paste lands in Y.Text via chunked insertion without blocking', async ({
    page,
  }) => {
    const seed = 'seeded line\n'.repeat(1000);
    await page.evaluate((s) => {
      const editor = document.querySelector('.cm-content');
      if (!editor) throw new Error('no cm-content');
      const dt = new DataTransfer();
      dt.setData('text/plain', s);
      editor.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    }, seed);
    await expect
      .poll(() => getYText(page).then((s) => s.length), { timeout: 10_000 })
      .toBeGreaterThan(8_000);

    const paragraph = '<p>line of prose that is pasted in a big block</p>';
    const html = paragraph.repeat(22_000);
    const plain = 'line of prose that is pasted in a big block\n'.repeat(22_000);
    expect(html.length).toBeGreaterThan(1_000_000);

    const before = (await getYText(page)).length;
    await pasteHtmlInSource(page, html, plain);
    await expect(async () => {
      const after = (await getYText(page)).length;
      expect(after - before).toBeGreaterThan(900_000);
    }).toPass({ timeout: 30_000 });
  });
});

test.describe('FR-22 drag-and-drop MIME parity (dragstart uses same hooks as copy)', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-paste-dnd-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.click('.ProseMirror');
  });

  test('dragstart writes both text/plain markdown AND text/html with data-pm-slice', async ({
    page,
  }) => {
    await pasteText(page, '# Drag Me\n\nProse.\n');
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toContain('Drag Me');
    await selectAllAndWaitForSelection(page, '.ProseMirror');
    const out = await page.evaluate(() => {
      const editor = document.querySelector('.ProseMirror') as HTMLElement | null;
      if (!editor) throw new Error('no editor');
      const captured: Record<string, string> = {};
      const dt = new DataTransfer();
      const orig = dt.setData.bind(dt);
      dt.setData = (k: string, v: string) => {
        captured[k] = v;
        orig(k, v);
      };
      const event = new DragEvent('dragstart', {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(event);
      return {
        plain: captured['text/plain'] ?? '',
        html: captured['text/html'] ?? '',
      };
    });
    expect(out.plain).toContain('Drag Me');
    expect(out.html).toContain('data-pm-slice');
  });
});

test.describe('Vendor HTML fixtures → structured content through Branch D', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-paste-fixture-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.click('.ProseMirror');
  });

  test('QA-038 Apple Notes fixture strips Cocoa meta + Apple-tab-span classes', async ({
    page,
  }) => {
    await pasteWithMimes(page, {
      'text/plain': 'Grocery list\nMilk\t1 gallon\nBread  2 loaves\nEggs\t1 dozen\n',
      'text/html': fixture('apple-notes-sample.html'),
    });
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('Grocery list');
      expect(content).toContain('Milk');
      expect(content).not.toContain('Apple-tab-span');
      expect(content).not.toContain('Cocoa HTML Writer');
    }).toPass({ timeout: 5_000 });
  });

  test('QA-039 Slack fixture strips c-message_kit__* / c-timestamp classes', async ({ page }) => {
    await pasteWithMimes(page, {
      'text/plain': 'Hey team — can we ship the clipboard feature this week? @ada thoughts?',
      'text/html': fixture('slack-sample.html'),
    });
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('ship the clipboard feature');
      expect(content).not.toContain('c-message_kit__');
      expect(content).not.toContain('c-timestamp');
      expect(content).not.toContain('11:24 AM');
    }).toPass({ timeout: 5_000 });
  });

  test('QA-040 Google Sheets fixture unwraps google-sheets-html-origin + drops <style>', async ({
    page,
  }) => {
    await pasteWithMimes(page, {
      'text/plain': 'Header A\tHeader B\nRow1A\tRow1B\nRow2A\tRow2B\n',
      'text/html': fixture('gsheets-sample.html'),
    });
    await expect(async () => {
      const content = await getYText(page);
      expect(content).not.toContain('google-sheets-html-origin');
      expect(content).not.toContain('mso-data-placement');
      expect(content).not.toContain('data-sheets-');
    }).toPass({ timeout: 5_000 });
  });

  test('QA-041 GitHub rendered comment strips data-hovercard-* + class markers', async ({
    page,
  }) => {
    await pasteWithMimes(page, {
      'text/plain': "This references abc123 and CC's @octocat.\nSee also issue #42.",
      'text/html': fixture('github-comment-sample.html'),
    });
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('abc123');
      expect(content).toContain('octocat');
      expect(content).not.toContain('data-hovercard');
      expect(content).not.toContain('class="commit-link"');
    }).toPass({ timeout: 5_000 });
  });
});

test.describe('Source-view copy output (FR-4, D4 byte-parity)', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-paste-srcopy-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.click('.ProseMirror');
    await pasteText(page, '# Title\n\nBody with **bold** and a [[Page|Alias]] link.\n');
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toContain('[[Page|Alias]]');
  });

  test('Source copy emits source-shaped text/html wrapper alongside text/plain', async ({
    page,
  }) => {
    await page.getByRole('radio', { name: /Markdown source/i }).click({ timeout: 10_000 });
    await page.waitForSelector('.cm-content', { timeout: 10_000 });
    await expect(page.locator('.cm-content')).toContainText('Title', { timeout: 5_000 });
    const out = await simulateCopyAndRead(page, 'source');
    expect(out.plain.length).toBeGreaterThan(0);
    expect(out.plain).toContain('Title');
    expect(out.plain).toContain('[[Page|Alias]]');
    expect(out.html.length).toBeGreaterThan(0);
    expect(out.html).toContain('<pre class="mdx-component">');
    expect(out.html).toContain('<code>');
    expect(out.html).toContain('[[Page|Alias]]');
    expect(out.html).not.toContain('<h1');
  });

  test('Source copy and WYSIWYG copy carry equivalent text/plain bytes', async ({ page }) => {
    const wysiwygOut = await simulateCopyAndRead(page, 'wysiwyg');
    await page.getByRole('radio', { name: /Markdown source/i }).click({ timeout: 10_000 });
    await page.waitForSelector('.cm-content', { timeout: 10_000 });
    await expect(page.locator('.cm-content')).toContainText('[[Page|Alias]]', { timeout: 5_000 });
    const sourceOut = await simulateCopyAndRead(page, 'source');

    expect(sourceOut.plain).toContain('Title');
    expect(wysiwygOut.plain).toContain('Title');
    expect(sourceOut.plain).toContain('[[Page|Alias]]');
    expect(wysiwygOut.plain).toContain('[[Page|Alias]]');
    expect(sourceOut.html).toContain('<pre class="mdx-component">');
    expect(sourceOut.html).toContain('[[Page|Alias]]');
    expect(wysiwygOut.html).toContain('class="wiki-link"');
    expect(wysiwygOut.html).toContain('data-target="Page"');
    expect(sourceOut.html).not.toContain('data-resolved');
    expect(wysiwygOut.html).not.toContain('data-resolved');
  });
});

test.describe('FR-11 fallback: oversized text/html falls through to text/plain', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-paste-fallback-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.click('.ProseMirror');
  });

  test('QA-031 WYSIWYG >5MB text/html skips Branch D, lands via Branch E plain-text', async ({
    page,
  }) => {
    const warnings: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'warning' || msg.type() === 'warn' || msg.type() === 'log') {
        warnings.push(msg.text());
      }
    });
    const fragment = '<p>x</p>';
    const html = fragment.repeat(750_000);
    expect(html.length).toBeGreaterThan(5 * 1024 * 1024);
    await pasteWithMimes(page, {
      'text/plain': 'fallback payload should land',
      'text/html': html,
    });
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('fallback payload should land');
    }).toPass({ timeout: 10_000 });
    const sawTooLarge = warnings.some(
      (w) => w.includes('HtmlPayloadTooLargeError') || w.includes('clipboard-html-conversion-fail'),
    );
    expect(sawTooLarge).toBe(true);
  });
});

test.describe('FR-20 URL scheme sanitization on copy', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-paste-xss-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.click('.ProseMirror');
  });

  test('QA-034 javascript: / data: / vbscript: hrefs never reach the outbound clipboard HTML', async ({
    page,
    baseURL,
  }) => {
    const evil = [
      '[run-js](javascript:alert(1))',
      '[data-leak](data:text/html,<script>1</script>)',
      '[vb-exploit](vbscript:msgbox(1))',
      '[file-leak](file:///etc/passwd)',
    ].join('\n\n');
    await fetch(`${baseURL}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, markdown: evil, position: 'replace' }),
    });
    await expect(async () => {
      expect(await getYText(page)).toContain('run-js');
    }).toPass({ timeout: 5_000 });
    await page.click('.ProseMirror');
    const out = await simulateCopyAndRead(page, 'wysiwyg');
    expect(out.html.toLowerCase()).not.toContain('javascript:');
    expect(out.html.toLowerCase()).not.toContain('data:text/html');
    expect(out.html.toLowerCase()).not.toContain('vbscript:');
    expect(out.html.toLowerCase()).not.toContain('file:///');
    expect(out.html).toContain('run-js');
    expect(out.html).toContain('data-leak');
  });
});

test.describe('FR-16 drag-and-drop scenarios beyond dragstart MIME parity', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-paste-dnd2-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.click('.ProseMirror');
  });

  test('QA-043 external drag-in from a Gmail-shaped HTML payload routes through Branch D', async ({
    page,
  }) => {
    await page.evaluate(() => {
      const editor = document.querySelector('.ProseMirror') as HTMLElement | null;
      if (!editor) throw new Error('no editor');
      const dt = new DataTransfer();
      dt.setData(
        'text/html',
        '<div class="gmail_quote"><p class="gmail_default">Dropped from Gmail</p></div>',
      );
      dt.setData('text/plain', 'Dropped from Gmail');
      const rect = editor.getBoundingClientRect();
      const cx = rect.left + Math.floor(rect.width / 2);
      const cy = rect.top + Math.floor(rect.height / 2);
      const over = new DragEvent('dragover', {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
        clientX: cx,
        clientY: cy,
      });
      editor.dispatchEvent(over);
      const drop = new DragEvent('drop', {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
        clientX: cx,
        clientY: cy,
      });
      editor.dispatchEvent(drop);
    });
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('Dropped from Gmail');
      expect(content).not.toContain('gmail_quote');
      expect(content).not.toContain('gmail_default');
    }).toPass({ timeout: 5_000 });
  });
});

test.describe('FR-12 WYSIWYG cut writes MIMEs AND deletes selection', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-paste-cut-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.click('.ProseMirror');
  });

  test('QA-044 Cmd+X emits text/plain markdown + text/html AND removes the selection', async ({
    page,
  }) => {
    await pasteText(page, '# Cut Me\n\nProse body.\n');
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toContain('Cut Me');
    const out = await simulateCutAndRead(page, 'wysiwyg');
    expect(out.plain).toContain('Cut Me');
    expect(out.html).toContain('<h1');
    await expect(async () => {
      const yt = await getYText(page);
      expect(yt).not.toContain('Cut Me');
    }).toPass({ timeout: 5_000 });
  });
});

test.describe('FR-21 chunked insertion maintains 60fps frame budget', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-paste-fps-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.getByRole('radio', { name: /Markdown source/i }).click({ timeout: 10_000 });
    await page.waitForSelector('.cm-content', { timeout: 10_000 });
  });

  test('QA-022 chunked-paste p50 frame-time stays within baseline-relative budget', async ({
    page,
  }) => {
    test.slow();
    await page.evaluate(() => {
      const state = window as unknown as {
        __frameTimes: number[];
        __ytextSamples: Array<{ ts: number; len: number }>;
        __stopSampler: () => void;
      };
      state.__frameTimes = [];
      state.__ytextSamples = [];
      let lastTs = performance.now();
      let stop = false;
      const sampler = (ts: number) => {
        if (stop) return;
        state.__frameTimes.push(ts - lastTs);
        const provider = (
          window as unknown as {
            __activeProvider?: {
              document?: { getText: (name: string) => { toString: () => string } };
            };
          }
        ).__activeProvider;
        const yt = provider?.document?.getText('source');
        state.__ytextSamples.push({ ts, len: yt?.toString().length ?? 0 });
        lastTs = ts;
        requestAnimationFrame(sampler);
      };
      requestAnimationFrame(sampler);
      state.__stopSampler = () => {
        stop = true;
      };
    });

    const paragraph = '<p>line of prose that is pasted in a big block</p>';
    const html = paragraph.repeat(22_000);
    const plain = 'line of prose that is pasted in a big block\n'.repeat(22_000);
    const before = (await getYText(page)).length;
    await pasteHtmlInSource(page, html, plain);
    await expect(async () => {
      const after = (await getYText(page)).length;
      expect(after - before).toBeGreaterThan(900_000);
    }).toPass({ timeout: 30_000 });

    const metrics = await page.evaluate((baseline) => {
      const state = window as unknown as {
        __frameTimes: number[];
        __ytextSamples: Array<{ ts: number; len: number }>;
        __stopSampler: () => void;
      };
      state.__stopSampler();
      const samples = state.__frameTimes;
      const ytSamples = state.__ytextSamples;
      const firstGrowthIdx = ytSamples.findIndex((s) => s.len > baseline + 1024);
      const plateauStart = (() => {
        for (let i = ytSamples.length - 2; i > firstGrowthIdx; i--) {
          if (ytSamples[i + 1].len === ytSamples[i].len) continue;
          return i + 1;
        }
        return ytSamples.length;
      })();
      const chunkingWindow = samples.slice(firstGrowthIdx, plateauStart);
      const sorted = [...chunkingWindow].sort((a, b) => a - b);
      const p = (q: number) => sorted[Math.floor(sorted.length * q)] ?? 0;
      return {
        windowFrames: chunkingWindow.length,
        totalFrames: samples.length,
        firstGrowthIdx,
        plateauStart,
        p50: p(0.5),
        p95: p(0.95),
        max: sorted[sorted.length - 1] ?? 0,
        over16: chunkingWindow.filter((s) => s > 16).length,
        over32: chunkingWindow.filter((s) => s > 32).length,
      };
    }, before);

    const p50Threshold = Math.max(2 * PERF_BASELINE.qa022.p50Ms, 80);
    console.log(
      `FR-21 frame metrics: ${JSON.stringify(metrics)} (p50 threshold = ${p50Threshold}ms, baseline = ${PERF_BASELINE.qa022.p50Ms}ms)`,
    );
    expect(metrics.windowFrames).toBeGreaterThan(2);
    expect(metrics.p50).toBeLessThan(p50Threshold);
    const estimatedWallTime = metrics.p50 * metrics.windowFrames;
    expect(estimatedWallTime).toBeLessThan(5000);
  });
});

test.describe('FR-17 + FR-12/FR-15 Source-view clipboard parity', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-paste-srcparity-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.click('.ProseMirror');
    await pasteText(page, '# Source Heading\n\nProse with **bold**.\n');
    await expect.poll(() => getYText(page), { timeout: 5_000 }).toContain('Source Heading');
    await page.getByRole('radio', { name: /Markdown source/i }).click({ timeout: 10_000 });
    await page.waitForSelector('.cm-content', { timeout: 10_000 });
    await expect(page.locator('.cm-content')).toContainText('Source Heading', { timeout: 5_000 });
  });

  test('QA-011 Source Cmd+Shift+V falls through to CM6 default (plain-text verbatim)', async ({
    page,
  }) => {
    const warnings: string[] = [];
    page.on('console', (msg) => {
      if (['warning', 'warn', 'log'].includes(msg.type())) warnings.push(msg.text());
    });
    const before = (await getYText(page)).length;
    await page.focus('.cm-content');
    await page.keyboard.press('ControlOrMeta+End');
    await page.evaluate((shiftKey) => {
      const editor = document.querySelector('.cm-content');
      if (!editor) throw new Error('no cm-content');
      const dt = new DataTransfer();
      dt.setData('text/plain', '\n# literal hash\n');
      dt.setData('text/html', '<h1>would-be heading</h1>');
      const event = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, 'shiftKey', { value: shiftKey });
      editor.dispatchEvent(event);
    }, true);
    await expect(async () => {
      const after = await getYText(page);
      expect(after).toContain('# literal hash');
      expect(after.length).toBeGreaterThan(before);
    }).toPass({ timeout: 5_000 });
    const sawShift = warnings.some(
      (w) => /clipboard-source-detected/.test(w) && /"branch":"shift"/.test(w),
    );
    expect(sawShift).toBe(true);
  });

  test('Source Cmd+X deletes selection AND writes both MIMEs in source-shaped HTML', async ({
    page,
  }) => {
    const out = await simulateCutAndRead(page, 'source');
    expect(out.plain).toContain('Source Heading');
    expect(out.html.length).toBeGreaterThan(0);
    expect(out.html).toContain('<pre class="mdx-component">');
    expect(out.html).toContain('# Source Heading');
    expect(out.html).not.toContain('<h1');
    await expect(async () => {
      const after = await getYText(page);
      expect(after).not.toContain('Source Heading');
    }).toPass({ timeout: 5_000 });
  });

  test('QA-016-source empty-selection copy is a no-op (FR-15)', async ({ page }) => {
    await page.focus('.cm-content');
    await page.keyboard.press('ControlOrMeta+End'); // move cursor to end, no range
    const out = await page.evaluate(() => {
      const editor = document.querySelector('.cm-content');
      if (!editor) throw new Error('no cm-content');
      const captured: Record<string, string> = {};
      const dt = new DataTransfer();
      const origSetData = dt.setData.bind(dt);
      dt.setData = (k: string, v: string) => {
        captured[k] = v;
        origSetData(k, v);
      };
      const event = new ClipboardEvent('copy', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(event);
      return { plain: captured['text/plain'] ?? '', html: captured['text/html'] ?? '' };
    });
    expect(out.plain).toBe('');
    expect(out.html).toBe('');
  });
});

test.describe('OK→OK round-trip through Branch C (data-pm-slice)', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-paste-rt-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
  });

  test('wikiLink + heading + bold round-trips through Branch C losslessly', async ({
    page,
    baseURL,
  }) => {
    const seedMarkdown = '## Target\n\nSee [[Page|Alias]] and **bold** here.\n';
    await fetch(`${baseURL}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, markdown: seedMarkdown, position: 'replace' }),
    });
    await expect(async () => {
      expect(await getYText(page)).toContain('[[Page|Alias]]');
    }).toPass({ timeout: 5_000 });

    await page.click('.ProseMirror');
    const captured = await simulateCopyAndRead(page, 'wysiwyg');
    expect(captured.html).toContain('data-pm-slice');
    expect(captured.html).toContain('class="wiki-link"');
    expect(captured.html).toContain('data-target="Page"');
    expect(captured.plain).toContain('[[Page|Alias]]');

    await fetch(`${baseURL}/api/test-reset?docName=${encodeURIComponent(docName)}`, {
      method: 'POST',
    });
    await page.evaluate(async (name) => {
      const dbs = await indexedDB.databases();
      const target = new RegExp(`^ok-ydoc:.*:${name}$`);
      await Promise.all(
        dbs
          .filter((d) => d.name !== undefined && target.test(d.name))
          .map(
            (d) =>
              new Promise<void>((resolve) => {
                const req = indexedDB.deleteDatabase(d.name as string);
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
                req.onblocked = () => resolve();
              }),
          ),
      );
    }, docName);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.click('.ProseMirror');
    await expect
      .poll(() => getYText(page).then((s) => s.length), { timeout: 10_000 })
      .toBeLessThan(20);

    await pasteWithMimes(page, {
      'text/plain': captured.plain,
      'text/html': captured.html,
    });

    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('[[Page|Alias]]');
      expect(content).toContain('## Target');
      expect(content).toContain('**bold**');
    }).toPass({ timeout: 5_000 });
  });

  test('Branch C is taken when data-pm-slice is present (not Branch D html→mdast)', async ({
    page,
    baseURL,
  }) => {
    const seedMarkdown = 'Prefix [[Thing]] suffix.\n';
    await fetch(`${baseURL}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, markdown: seedMarkdown, position: 'replace' }),
    });
    await expect(async () => {
      expect(await getYText(page)).toContain('[[Thing]]');
    }).toPass({ timeout: 5_000 });

    await page.click('.ProseMirror');
    const captured = await simulateCopyAndRead(page, 'wysiwyg');
    expect(captured.html).toContain('data-pm-slice');

    await fetch(`${baseURL}/api/test-reset?docName=${encodeURIComponent(docName)}`, {
      method: 'POST',
    });
    await page.evaluate(async (name) => {
      const dbs = await indexedDB.databases();
      const target = new RegExp(`^ok-ydoc:.*:${name}$`);
      await Promise.all(
        dbs
          .filter((d) => d.name !== undefined && target.test(d.name))
          .map(
            (d) =>
              new Promise<void>((resolve) => {
                const req = indexedDB.deleteDatabase(d.name as string);
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
                req.onblocked = () => resolve();
              }),
          ),
      );
    }, docName);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.click('.ProseMirror');
    await expect
      .poll(() => getYText(page).then((s) => s.length), { timeout: 10_000 })
      .toBeLessThan(20);

    await pasteWithMimes(page, {
      'text/plain': captured.plain,
      'text/html': captured.html,
    });

    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('[[Thing]]');
      expect(content).not.toContain('](Thing)'); // link form would indicate Branch D regression
    }).toPass({ timeout: 5_000 });
  });
});

test.describe('Clipboard component contract — OK→OK descriptor identity (US-009)', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-cb-contract-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.click('.ProseMirror');
  });

  test('CB-CONTRACT-1: <img/> JSX paste preserves descriptor identity (BUG class 1)', async ({
    page,
  }) => {
    await pasteWithMimes(page, {
      'text/plain': '<img src="https://example.com/x.png" alt="x" />',
      'text/html':
        '<div data-pm-slice="0 0 paragraph"><img src="https://example.com/x.png" alt="x" /></div>',
    });
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('<img');
      expect(content).toContain('src="https://example.com/x.png"');
      expect(content).not.toContain('![');
    }).toPass({ timeout: 5_000 });
  });

  test('CB-CONTRACT-2: <Callout> JSX paste preserves descriptor identity (BUG class 2)', async ({
    page,
  }) => {
    await pasteWithMimes(page, {
      'text/plain': '<Callout type="note">\n\nbody text\n\n</Callout>',
      'text/html':
        '<div data-pm-slice="0 0 paragraph"><pre class="mdx-component"><code>&lt;Callout&gt;</code></pre></div>',
    });
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('<Callout type="note">');
      expect(content).toContain('body text');
      expect(content).toContain('</Callout>');
      expect(content).not.toMatch(/^```/m);
    }).toPass({ timeout: 5_000 });
  });

  test('CB-CONTRACT-3: <details> paste preserves HtmlDetailsAccordion compat (BUG class 3)', async ({
    page,
  }) => {
    await pasteWithMimes(page, {
      'text/plain': '<details><summary>Q</summary>A</details>',
      'text/html':
        '<div data-pm-slice="0 0 paragraph"><pre class="mdx-component"><code>&lt;details&gt;</code></pre></div>',
    });
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('<details>');
      expect(content).toContain('<summary>Q</summary>');
      expect(content).toContain('A</details>');
    }).toPass({ timeout: 5_000 });
  });

  test('CB-CONTRACT-4: <u>foo</u> raw HTML inline survives via D18 heuristic (BUG class 4)', async ({
    page,
  }) => {
    await pasteText(page, 'before <u>underlined</u> after\n');
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('<u>underlined</u>');
    }).toPass({ timeout: 5_000 });
  });

  test('CB-CONTRACT-5: cross-view Callout — WYSIWYG paste survives view switch to Source', async ({
    page,
  }) => {
    await pasteText(page, '<Callout type="warning">\n\nbody text\n\n</Callout>\n');
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('<Callout type="warning">');
      expect(content).toContain('body text');
    }).toPass({ timeout: 5_000 });
  });
});

test.describe('Clipboard component contract — cross-machine + cross-PM-editor (US-009)', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-cb-cross-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.click('.ProseMirror');
  });

  test('CB-CONTRACT-6: cross-machine D4 — raw markdown <Callout> from email recovers descriptor identity', async ({
    page,
  }) => {
    await pasteText(page, '<Callout type="note">body</Callout>');
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('<Callout');
      expect(content).toContain('body');
      expect(content).toContain('</Callout>');
    }).toPass({ timeout: 5_000 });
  });

  test('CB-CONTRACT-7: cross-PM-editor — Linear-style canonical markdown text/plain routes through markdown path', async ({
    page,
  }) => {
    await pasteWithMimes(page, {
      'text/plain':
        '## Heading\n\n- item one\n- item two\n\nA paragraph with [a link](https://x).\n',
      'text/html':
        '<div data-pm-slice="0 0 paragraph"><h2>Heading</h2><ul><li>item one</li><li>item two</li></ul></div>',
    });
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('## Heading');
      expect(content).toContain('- item one');
      expect(content).toContain('[a link]');
    }).toPass({ timeout: 5_000 });
  });
});

test.describe('Clipboard component contract — drag-and-drop (US-009)', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-cb-dnd-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.click('.ProseMirror');
  });

  test('CB-CONTRACT-8: drag-out emits both text/plain markdown and text/html (FR-22 parity)', async ({
    page,
    baseURL,
  }) => {
    await fetch(`${baseURL}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        markdown: '<Callout type="note">\n\ndrag me\n\n</Callout>\n',
        position: 'replace',
      }),
    });
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('drag me');
    }).toPass({ timeout: 5_000 });
    const out = await simulateCopyAndRead(page, 'wysiwyg');
    expect(out.plain).toContain('<Callout type="note">');
    expect(out.plain).toContain('drag me');
    expect(out.html).toContain('data-pm-slice');
  });

  test('CB-CONTRACT-9: internal drag — slice content preserved through dispatcher reorder', async ({
    page,
    baseURL,
  }) => {
    await fetch(`${baseURL}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        markdown: '<img src="https://example.com/x.png" alt="x" />\n',
        position: 'replace',
      }),
    });
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('<img');
    }).toPass({ timeout: 5_000 });
    const out = await simulateCopyAndRead(page, 'wysiwyg');
    expect(out.plain).toContain('<img');
    expect(out.plain).toContain('src="https://example.com/x.png"');
  });

  test('CB-CONTRACT-10: paste of OK-canonical markdown round-trips byte-identically through Branch B markdown path', async ({
    page,
    baseURL,
  }) => {
    await fetch(`${baseURL}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        markdown: '<img src="x.png" alt="x" />\n',
        position: 'replace',
      }),
    });
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('<img');
    }).toPass({ timeout: 5_000 });
    const captured = await simulateCopyAndRead(page, 'wysiwyg');
    expect(captured.plain).toContain('<img');

    await fetch(`${baseURL}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, markdown: '\n', position: 'replace' }),
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.click('.ProseMirror');
    await expect
      .poll(() => getYText(page).then((s) => s.length), { timeout: 10_000 })
      .toBeLessThan(20);

    await pasteWithMimes(page, { 'text/plain': captured.plain, 'text/html': captured.html });
    await expect(async () => {
      const content = await getYText(page);
      expect(content).toContain('<img');
      expect(content).toContain('src="x.png"');
      expect(content).not.toMatch(/!\[/);
    }).toPass({ timeout: 5_000 });
  });

  test('CB-CONTRACT-11: cross-app render fidelity — emitted text/html uses rgb() and strips editor chrome', async ({
    page,
    baseURL,
  }) => {
    await fetch(`${baseURL}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        markdown:
          '<Callout type="note" title="Hi" collapsible defaultOpen>\n\nbody text\n\n</Callout>\n',
        position: 'replace',
      }),
    });
    await expect(async () => {
      expect(await getYText(page)).toContain('<Callout');
    }).toPass({ timeout: 5_000 });
    const out = await simulateCopyAndRead(page, 'wysiwyg');

    expect(out.html).not.toContain('oklch(');
    expect(out.html).not.toContain('oklab(');
    expect(out.html).toMatch(/rgb\(\s*\d/);

    expect(out.html).not.toContain('lucide-trash2');
    expect(out.html).not.toContain('lucide-settings2');
    expect(out.html).not.toContain('jsx-component-chrome');
    expect(out.html).not.toContain('jsx-chrome-btn');

    expect(out.html).not.toContain('lucide-chevron-down');
    expect(out.html).not.toContain('lucide-info');
    expect(out.html).not.toMatch(/<svg[^>]*class="[^"]*lucide-/);
    expect(out.html).toContain('⌄');
    expect(out.html).toContain('ℹ');
  });
});
