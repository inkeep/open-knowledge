
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
    await page.waitForSelector('.ProseMirror');
  });

  test('QA-001 standalone relative-path image paragraph emits block source-fallback', async ({
    page,
    baseURL,
  }) => {
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
    await page.click('.ProseMirror');

    const captured = await simulateCopyAndRead(page, 'wysiwyg');

    expect(captured.plain).toContain('![chart](./Q3-sales.png)');
    expect(captured.html).toContain('<pre class="mdx-component">');
    expect(captured.html).toContain('<code>');
    expect(captured.html).toContain('![chart](./Q3-sales.png)');
    expect(captured.html).not.toContain('src="./Q3-sales.png"');
  });

  test('QA-005 inline image in paragraph emits inline source-fallback (D16 paragraph-content rule)', async ({
    page,
    baseURL,
  }) => {
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
    await page.click('.ProseMirror');

    const captured = await simulateCopyAndRead(page, 'wysiwyg');

    expect(captured.plain).toContain('Some prose with an ![alt](./x.jpg) image.');
    expect(captured.html).toContain('<span class="mdx-inline">');
    expect(captured.html).toContain('![alt](./x.jpg)');
    expect(captured.html).not.toMatch(/<p[\s>][^>]*>[^<]*<pre/);
    expect(captured.html).not.toContain('src="./x.jpg"');
  });

  test('QA-009 all-portable selection: walker passes through unchanged (regression check)', async ({
    page,
    baseURL,
  }) => {
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
    await page.click('.ProseMirror');

    const captured = await simulateCopyAndRead(page, 'wysiwyg');

    expect(captured.html).not.toContain('<pre class="mdx-component">');
    expect(captured.html).not.toContain('<span class="mdx-inline">');
    expect(captured.html).toContain('https://example.com/x.jpg');
    expect(captured.html).toContain('href="#otherdoc"');
    const sawSource = warns.some((w) => /clipboard-walker-url-source-emitted/.test(w));
    expect(sawSource).toBe(false);
  });

  test('QA-010 text/plain canonical markdown emission unchanged (regression)', async ({
    page,
    baseURL,
  }) => {
    const seedMarkdown = '# H\n\n- a\n- b\n\n![chart](./local.png)\n';
    await fetch(`${baseURL}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, markdown: seedMarkdown, position: 'replace' }),
    });
    await expect(async () => {
      expect(await getYText(page)).toContain('![chart](./local.png)');
    }).toPass({ timeout: 5_000 });
    await page.click('.ProseMirror');

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
    const seedMarkdown = '# H1\n\n- a\n- b\n\n![alt](./local.jpg)\n\n[[OtherDoc#Section]]\n';
    const sourceDocName = `test-q4-src-${randomUUID().slice(0, 8)}`;
    const targetDocName = `test-q4-dst-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${sourceDocName}.md`);
    await api.createPage(`${targetDocName}.md`);

    await fetch(`${baseURL}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName: sourceDocName,
        markdown: seedMarkdown,
        position: 'replace',
      }),
    });

    await page.goto(`/#/${sourceDocName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.getByRole('radio', { name: /Markdown source/i }).click({ timeout: 10_000 });
    await page.waitForSelector('.cm-content');
    await expect(page.locator('.cm-content')).toContainText('OtherDoc#Section', {
      timeout: 5_000,
    });
    const captured = await simulateCopyAndRead(page, 'source');

    expect(captured.plain).toContain('# H1');
    expect(captured.plain).toContain('![alt](./local.jpg)');
    expect(captured.plain).toContain('[[OtherDoc#Section]]');
    expect(captured.html).toContain('<pre class="mdx-component">');
    expect(captured.html).toContain('[[OtherDoc#Section]]');

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
    await page.waitForSelector('.ProseMirror');

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
    await page.click('.ProseMirror');

    const captured = await simulateCopyAndRead(page, 'wysiwyg');
    expect(captured.plain).toContain('![first](./a.jpg)');
    expect(captured.plain).toContain('![third](./b.jpg)');

    const sourceEmittedCount = warns.filter((w) =>
      /clipboard-walker-url-source-emitted/.test(w),
    ).length;
    expect(sourceEmittedCount).toBeGreaterThanOrEqual(2);
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
    const docName = `test-q40-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');

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
    await page.click('.ProseMirror');

    const warns: string[] = [];
    page.on('console', (msg) => {
      if (['warning', 'warn', 'log'].includes(msg.type())) warns.push(msg.text());
    });
    const captured = await simulateCopyAndRead(page, 'wysiwyg');

    const preCount = (captured.html.match(/<pre class="mdx-component">/g) ?? []).length;
    expect(preCount).toBe(50);
    const sawSlow = warns.some((w) => /clipboard-slow-op/.test(w));
    expect(sawSlow).toBe(false);
  });
});
