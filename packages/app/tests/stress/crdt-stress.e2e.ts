
import { randomUUID } from 'node:crypto';
import { loadLargeRealistic } from '../../../core/src/markdown/fixtures/index.ts';
import { expect, filterCriticalErrors, test } from './_helpers';

const FIXTURE = loadLargeRealistic();

test('S6: multi-turn stress — large content + user edits', async ({ page, api, baseURL }) => {
  const logs: Array<{ type: string; text: string; url?: string; line?: number }> = [];
  page.on('console', (m) => {
    const loc = m.location();
    logs.push({ type: m.type(), text: m.text(), url: loc.url, line: loc.lineNumber });
  });
  page.on('pageerror', (e) => logs.push({ type: 'uncaught', text: e.message }));

  const docName = `test-crdtstress-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.testReset(docName);

  await page.goto(`/#/${docName}`);
  await page.waitForFunction(() => Boolean(window.__activeProvider), null, {
    timeout: 15_000,
  });
  await page.waitForSelector('.ProseMirror');

  const markers = ['USER-E2E-MARK-1', 'USER-E2E-MARK-2', 'USER-E2E-MARK-3'];

  for (const marker of markers) {
    const writeRes = await fetch(`${baseURL}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, markdown: FIXTURE }),
    });
    expect(writeRes.ok).toBe(true);

    await page.waitForFunction(
      (expected: number) =>
        window.__activeProvider?.document?.getText('source')?.toString()?.length >= expected,
      FIXTURE.length - 200, // tolerance for whitespace normalization
      { timeout: 30_000 },
    );

    await page.locator('.ProseMirror').focus();
    await page.keyboard.type(marker, { delay: 5 });

    await page.waitForFunction(
      (m: string) => window.__activeProvider?.document?.getText('source')?.toString()?.includes(m),
      marker,
      { timeout: 30_000 },
    );

    const turnState = await page.evaluate(() => {
      const provider = window.__activeProvider;
      const ytext = provider?.document?.getText('source');
      const frag = provider?.document?.getXmlFragment('default');
      return {
        ytextLen: ytext?.toString()?.length ?? 0,
        fragChildren: frag?.length ?? 0,
      };
    });
    console.log(
      `[Layer C] Turn complete: ytext=${turnState.ytextLen}, fragment=${turnState.fragChildren}`,
    );
  }

  const errors = logs.filter((l) => l.type === 'error' || l.type === 'uncaught');
  const criticalErrors = filterCriticalErrors(errors);
  if (criticalErrors.length > 0) {
    console.error('[Layer C] Critical errors detected:', JSON.stringify(criticalErrors, null, 2));
  }
  expect(criticalErrors).toEqual([]);

  const finalState = await page.evaluate(() => {
    const provider = window.__activeProvider;
    return {
      ytext: provider.document.getText('source').toString(),
    };
  });

  for (const marker of markers) {
    expect(finalState.ytext).toContain(marker);
  }
});
