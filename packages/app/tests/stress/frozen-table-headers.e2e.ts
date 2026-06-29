
import { expect, test, waitForActiveProviderSynced } from './_helpers';

const LONG_TABLE_MARKDOWN = `# Metric Tracker

| Metric | Count | Revenue | Growth |
|--------|-------|---------|--------|
| Alpha | 100 | 1250 | 42.0% |
| Beta | 107 | 1293 | 44.0% |
| Gamma | 114 | 1336 | 46.0% |
| Delta | 121 | 1379 | 48.0% |
| Epsilon | 128 | 1422 | 50.0% |
| Zeta | 135 | 1465 | 52.0% |
| Eta | 142 | 1508 | 54.0% |
| Theta | 149 | 1551 | 56.0% |
| Iota | 156 | 1594 | 58.0% |
| Kappa | 163 | 1637 | 60.0% |
| Lambda | 170 | 1680 | 62.0% |
| Mu | 177 | 1723 | 64.0% |
| Nu | 184 | 1766 | 66.0% |
| Xi | 191 | 1809 | 68.0% |
| Omicron | 198 | 1852 | 70.0% |
| Pi | 205 | 1895 | 72.0% |
| Rho | 212 | 1938 | 74.0% |
| Sigma | 219 | 1981 | 76.0% |
| Tau | 226 | 2024 | 78.0% |
| Upsilon | 233 | 2067 | 80.0% |
| Phi | 240 | 2110 | 82.0% |
| Chi | 247 | 2153 | 84.0% |
| Psi | 254 | 2196 | 86.0% |
| Omega | 261 | 2239 | 88.0% |
| Alpha-2 | 268 | 2282 | 90.0% |

## Notes

${Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} of trailing prose so the table can scroll fully out of view.`).join('\n\n')}
`;

const WIDE_TABLE_MARKDOWN = `# Monthly KPIs

| Metric | January | February | March | April | May | Total |
|--------|---------|----------|-------|-------|-----|-------|
| Alpha | 100 | 105 | 110 | 115 | 120 | 550 |
| Beta | 112 | 117 | 122 | 127 | 132 | 610 |
| Gamma | 124 | 129 | 134 | 139 | 144 | 670 |
| Delta | 136 | 141 | 146 | 151 | 156 | 730 |
| Epsilon | 148 | 153 | 158 | 163 | 168 | 790 |
| Zeta | 160 | 165 | 170 | 175 | 180 | 850 |
| Eta | 172 | 177 | 182 | 187 | 192 | 910 |
| Theta | 184 | 189 | 194 | 199 | 204 | 970 |
`;

const VIRTUALIZED_TABLE_MARKDOWN = `# Long Report

${Array.from({ length: 40 }, (_, i) => `Intro paragraph ${i + 1} above the table.`).join('\n\n')}

## Data

| Metric | One | Two | Three | Four | Five |
|--------|-----|-----|-------|------|------|
${Array.from({ length: 200 }, (_, i) => `| Row-${i + 1} | ${i} | ${i * 2} | ${i * 3} | ${i * 4} | ${i * 5} |`).join('\n')}

## Appendix

${Array.from({ length: 40 }, (_, i) => `Closing paragraph ${i + 1} below the table.`).join('\n\n')}
`;

const PROSE_ABOVE_MARKDOWN = `# Spec Doc

## Background

${Array.from({ length: 28 }, (_, i) => `Background paragraph ${i + 1} with enough words to take a realistic amount of vertical space in the document flow.`).join('\n\n')}

## Risk Table

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|------------|--------|------------|
${Array.from({ length: 12 }, (_, i) => `| R${i + 1} | Agent markdown write path ${i + 1} has higher latency than direct construction in the editor | LOW | LOW | Agent writes are at section level, parse and update adds only a few milliseconds which is negligible at realistic intervals ${i + 1} |`).join('\n')}

## Appendix

