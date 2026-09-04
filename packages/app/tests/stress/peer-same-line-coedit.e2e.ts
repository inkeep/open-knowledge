import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { expect, test, type WorkerServer, waitForActiveProviderSynced } from './_helpers';

const EDITOR = '.ProseMirror:not(.composer-prosemirror)';
const BASELINE = 'Target block for co-editing.';
const BLOCK_COUNT = 9;
const TARGET_BLOCK_INDEX = 2;
const TYPED_PER_PEER = 10;
const BURST_LENGTH = 40;

interface Peer {
  context: BrowserContext;
  page: Page;
}

interface SeedApi {
  createPage(path: string): Promise<void>;
  testReset(docName?: string): Promise<void>;
  replaceDoc(docName: string, markdown: string): Promise<void>;
}

function readYText(page: Page): Promise<string> {
  return page.evaluate(
    () => window.__activeProvider?.document?.getText('source')?.toString() ?? '',
  );
}

function readDisk(workerServer: WorkerServer, docName: string): string {
  try {
    return readFileSync(join(workerServer.contentDir, `${docName}.md`), 'utf-8');
  } catch {
    return '';
  }
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function openPeer(browser: Browser, baseURL: string, docName: string): Promise<Peer> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await page.waitForSelector(EDITOR);
  await page.waitForFunction(
    (baseline: string) =>
      window.__activeProvider?.document?.getText('source')?.toString()?.includes(baseline) ?? false,
    BASELINE,
    { timeout: 15_000 },
  );
  await page.locator(EDITOR).getByText(BASELINE, { exact: false }).first().click();
  await page.keyboard.press('End');
  await page.waitForFunction(
    (baseline: string) => {
      const editor = window.__activeEditor;
      if (!editor) return false;
      const { $from, empty } = editor.state.selection;
      return empty && $from.parent.textContent.includes(baseline);
    },
    BASELINE,
    { timeout: 10_000 },
  );
  return { context, page };
}

function seedMarkdown(): string {
  const blocks = Array.from({ length: BLOCK_COUNT }, (_, i) =>
    i === TARGET_BLOCK_INDEX ? BASELINE : `Filler block ${i} untouched.`,
  );
  return `${blocks.join('\n\n')}\n`;
}

async function seedDoc(api: SeedApi, docName: string): Promise<void> {
  await api.createPage(`${docName}.md`);
  await api.testReset(docName);
  await api.replaceDoc(docName, seedMarkdown());
}

async function openTwoPeers(browser: Browser, baseURL: string, docName: string): Promise<Peer[]> {
  return [await openPeer(browser, baseURL, docName), await openPeer(browser, baseURL, docName)];
}

async function assertBothEditsSurvive(
  peers: Peer[],
  workerServer: WorkerServer,
  docName: string,
  typedPerPeer: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const texts = await Promise.all(peers.map((p) => readYText(p.page)));
        const disk = readDisk(workerServer, docName);
        return {
          aCount: texts.map((t) => countOf(t, 'A')),
          bCount: texts.map((t) => countOf(t, 'B')),
          baselineCopies: texts.map((t) => countOf(t, BASELINE)),
          fillersIntact: texts.map((t) => countOf(t, 'untouched.')),
          clientsConverged: texts.every((t) => t === texts[0]),
          diskMatchesClients: disk.trim() === texts[0].trim(),
        };
      },
      { timeout: 20_000 },
    )
    .toEqual({
      aCount: peers.map(() => typedPerPeer),
      bCount: peers.map(() => typedPerPeer),
      baselineCopies: peers.map(() => 1),
      fillersIntact: peers.map(() => BLOCK_COUNT - 1),
      clientsConverged: true,
      diskMatchesClients: true,
    });
}

test.describe('two peer WYSIWYG clients editing the same line', () => {
  test('simultaneous typing at the same caret keeps both contributions', async ({
    browser,
    api,
    baseURL,
    workerServer,
  }) => {
    const docName = `test-peer-sameline-live-${randomUUID().slice(0, 8)}`;
    await seedDoc(api, docName);
    const peers = await openTwoPeers(browser, baseURL, docName);

    try {
      await Promise.all([
        peers[0].page.keyboard.type('A'.repeat(TYPED_PER_PEER), { delay: 25 }),
        peers[1].page.keyboard.type('B'.repeat(TYPED_PER_PEER), { delay: 25 }),
      ]);

      await assertBothEditsSurvive(peers, workerServer, docName, TYPED_PER_PEER);
    } finally {
      await Promise.all(peers.map((p) => p.context.close()));
    }
  });

  test('typing on both sides of a divergence window keeps both contributions', async ({
    browser,
    api,
    baseURL,
    workerServer,
  }) => {
    const docName = `test-peer-sameline-split-${randomUUID().slice(0, 8)}`;
    await seedDoc(api, docName);
    const peers = await openTwoPeers(browser, baseURL, docName);

    try {
      await peers[1].page.evaluate(() => window.__activeProvider?.disconnect());
      await peers[1].page.waitForFunction(() => window.__activeProvider?.isSynced === false, null, {
        timeout: 10_000,
      });

      await peers[0].page.keyboard.type('A'.repeat(TYPED_PER_PEER), { delay: 25 });
      await peers[1].page.keyboard.type('B'.repeat(TYPED_PER_PEER), { delay: 25 });

      await expect
        .poll(async () => countOf(await readYText(peers[1].page), 'A'), { timeout: 3_000 })
        .toBe(0);

      await peers[1].page.evaluate(() => window.__activeProvider?.connect());
      await waitForActiveProviderSynced(peers[1].page);

      await assertBothEditsSurvive(peers, workerServer, docName, TYPED_PER_PEER);
    } finally {
      await Promise.all(peers.map((p) => p.context.close()));
    }
  });

  test('sustained simultaneous typing on one line drops no keystrokes', async ({
    browser,
    api,
    baseURL,
    workerServer,
  }) => {
    const docName = `test-peer-sameline-burst-${randomUUID().slice(0, 8)}`;
    await seedDoc(api, docName);
    const peers = await openTwoPeers(browser, baseURL, docName);

    try {
      await Promise.all([
        peers[0].page.keyboard.type('A'.repeat(BURST_LENGTH), { delay: 0 }),
        peers[1].page.keyboard.type('B'.repeat(BURST_LENGTH), { delay: 0 }),
      ]);

      await assertBothEditsSurvive(peers, workerServer, docName, BURST_LENGTH);
    } finally {
      await Promise.all(peers.map((p) => p.context.close()));
    }
  });
});
