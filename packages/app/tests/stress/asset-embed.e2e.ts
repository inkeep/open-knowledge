import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  createPngBuffer,
  expect,
  test,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

async function dropFileIntoEditor(
  page: Page,
  buffer: number[],
  filename: string,
  mime: string,
): Promise<void> {
  await page.evaluate(
    ({ bytes, name, type }) => {
      const active = (window as unknown as { __activeEditor?: { view?: { dom?: HTMLElement } } })
        .__activeEditor;
      const editor = active?.view?.dom ?? null;
      if (!editor) throw new Error('no active editor (window.__activeEditor.view.dom)');
      const file = new File([new Uint8Array(bytes)], name, { type });
      const dt = new DataTransfer();
      dt.items.add(file);
      const rect = editor.getBoundingClientRect();
      const cx = rect.left + Math.floor(rect.width / 2);
      const cy = rect.top + Math.floor(rect.height / 2);
      editor.dispatchEvent(
        new DragEvent('dragover', {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
          clientX: cx,
          clientY: cy,
        }),
      );
      editor.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
          clientX: cx,
          clientY: cy,
        }),
      );
    },
    { bytes: buffer, name: filename, type: mime },
  );
}

async function getSourceText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const provider = window.__activeProvider;
    return provider?.document?.getText('source')?.toString() ?? '';
  });
}

const FAKE_PDF_HEADER = '%PDF-1.4\n%fake pdf bytes for e2e test\n';
const TINY_PNG = Array.from(createPngBuffer('asset-embed'));

test.describe('asset-embed — drop UX (SPEC §6 FR-1, FR-1a, FR-2, FR-8)', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `asset-embed-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await api.replaceDoc(docName, '# Test\n');
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
    await page.click('.ProseMirror');
  });

  test('P1.1: drop a PDF → server stores + Y.Text contains ![[draft.pdf]]', async ({ page }) => {
    const pdfBytes = Array.from(Buffer.from(FAKE_PDF_HEADER, 'utf-8'));
    await dropFileIntoEditor(page, pdfBytes, 'draft.pdf', 'application/pdf');

    await expect
      .poll(async () => await getSourceText(page), { timeout: 5_000 })
      .toContain('![[draft.pdf]]');
  });

  test('P1.2: drop a CSV (FILE_ATTACHMENT_EXTENSIONS) → emits as ![[data.csv]] wikilink', async ({
    page,
  }) => {
    const csvBytes = Array.from(Buffer.from('a,b,c\n1,2,3\n', 'utf-8'));
    await dropFileIntoEditor(page, csvBytes, 'data.csv', 'text/csv');

    await expect
      .poll(async () => await getSourceText(page), { timeout: 5_000 })
      .toContain('![[data.csv]]');
  });

  test('P3.1: same PNG dropped twice → second drop dedups, single file on disk', async ({
    page,
  }) => {
    await dropFileIntoEditor(page, TINY_PNG, 'shot.png', 'image/png');
    await expect
      .poll(async () => await getSourceText(page), { timeout: 5_000 })
      .toMatch(/<img\s+src="\/?shot\.png"/);

    await dropFileIntoEditor(page, TINY_PNG, 'shot.png', 'image/png');

    await expect
      .poll(
        async () => {
          const text = await getSourceText(page);
          return (text.match(/<img\s+[^>]*src="\/?shot\.png"/g) ?? []).length;
        },
        { timeout: 5_000 },
      )
      .toBeGreaterThanOrEqual(2);
    const text = await getSourceText(page);
    expect(text).not.toContain('shot-1.png');
  });

  test('P1.1-paste: paste a PNG via ClipboardEvent → Y.Text contains <img src=".../shot.png">', async ({
    page,
  }) => {
    await page.evaluate(
      ({ bytes, name, type }) => {
        const active = (window as unknown as { __activeEditor?: { view?: { dom?: HTMLElement } } })
          .__activeEditor;
        const editor = active?.view?.dom ?? null;
        if (!editor) throw new Error('no active editor (window.__activeEditor.view.dom)');
        const file = new File([new Uint8Array(bytes)], name, { type });
        const dt = new DataTransfer();
        dt.items.add(file);
        editor.dispatchEvent(
          new ClipboardEvent('paste', {
            clipboardData: dt,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      { bytes: TINY_PNG, name: 'shot.png', type: 'image/png' },
    );

    await expect
      .poll(async () => await getSourceText(page), { timeout: 5_000 })
      .toMatch(/<img\s+src="\/?shot\.png"/);
  });

  test('SVG drop emits as <img> JSX (image extension; NFR-3 sniff-fallback path)', async ({
    page,
  }) => {
    const svgBytes = Array.from(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', 'utf-8'),
    );
    await dropFileIntoEditor(page, svgBytes, 'diagram.svg', 'image/svg+xml');
    await expect
      .poll(async () => await getSourceText(page), { timeout: 5_000 })
      .toMatch(/<img\s+src="\/?diagram\.svg"/);
  });
});