${Array.from({ length: 28 }, (_, i) => `Appendix paragraph ${i + 1} below the table so the document keeps scrolling.`).join('\n\n')}
`;

const SCROLL_SELECTOR = '[data-testid="editor-scroll-container"]';
const TOOLBAR_HEIGHT = 56;

/** Decode a screenshot in-browser and verify the band just above the pinned
 *  header is visually flat (no text glyphs). Pixel-level evidence — computed
 *  style cannot see a compositor-side desync, a screenshot can. */
async function scanSlotPixels(page: Parameters<typeof test>[1]['page']): Promise<number> {
  const band = await page.evaluate(() => {
    const table = document.querySelector('.ProseMirror .tableWrapper > table') as HTMLElement;
    const cell = (table.querySelector('tbody tr') as HTMLTableRowElement).cells[0];
    const r = table.getBoundingClientRect();
    return {
      headerTop: cell.getBoundingClientRect().top,
      left: r.left + 4,
      width: Math.min(r.width - 8, 800),
      viewportWidth: window.innerWidth,
    };
  });
  const png = (await page.screenshot()).toString('base64');
  return page.evaluate(
    async ({ png, band }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const scale = img.naturalWidth / band.viewportWidth;
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d') as CanvasRenderingContext2D;
      ctx.drawImage(img, 0, 0);
      let maxStd = 0;
      for (let y = band.headerTop - 12; y <= band.headerTop - 2; y++) {
        const d = ctx.getImageData(
          Math.round(band.left * scale),
          Math.round(y * scale),
          Math.round(band.width * scale),
          1,
        ).data;
        const lums: number[] = [];
        for (let i = 0; i < d.length; i += 4) lums.push(d[i] + d[i + 1] + d[i + 2]);
        const mean = lums.reduce((a, b) => a + b, 0) / lums.length;
        const std = Math.sqrt(lums.reduce((a, b) => a + (b - mean) ** 2, 0) / lums.length);
        maxStd = Math.max(maxStd, std);
      }
      return maxStd;
    },
    { png, band },
  );
}

test.setTimeout(60_000);

const twoFrames = (page: Parameters<typeof test>[1]['page']) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );

async function waitForQuiescence(
  page: Parameters<typeof test>[1]['page'],
  selector: string,
): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __okPrevH?: number; __okStable?: number };
    w.__okPrevH = undefined;
    w.__okStable = 0;
  });
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return false;
      const w = window as unknown as { __okPrevH?: number; __okStable?: number };
      const h = el.scrollHeight;
      if (w.__okPrevH === h) {
        w.__okStable = (w.__okStable ?? 0) + 1;
      } else {
        w.__okStable = 0;
        w.__okPrevH = h;
      }
      return (w.__okStable ?? 0) >= 4;
    },
    selector,
    { timeout: 20_000, polling: 120 },
  );
}

/** Drive a real vertical scroll and let the extension respond. Returns the
 *  computed shift (animations change computed style, not the style attribute),
 *  the header's pin error vs. the expected toolbar boundary, and — for the
 *  scroll-driven path — the shift error read SYNCHRONOUSLY after setting
 *  scrollTop, before any rAF. A scroll-listener implementation cannot pass
 *  that read (it trails the scroll by a frame — the visible "shake");
 *  a ScrollTimeline animation is already correct at style-resolution time. */
async function scrollAndReadFreeze(
  page: Parameters<typeof test>[1]['page'],
  top: number,
): Promise<{
  frozen: boolean;
  shiftPx: number;
  pinErrorPx: number;
  syncShiftErrorPx: number | null;
}> {
  const settled = await page.evaluate(
    ({ sel, top, toolbarHeight }) =>
      new Promise<{ shiftPx: number; pinErrorPx: number }>((resolve) => {
        const scrollEl = document.querySelector(sel) as HTMLElement | null;
        scrollEl?.scrollTo({ top, behavior: 'instant' as ScrollBehavior });
        const started = performance.now();
        const tick = (): void => {
          const firstRow = document
            .querySelector('.ProseMirror .tableWrapper > table > tbody')
            ?.querySelector('tr') as HTMLTableRowElement | null;
          const cell = firstRow?.cells[0];
          if (!scrollEl || !cell) {
            resolve({ shiftPx: Number.NaN, pinErrorPx: Number.NaN });
            return;
          }
          const t = getComputedStyle(cell).transform;
          const shiftPx = t === 'none' ? 0 : new DOMMatrixReadOnly(t).m42;
          const expectedTop = scrollEl.getBoundingClientRect().top + toolbarHeight;
          const pinErrorPx = Math.abs(cell.getBoundingClientRect().top - expectedTop);
          if (pinErrorPx < 2 || performance.now() - started > 5_000) {
            resolve({ shiftPx, pinErrorPx });
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { sel: SCROLL_SELECTOR, top, toolbarHeight: TOOLBAR_HEIGHT },
  );

  let syncShiftErrorPx = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 3 && !(syncShiftErrorPx < 1.5); attempt++) {
    syncShiftErrorPx = await page.evaluate(
      ({ sel, step }) =>
        new Promise<number>((resolve) => {
          const scrollEl = document.querySelector(sel) as HTMLElement | null;
          const cell = (
            document.querySelector(
              '.ProseMirror .tableWrapper > table > tbody tr',
            ) as HTMLTableRowElement | null
          )?.cells[0];
          if (!scrollEl || !cell) {
            resolve(Number.NaN);
            return;
          }
          const read = (): number => {
            const t = getComputedStyle(cell).transform;
            return t === 'none' ? 0 : new DOMMatrixReadOnly(t).m42;
          };
          const beforeShift = read();
          const beforeTop = scrollEl.scrollTop;
          scrollEl.scrollTo({ top: beforeTop + step, behavior: 'instant' as ScrollBehavior });
          requestAnimationFrame(() => {
            const scrolled = scrollEl.scrollTop - beforeTop;
            resolve(Math.abs(read() - beforeShift - scrolled));
          });
        }),
      { sel: SCROLL_SELECTOR, step: 40 },
    );
  }

  const final = await page.evaluate(
    ({ sel, toolbarHeight }) =>
      new Promise<{ shiftPx: number; pinErrorPx: number }>((resolve) => {
        const scrollEl = document.querySelector(sel) as HTMLElement | null;
        const started = performance.now();
        const tick = (): void => {
          const firstRow = document
            .querySelector('.ProseMirror .tableWrapper > table > tbody')
            ?.querySelector('tr') as HTMLTableRowElement | null;
          const cell = firstRow?.cells[0];
          if (!scrollEl || !cell) {
            resolve({ shiftPx: Number.NaN, pinErrorPx: Number.NaN });
            return;
          }
          const t = getComputedStyle(cell).transform;
          const shiftPx = t === 'none' ? 0 : new DOMMatrixReadOnly(t).m42;
          const expectedTop = scrollEl.getBoundingClientRect().top + toolbarHeight;
          const pinErrorPx = Math.abs(cell.getBoundingClientRect().top - expectedTop);
          if (pinErrorPx < 2 || performance.now() - started > 5_000) {
            resolve({ shiftPx, pinErrorPx });
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { sel: SCROLL_SELECTOR, toolbarHeight: TOOLBAR_HEIGHT },
  );

  return {
    frozen: final.shiftPx > 0.5,
    shiftPx: final.shiftPx,
    pinErrorPx: Math.max(settled.pinErrorPx, final.pinErrorPx),
    syncShiftErrorPx,
  };
}

test('no freeze before the table reaches the toolbar', async ({
  page,
  api,
  workerServer,
}, testInfo) => {
  await api.seedDocs([{ name: 'frozen-hdr-long-1', markdown: LONG_TABLE_MARKDOWN }]);
  await page.goto(`${workerServer.baseURL}/#/frozen-hdr-long-1`);
  await waitForActiveProviderSynced(page);
  await page.locator('table').first().waitFor({ state: 'visible' });
  await waitForQuiescence(page, SCROLL_SELECTOR);
  await twoFrames(page);
  const shiftPx = await page.evaluate(() => {
    const cell = document.querySelector('.ProseMirror .tableWrapper > table > tbody tr > th');
    if (!cell) return Number.NaN;
    const t = getComputedStyle(cell).transform;
    return t === 'none' ? 0 : new DOMMatrixReadOnly(t).m42;
  });
  expect(shiftPx).toBe(0);
  const occluderOpacity = await page.evaluate(() => {
    const cell = document.querySelector('.ProseMirror .tableWrapper > table > tbody tr > th');
    return cell ? getComputedStyle(cell, '::before').opacity : '';
  });
  expect(occluderOpacity).toBe('0');
  await page.screenshot({ path: testInfo.outputPath('unscrolled.png') });
});

