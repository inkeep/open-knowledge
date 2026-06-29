import { randomUUID } from 'node:crypto';
import { expect, test } from './_helpers';

const AGENT_MARKER = 'AGENT-MARKER-XYZ';
const USER_MARKER = 'USER-MARKER-PQR';

test('QA-016: agent write + local WYSIWYG edit converge in DOM on both clients', async ({
  browser,
  api,
  baseURL,
}) => {
  const docName = `test-observer-a-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${docName}.md`);
  await api.testReset(docName);

  const ctxA = await browser.newContext({ baseURL });
  const ctxB = await browser.newContext({ baseURL });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    const logsA: Array<{ type: string; text: string }> = [];
    const logsB: Array<{ type: string; text: string }> = [];
    pageA.on('console', (m) => logsA.push({ type: m.type(), text: m.text() }));
    pageA.on('pageerror', (e) => logsA.push({ type: 'uncaught', text: e.message }));
    pageB.on('console', (m) => logsB.push({ type: m.type(), text: m.text() }));
    pageB.on('pageerror', (e) => logsB.push({ type: 'uncaught', text: e.message }));

    await Promise.all([pageA.goto(`/#/${docName}`), pageB.goto(`/#/${docName}`)]);
    await Promise.all([
      pageA.waitForFunction(() => Boolean(window.__activeProvider), null, { timeout: 15_000 }),
      pageB.waitForFunction(() => Boolean(window.__activeProvider), null, { timeout: 15_000 }),
    ]);
    await Promise.all([
      pageA.waitForSelector('.ProseMirror'),
      pageB.waitForSelector('.ProseMirror'),
    ]);

    const seedRes = await fetch(`${baseURL}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, markdown: `baseline-line\n` }),
    });
    expect(seedRes.ok).toBe(true);

    await Promise.all([
      pageA.waitForFunction(
        () =>
          window.__activeProvider?.document
            ?.getText('source')
            ?.toString()
            ?.includes('baseline-line'),
        null,
        { timeout: 10_000 },
      ),
      pageB.waitForFunction(
        () =>
          window.__activeProvider?.document
            ?.getText('source')
            ?.toString()
            ?.includes('baseline-line'),
        null,
        { timeout: 10_000 },
      ),
    ]);

    await pageA.locator('.ProseMirror').focus();
    await pageA.keyboard.press('End');

    await api.replaceDoc(docName, `baseline-line ${AGENT_MARKER}\n`);

    await Promise.all([
      pageA.waitForFunction(
        (m: string) =>
          window.__activeProvider?.document?.getText('source')?.toString()?.includes(m),
        AGENT_MARKER,
        { timeout: 10_000 },
      ),
      pageB.waitForFunction(
        (m: string) =>
          window.__activeProvider?.document?.getText('source')?.toString()?.includes(m),
        AGENT_MARKER,
        { timeout: 10_000 },
      ),
    ]);

    await pageA.locator('.ProseMirror').focus();
    await pageA.keyboard.press('End');
    await pageA.keyboard.type(` ${USER_MARKER}`, { delay: 15 });

    await Promise.all([
      pageA.waitForFunction(
        ({ a, u }: { a: string; u: string }) => {
          const text = window.__activeProvider?.document?.getText('source')?.toString() ?? '';
          return text.includes(a) && text.includes(u);
        },
        { a: AGENT_MARKER, u: USER_MARKER },
        { timeout: 20_000 },
      ),
      pageB.waitForFunction(
        ({ a, u }: { a: string; u: string }) => {
          const text = window.__activeProvider?.document?.getText('source')?.toString() ?? '';
          return text.includes(a) && text.includes(u);
        },
        { a: AGENT_MARKER, u: USER_MARKER },
        { timeout: 20_000 },
      ),
    ]);

    const captureState = async (page: typeof pageA): Promise<{ ytext: string; dom: string }> =>
      page.evaluate(() => {
        const ytext = window.__activeProvider?.document?.getText('source')?.toString() ?? '';
        const editor = document.querySelector('.ProseMirror') as HTMLElement | null;
        const dom = editor?.innerText ?? '';
        return { ytext, dom };
      });
    const stateA = await captureState(pageA);
    const stateB = await captureState(pageB);

    expect(stateA.ytext).toContain(AGENT_MARKER);
    expect(stateA.ytext).toContain(USER_MARKER);
    expect(stateB.ytext).toContain(AGENT_MARKER);
    expect(stateB.ytext).toContain(USER_MARKER);

    expect(stateA.dom).toContain(AGENT_MARKER);
    expect(stateA.dom).toContain(USER_MARKER);
    expect(stateB.dom).toContain(AGENT_MARKER);
    expect(stateB.dom).toContain(USER_MARKER);

    const stripMarkers = (s: string): string => s.replace(/\s+/g, ' ').trim();
    expect(stripMarkers(stateA.dom)).toContain(stripMarkers(AGENT_MARKER));
    expect(stripMarkers(stateA.dom)).toContain(stripMarkers(USER_MARKER));

    const critical = (logs: Array<{ type: string; text: string }>) =>
      logs
        .filter((l) => l.type === 'error' || l.type === 'uncaught')
        .filter(
          (e) =>
            !e.text.includes('favicon') && !e.text.includes('HMR') && !e.text.includes('[vite]'),
        );
    expect(critical(logsA)).toEqual([]);
    expect(critical(logsB)).toEqual([]);
  } finally {
    await Promise.all([ctxA.close(), ctxB.close()]);
  }
});
