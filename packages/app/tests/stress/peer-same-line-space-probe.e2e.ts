import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { expect, test, type WorkerServer, waitForActiveProviderSynced } from './_helpers';

const EDITOR = '.ProseMirror:not(.composer-prosemirror)';
const BASELINE = 'Target block for co-editing.';
const BLOCK_COUNT = 9;
const TARGET_BLOCK_INDEX = 2;
const WORDS_PER_PEER = 8;

interface Peer {
  context: BrowserContext;
  page: Page;
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

function seedMarkdown(): string {
  const blocks = Array.from({ length: BLOCK_COUNT }, (_, i) =>
    i === TARGET_BLOCK_INDEX ? BASELINE : `Filler block ${i} untouched.`,
  );
  return `${blocks.join('\n\n')}\n`;
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

function wordsFor(letter: string): string {
  return Array.from({ length: WORDS_PER_PEER }, () => letter).join(' ');
}

function spacesOnly(count: number): string {
  return ' '.repeat(count);
}

test.describe('MP-14 probe — interior spaces during same-paragraph co-editing', () => {
  test('neither peer loses an interior space typed at the paragraph end', async ({
    browser,
    api,
    baseURL,
    workerServer,
  }) => {
    const docName = `test-peer-space-probe-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await api.testReset(docName);
    await api.replaceDoc(docName, seedMarkdown());

    const peers = [
      await openPeer(browser, baseURL, docName),
      await openPeer(browser, baseURL, docName),
    ];

    const seedSpaces = countOf(seedMarkdown(), ' ');
    const interiorPerPeer = WORDS_PER_PEER - 1;

    try {
      await Promise.all([
        peers[0].page.keyboard.type(wordsFor('A'), { delay: 25 }),
        peers[1].page.keyboard.type(wordsFor('B'), { delay: 25 }),
      ]);

      await expect
        .poll(
          async () => {
            const texts = await Promise.all(peers.map((p) => readYText(p.page)));
            const disk = readDisk(workerServer, docName);
            return {
              aLetters: texts.map((t) => countOf(t, 'A')),
              bLetters: texts.map((t) => countOf(t, 'B')),
              spaces: texts.map((t) => countOf(t, ' ')),
              converged: texts.every((t) => t === texts[0]),
              diskMatches: disk.trim() === texts[0].trim(),
            };
          },
          { timeout: 20_000 },
        )
        .toEqual({
          aLetters: peers.map(() => WORDS_PER_PEER),
          bLetters: peers.map(() => WORDS_PER_PEER),
          spaces: peers.map(() => seedSpaces + interiorPerPeer * 2),
          converged: true,
          diskMatches: true,
        });
    } finally {
      await Promise.all(peers.map((p) => p.context.close()));
    }
  });

  test('simultaneous runs of spaces at the paragraph end all survive', async ({
    browser,
    api,
    baseURL,
    workerServer,
  }) => {
    const docName = `test-peer-space-runs-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await api.testReset(docName);
    await api.replaceDoc(docName, seedMarkdown());

    const peers = [
      await openPeer(browser, baseURL, docName),
      await openPeer(browser, baseURL, docName),
    ];

    const seedSpaces = countOf(seedMarkdown(), ' ');
    const RUN = 4;

    try {
      await Promise.all([
        peers[0].page.keyboard.type(`${spacesOnly(RUN)}A`, { delay: 25 }),
        peers[1].page.keyboard.type(`${spacesOnly(RUN)}B`, { delay: 25 }),
      ]);

      await expect
        .poll(
          async () => {
            const texts = await Promise.all(peers.map((p) => readYText(p.page)));
            const disk = readDisk(workerServer, docName);
            return {
              markers: texts.map((t) => countOf(t, 'A') + countOf(t, 'B')),
              spaces: texts.map((t) => countOf(t, ' ')),
              converged: texts.every((t) => t === texts[0]),
              diskMatches: disk.trim() === texts[0].trim(),
            };
          },
          { timeout: 20_000 },
        )
        .toEqual({
          markers: peers.map(() => 2),
          spaces: peers.map(() => seedSpaces + RUN * 2),
          converged: true,
          diskMatches: true,
        });
    } finally {
      await Promise.all(peers.map((p) => p.context.close()));
    }
  });

  test('unanchored trailing spaces are dropped on caret move — MP-15 seen from the peer side', async ({
    browser,
    api,
    baseURL,
    workerServer,
  }) => {
    const docName = `test-peer-space-trailing-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await api.testReset(docName);
    await api.replaceDoc(docName, seedMarkdown());

    const peers = [
      await openPeer(browser, baseURL, docName),
      await openPeer(browser, baseURL, docName),
    ];

    const seedSpaces = countOf(seedMarkdown(), ' ');

    try {
      await Promise.all([
        peers[0].page.keyboard.type(spacesOnly(3), { delay: 25 }),
        peers[1].page.keyboard.type(spacesOnly(3), { delay: 25 }),
      ]);
      await Promise.all(peers.map((p) => p.page.keyboard.press('ArrowUp')));

      await expect
        .poll(
          async () => {
            const texts = await Promise.all(peers.map((p) => readYText(p.page)));
            const disk = readDisk(workerServer, docName);
            return {
              spaces: texts.map((t) => countOf(t, ' ')),
              converged: texts.every((t) => t === texts[0]),
              diskMatches: disk.trim() === texts[0].trim(),
            };
          },
          { timeout: 20_000 },
        )
        .toEqual({
          spaces: peers.map(() => seedSpaces),
          converged: true,
          diskMatches: true,
        });
    } finally {
      await Promise.all(peers.map((p) => p.context.close()));
    }
  });
});