test('header row pins below the toolbar on mid-table scroll', async ({
  page,
  api,
  workerServer,
}, testInfo) => {
  await api.seedDocs([{ name: 'frozen-hdr-long-2', markdown: LONG_TABLE_MARKDOWN }]);
  await page.goto(`${workerServer.baseURL}/#/frozen-hdr-long-2`);
  await waitForActiveProviderSynced(page);
  await page.locator('table').first().waitFor({ state: 'visible' });
  await waitForQuiescence(page, SCROLL_SELECTOR);
  const state = await scrollAndReadFreeze(page, 260);
  expect(state.frozen).toBe(true);
  expect(state.pinErrorPx).toBeLessThan(2);
  if (state.syncShiftErrorPx !== null) expect(state.syncShiftErrorPx).toBeLessThan(1.5);
  const occluder = await page.evaluate(() => {
    const cell = (
      document.querySelector('.ProseMirror .tableWrapper > table > tbody tr') as HTMLTableRowElement
    ).cells[0];
    const s = getComputedStyle(cell, '::before');
    return { opacity: s.opacity, height: Number.parseFloat(s.height) };
  });
  expect(occluder.opacity).toBe('1');
  expect(occluder.height).toBeGreaterThanOrEqual(56);
  expect(await scanSlotPixels(page)).toBeLessThan(10);
  await page.screenshot({ path: testInfo.outputPath('frozen-mid.png') });
});

