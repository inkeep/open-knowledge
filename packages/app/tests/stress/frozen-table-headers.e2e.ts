/**
 * E2E coverage for the FrozenTableHeaders extension + first-column sticky CSS.
 *
 * These tests drive REAL user scrolling. That matters because the failure modes
 * they guard against only reproduce at the surface:
 *  - Vertical freeze regression: applying per-scroll inline styles to
 *    PM-managed header cells triggers ProseMirror's DOMObserver on every frame;
 *    under concurrent transactions that loop wedged the renderer outright (rAF
 *    starvation — the page stops responding). The extension now applies effects
 *    via zero-duration fill-forwards Web Animations, which mutate no DOM
 *    attribute. The scroll steps below hang, not fail, if that regresses.
 *  - Horizontal freeze regression: `position: sticky` cells constrain to the
 *    nearest scroll container. `.ProseMirror table { overflow: hidden }` made
 *    the table itself that container, so the sticky first column never engaged.
 *    Now `overflow: clip` (clips without creating a scrollport).
 */

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

// Long doc: prose above and below a 200-row table. Top-level blocks are
// content-visibility:auto chunks (chunk-wrapper-decoration.ts) — with this
// much content, offscreen chunks are skipped, exercising the freeze against
// the virtualization.
const VIRTUALIZED_TABLE_MARKDOWN = `# Long Report

${Array.from({ length: 40 }, (_, i) => `Intro paragraph ${i + 1} above the table.`).join('\n\n')}

## Data

| Metric | One | Two | Three | Four | Five |
|--------|-----|-----|-------|------|------|
${Array.from({ length: 200 }, (_, i) => `| Row-${i + 1} | ${i} | ${i * 2} | ${i * 3} | ${i * 4} | ${i * 5} |`).join('\n')}

## Appendix

${Array.from({ length: 40 }, (_, i) => `Closing paragraph ${i + 1} below the table.`).join('\n\n')}
`;

// The user-reported sliver doc shape: substantial prose ABOVE the table,
// multi-line (tall) table rows, prose below.
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
// Mirrors TOOLBAR_HEIGHT in frozen-table-headers.ts.
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
      // Rows from 12px above the header down to 2px above it. A clean
      // background band has near-zero luminance variance; glyphs spike it.
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

