import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  expect,
  filterCriticalErrors,
  type LogEntry,
  test,
  waitForActiveProviderSynced,
  waitForPmSelectionInNode,
} from './_helpers';

const MINIMAL_SOURCE =
  'x\n\n    -\n\n            - [a](b)\n\nWrapped\n   continuation line\n\n01. a\n02. b\n';
const EDITOR = '.ProseMirror:not(.composer-prosemirror):visible';

interface ResidualFallbackCounters {
  observerAResidualMergeSpliceLanded: number;
  observerAResidualMergeSpliceBlockedLossy: number;
  observerAResidualMergeSpliceUnavailable: Record<string, number>;
}

async function readFallbackCounters(baseURL: string): Promise<ResidualFallbackCounters> {
  const res = await fetch(`${baseURL}/api/metrics/reconciliation`);
  expect(res.status).toBe(200);
  return (await res.json()) as ResidualFallbackCounters;
}

test('deleting an empty item before a link survives peer sync, persistence, and reload', async ({
  browser,
  api,
  baseURL,
  workerServer,
}) => {
  const docName = `empty-bullet-link-${randomUUID()}`;
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(docName, MINIMAL_SOURCE);
  const firstContext = await browser.newContext({ baseURL });
  const secondContext = await browser.newContext({ baseURL });
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();

  const errors = [first, second].map((page) => {
    const entries: LogEntry[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        entries.push({ type: 'error', text: message.text(), url: message.location().url });
      }
    });
    page.on('pageerror', (error) => {
      entries.push({ type: 'uncaught', text: error.message, url: page.url() });
    });
    return entries;
  });

  try {
    await Promise.all([first.goto(`/#/${docName}`), second.goto(`/#/${docName}`)]);
    await Promise.all([waitForActiveProviderSynced(first), waitForActiveProviderSynced(second)]);
    await expect(first.locator(`${EDITOR} li`)).toHaveCount(4);
    await expect(second.locator(`${EDITOR} li`)).toHaveCount(4);
    const before = await readFallbackCounters(workerServer.baseURL);

    await first.locator(`${EDITOR} li p`).first().click();
    await waitForPmSelectionInNode(first, 'listItem');
    await first.keyboard.press('Backspace');

    await expect(first.locator(`${EDITOR} li`)).toHaveCount(3);
    await expect(second.locator(`${EDITOR} li`)).toHaveCount(3);
    await expect(second.locator(`${EDITOR} li`).first()).toHaveText('a');
    const readSource = () =>
      first.evaluate(() => window.__activeProvider?.document.getText('source').toString() ?? '');
    await expect.poll(readSource).not.toMatch(/\n[ \t]*-[ \t]*\n/);
    const source = await readSource();
    expect(source).toMatch(/\[a\]\(<?b>?\)/);
    expect(source).toContain('\n\nWrapped\n   continuation line\n\n01. a\n02. b\n');
    await expect
      .poll(() => readFileSync(join(workerServer.contentDir, `${docName}.md`), 'utf8'))
      .toBe(source);

    const after = await readFallbackCounters(workerServer.baseURL);
    expect(
      after.observerAResidualMergeSpliceLanded - before.observerAResidualMergeSpliceLanded,
    ).toBe(1);
    expect(
      after.observerAResidualMergeSpliceBlockedLossy -
        before.observerAResidualMergeSpliceBlockedLossy,
    ).toBe(0);
    expect(after.observerAResidualMergeSpliceUnavailable).toEqual(
      before.observerAResidualMergeSpliceUnavailable,
    );

    await first.reload();
    await waitForActiveProviderSynced(first);
    await expect(first.locator(`${EDITOR} li`)).toHaveCount(3);
    expect(
      await first.evaluate(() => window.__activeProvider?.document.getText('source').toString()),
    ).toBe(source);
    for (const [index, entries] of errors.entries()) {
      expect(filterCriticalErrors(entries), `Editor ${index + 1} errors`).toEqual([]);
    }
  } finally {
    await Promise.all([firstContext.close(), secondContext.close()]);
  }
});