test('header row stays pinned on deep scroll and releases past the table', async ({
  page,
  api,
  workerServer,
}, testInfo) => {
  await api.seedDocs([{ name: 'frozen-hdr-long-3', markdown: LONG_TABLE_MARKDOWN }]);
  await page.goto(`${workerServer.baseURL}/#/frozen-hdr-long-3`);
  await waitForActiveProviderSynced(page);
  await page.locator('table').first().waitFor({ state: 'visible' });
  await waitForQuiescence(page, SCROLL_SELECTOR);
  const state = await scrollAndReadFreeze(page, 620);
  expect(state.frozen).toBe(true);
  expect(state.pinErrorPx).toBeLessThan(2);
  if (state.syncShiftErrorPx !== null) expect(state.syncShiftErrorPx).toBeLessThan(1.5);
  await page.screenshot({ path: testInfo.outputPath('frozen-deep.png') });

  await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    el?.scrollTo({ top: 5_000, behavior: 'instant' as ScrollBehavior });
  }, SCROLL_SELECTOR);
  await page.waitForFunction(
    () => {
      const table = document.querySelector('.ProseMirror .tableWrapper > table');
      const firstRow = table?.querySelector('tbody tr') as HTMLTableRowElement | null;
      const cell = firstRow?.cells[0];
      if (!table || !firstRow || !cell) return false;
      const maxShift =
        table.getBoundingClientRect().height - firstRow.getBoundingClientRect().height;
      const t = getComputedStyle(cell).transform;
      const shift = t === 'none' ? 0 : new DOMMatrixReadOnly(t).m42;
      return Math.abs(shift - Math.max(0, maxShift)) < 2;
    },
    undefined,
    { timeout: 5_000, polling: 'raf' },
  );
});