/** Wait until the doc stops mutating — scrollHeight stable across consecutive polls. */
async function waitForQuiescence(
  page: Parameters<typeof test>[1]['page'],
  selector: string,
): Promise<void> {
  // Reset poll state so back-to-back calls within one test start fresh.
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
  // Scroll, then wait IN ONE in-page task until the pin converges, returning
  // the qualifying frame's numbers atomically. Scrolling can materialize
  // content-visibility chunks (their contain-intrinsic-size estimates differ
  // from real heights), which shifts content and triggers the extension's
  // ResizeObserver / drift recompute — eventually-consistent by design, so a
  // separate poll-then-read would race the next rebuild. This loop also
  // proves the renderer is alive: if the DOMObserver loop ever comes back,
  // rAF stops firing and the evaluate times the test out.
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
          // The cell's rect includes its transform — the visual position.
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

  // Frame-sync probe: a further small scroll must be reflected in the
  // computed transform ONE frame later — no scroll-event → rAF → style-write
  // round trip. This is the "no shake" contract. The shift/scroll slope is 1
  // by construction, so the expected delta is the ACTUAL scroll delta. A
  // chunk materialization can rebuild the mapping mid-probe (intercept
  // shifts); retry a couple of times — a clean frame pair must exist.
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

  // Re-converge after the probe so callers (screenshots included) observe a
  // settled state — the probe's extra scroll can race a drift rebuild.
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
  // No freeze before scrolling. With the scroll-driven path the animation
  // holds translateY(0) (identity matrix) before its range; without it the
  // computed transform is 'none'. Either way the shift must be 0.
  const shiftPx = await page.evaluate(() => {
    const cell = document.querySelector('.ProseMirror .tableWrapper > table > tbody tr > th');
    if (!cell) return Number.NaN;
    const t = getComputedStyle(cell).transform;
    return t === 'none' ? 0 : new DOMMatrixReadOnly(t).m42;
  });
  expect(shiftPx).toBe(0);
  // Occluder hidden while not frozen — content above the table stays visible.
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
  // No scroll shake: the transform is already correct at style-resolution
  // time, before any rAF (scroll-driven path only; null = fallback path).
  if (state.syncShiftErrorPx !== null) expect(state.syncShiftErrorPx).toBeLessThan(1.5);
  // Scrolled-past rows must not show in the slot above the pinned header.
  // The occluder ::before on each header cell must be revealed and tall
  // enough to cover the slot, and — pixel-level — the band above the header
  // must be visually flat (computed style cannot see a compositor-side
  // desync; a screenshot can).
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

  // Scroll far past the table: the header must hold at maxShift (pinned to
  // the table's last row, offscreen) — never beyond the table.
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

  // A markdown table never overflows on its own (`table-layout: fixed` squeezes
  // columns to fit), so horizontal scroll + sticky first column only exists
  // after a user widens columns. Do what the user does: drag column borders
  // via prosemirror-tables' column-resize handles. Right-to-left so each
  // border's pre-drag position (computed fresh per iteration) stays in view.
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
  // Park the pointer mid-cell (away from any border) so the resize-handle
  // decoration clears before the screenshot.
  const cellCenter = await page.evaluate(() => {
    const row = document
      .querySelector('.ProseMirror .tableWrapper > table > tbody')
      ?.querySelectorAll('tr')[2] as HTMLTableRowElement | undefined;
    const r = row?.cells[1]?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  });
  if (cellCenter) await page.mouse.move(cellCenter.x, cellCenter.y);
  await waitForQuiescence(page, SCROLL_SELECTOR);

  // Now the table overflows: scroll the wrapper and verify the first column
  // stays pinned (pure CSS position: sticky) while other columns shift.
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
  // First column must not move while its neighbor shifts by the scroll amount.
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

  // The chunk virtualization mechanism must be present on the table: the
  // tableWrapper is itself an .ok-chunk-wrapper with computed
  // content-visibility: auto. Whether Chromium actually SKIPS offscreen
  // chunks is a runtime decision that does not engage in headless test runs
  // (verified empirically: a row 4000px below the fold still reports
  // checkVisibility() === true here) — the skip state is logged for
  // diagnosis, not asserted. The extension is designed for both states: no
  // per-scroll-frame geometry reads, a contentvisibilityautostatechange
  // listener per table, content-size ResizeObserver, and scroll-burst drift
  // recomputes.
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

  // Scroll the table's header into view, widen columns so the table overflows
  // horizontally (drags happen while the header is at its natural position).
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

  // Deep into the table: header frozen, scroll-synchronous, no shake.
  const vertical = await scrollAndReadFreeze(page, tableDocTop + 2_000);
  expect(vertical.frozen).toBe(true);
  expect(vertical.pinErrorPx).toBeLessThan(2);
  if (vertical.syncShiftErrorPx !== null) expect(vertical.syncShiftErrorPx).toBeLessThan(1.5);

  // Horizontal scroll while the header row is frozen: the first column must
  // hold, the corner cell must layer above both frozen planes.
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

  // Several freeze-window positions: settle at each, then pixel-verify the
  // band above the pinned header shows no content.
  for (const delta of [120, 320, 520]) {
    const state = await scrollAndReadFreeze(page, tableDocTop + delta);
    expect(state.frozen).toBe(true);
    expect(state.pinErrorPx).toBeLessThan(2);
    const maxStd = await scanSlotPixels(page);
    expect(maxStd, `slot band not flat at delta ${delta}`).toBeLessThan(10);
  }
  await page.screenshot({ path: testInfo.outputPath('prose-above-frozen.png') });
});
