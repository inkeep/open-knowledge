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

    expect(captured.html).toMatch(/<pre class="mdx-component"[ >]/);
    expect(captured.html).toContain('<code>');
    expect(captured.html).toContain(`$$\n${formula}\n$$`);
    expect(captured.html).not.toContain('class="katex"');
  });

  test('```math-authored block math (MathFence) emits the same dollar source form', async ({
    page,
    baseURL,
  }) => {
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