test('first column stays pinned during horizontal scroll after column resize', async ({
  page,
  api,
  workerServer,
}, testInfo) => {
  await api.seedDocs([{ name: 'frozen-hdr-wide', markdown: WIDE_TABLE_MARKDOWN }]);
  await page.goto(`${workerServer.baseURL}/#/frozen-hdr-wide`);
  await waitForActiveProviderSynced(page);
  await page.locator('table').first().waitFor({ state: 'visible' });
  await waitForQuiescence(page, SCROLL_SELECTOR);

  for (const colIndex of [5, 4, 3, 2, 1, 0]) {
    const border = await page.evaluate((idx) => {
      const row = document
        .querySelector('.ProseMirror .tableWrapper > table > tbody')
        ?.querySelector('tr') as HTMLTableRowElement | null;
      const cell = row?.cells[idx];
      if (!cell) return null;
      const r = cell.getBoundingClientRect();
      return { x: r.right - 1, y: r.top + r.height / 2 };
    }, colIndex);
    if (!border) throw new Error(`no header cell at index ${colIndex}`);
    await page.mouse.move(border.x, border.y);
    await page.mouse.move(border.x, border.y); // second move ensures handle decoration
    await page.locator('.column-resize-handle').first().waitFor({ state: 'attached' });
    await page.mouse.down();
    await page.mouse.move(border.x + 70, border.y, { steps: 6 });
    await page.mouse.up();
    await twoFrames(page);
  }
  const cellCenter = await page.evaluate(() => {
    const row = document
      .querySelector('.ProseMirror .tableWrapper > table > tbody')
      ?.querySelectorAll('tr')[2] as HTMLTableRowElement | undefined;
    const r = row?.cells[1]?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  });
  if (cellCenter) await page.mouse.move(cellCenter.x, cellCenter.y);
  await waitForQuiescence(page, SCROLL_SELECTOR);

  const sticky = await page.evaluate(() => {
    const wrapper = document.querySelector('.tableWrapper') as HTMLElement | null;
    if (!wrapper) return null;
    const row = wrapper.querySelector('table > tbody > tr:nth-child(2)') as HTMLTableRowElement;
    const beforeFirst = row.cells[0].getBoundingClientRect().left;
    const beforeSecond = row.cells[1].getBoundingClientRect().left;
    const overflow = wrapper.scrollWidth - wrapper.clientWidth;
    wrapper.scrollLeft = Math.min(260, overflow);
    return {
      overflow,
      scrollLeft: wrapper.scrollLeft,
      stickyDriftPx: Math.abs(row.cells[0].getBoundingClientRect().left - beforeFirst),
      neighborShiftPx: beforeSecond - row.cells[1].getBoundingClientRect().left,
    };
  });
  expect(sticky).not.toBeNull();
  expect(sticky?.overflow ?? 0).toBeGreaterThan(100);
  expect(sticky?.scrollLeft ?? 0).toBeGreaterThan(100);
  expect(sticky?.stickyDriftPx ?? 99).toBeLessThan(2);
  expect(sticky?.neighborShiftPx ?? 0).toBeGreaterThan(100);
  await twoFrames(page);
  await page.screenshot({ path: testInfo.outputPath('horizontal.png') });
});

test('virtualized long doc: both freezes hold on a 200-row table', async ({
  page,
  api,
  workerServer,
}, testInfo) => {
  await api.seedDocs([{ name: 'frozen-hdr-virtual', markdown: VIRTUALIZED_TABLE_MARKDOWN }]);
  await page.goto(`${workerServer.baseURL}/#/frozen-hdr-virtual`);
  await waitForActiveProviderSynced(page);
  await page.locator('table').first().waitFor({ state: 'attached' });
  await waitForQuiescence(page, SCROLL_SELECTOR);

  const chunkState = await page.evaluate(() => {
    const wrappers = document.querySelectorAll<HTMLElement>('.ProseMirror .ok-chunk-wrapper');
    const tableChunk = document.querySelector<HTMLElement>(
      '.ProseMirror .tableWrapper.ok-chunk-wrapper',
    );
    const deepRow = document.querySelectorAll<HTMLElement>(
      '.ProseMirror .tableWrapper > table > tbody > tr',
    )[150];
    return {
      total: wrappers.length,
      tableIsChunk: tableChunk != null,
      tableCv: tableChunk ? getComputedStyle(tableChunk).contentVisibility : 'n/a',
      deepRowSkipped: deepRow ? !deepRow.checkVisibility({ contentVisibilityAuto: true }) : null,
    };
  });
  console.log(`[virtualized] ${JSON.stringify(chunkState)}`);
  expect(chunkState.total).toBeGreaterThan(50);
  expect(chunkState.tableIsChunk).toBe(true);
  expect(chunkState.tableCv).toBe('auto');

  const tableDocTop = await page.evaluate((sel) => {
    const scrollEl = document.querySelector(sel) as HTMLElement;
    const table = document.querySelector('.ProseMirror .tableWrapper > table') as HTMLElement;
    const top =
      scrollEl.scrollTop + table.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;
    scrollEl.scrollTo({ top: top - 160, behavior: 'instant' as ScrollBehavior });
    return top;
  }, SCROLL_SELECTOR);
  await twoFrames(page);
  await twoFrames(page);
  for (const colIndex of [4, 3, 2, 1, 0]) {
    const border = await page.evaluate((idx) => {
      const row = document
        .querySelector('.ProseMirror .tableWrapper > table > tbody')
        ?.querySelector('tr') as HTMLTableRowElement | null;
      const cell = row?.cells[idx];
      if (!cell) return null;
      const r = cell.getBoundingClientRect();
      return { x: r.right - 1, y: r.top + r.height / 2 };
    }, colIndex);
    if (!border) throw new Error(`no header cell at index ${colIndex}`);
    await page.mouse.move(border.x, border.y);
    await page.mouse.move(border.x, border.y);
    await page.locator('.column-resize-handle').first().waitFor({ state: 'attached' });
    await page.mouse.down();
    await page.mouse.move(border.x + 80, border.y, { steps: 6 });
    await page.mouse.up();
    await twoFrames(page);
  }
  await waitForQuiescence(page, SCROLL_SELECTOR);

  const vertical = await scrollAndReadFreeze(page, tableDocTop + 2_000);
  expect(vertical.frozen).toBe(true);
  expect(vertical.pinErrorPx).toBeLessThan(2);
  if (vertical.syncShiftErrorPx !== null) expect(vertical.syncShiftErrorPx).toBeLessThan(1.5);

  const combined = await page.evaluate(() => {
    const wrapper = document.querySelector('.tableWrapper') as HTMLElement | null;
    if (!wrapper) return null;
    const row = wrapper.querySelector('table > tbody > tr:nth-child(5)') as HTMLTableRowElement;
    const headerRow = wrapper.querySelector('table > tbody > tr') as HTMLTableRowElement;
    const beforeFirst = row.cells[0].getBoundingClientRect().left;
    const beforeSecond = row.cells[1].getBoundingClientRect().left;
    const overflow = wrapper.scrollWidth - wrapper.clientWidth;
    wrapper.scrollLeft = Math.min(200, overflow);
    return {
      overflow,
      scrollLeft: wrapper.scrollLeft,
      stickyDriftPx: Math.abs(row.cells[0].getBoundingClientRect().left - beforeFirst),
      neighborShiftPx: beforeSecond - row.cells[1].getBoundingClientRect().left,
      cornerZ: getComputedStyle(headerRow.cells[0]).zIndex,
      headerZ: getComputedStyle(headerRow.cells[1]).zIndex,
    };
  });
  expect(combined).not.toBeNull();
  expect(combined?.overflow ?? 0).toBeGreaterThan(100);
  expect(combined?.stickyDriftPx ?? 99).toBeLessThan(2);
  expect(combined?.neighborShiftPx ?? 0).toBeGreaterThan(100);
  expect(combined?.cornerZ).toBe('3');
  expect(combined?.headerZ).toBe('2');
  await twoFrames(page);
  await page.screenshot({ path: testInfo.outputPath('virtualized-combined.png') });
});

test('slot above pinned header stays clean in a prose-heavy doc (pixel-verified)', async ({
  page,
  api,
  workerServer,
}, testInfo) => {
  await api.seedDocs([{ name: 'frozen-hdr-prose', markdown: PROSE_ABOVE_MARKDOWN }]);
  await page.goto(`${workerServer.baseURL}/#/frozen-hdr-prose`);
  await waitForActiveProviderSynced(page);
  await page.locator('table').first().waitFor({ state: 'attached' });
  await waitForQuiescence(page, SCROLL_SELECTOR);

  const tableDocTop = await page.evaluate((sel) => {
    const scrollEl = document.querySelector(sel) as HTMLElement;
    const table = document.querySelector('.ProseMirror .tableWrapper > table') as HTMLElement;
    return (
      scrollEl.scrollTop + table.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top
    );
  }, SCROLL_SELECTOR);

  for (const delta of [120, 320, 520]) {
    const state = await scrollAndReadFreeze(page, tableDocTop + delta);
    expect(state.frozen).toBe(true);
    expect(state.pinErrorPx).toBeLessThan(2);
    const maxStd = await scanSlotPixels(page);
    expect(maxStd, `slot band not flat at delta ${delta}`).toBeLessThan(10);
  }
  await page.screenshot({ path: testInfo.outputPath('prose-above-frozen.png') });
});
