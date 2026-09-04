import { expect, type Page } from '@playwright/test';

type LandingMode = 'wysiwyg' | 'source';

type LandingPlacement = 'top' | 'center';

const SCROLL_CONTAINER_SELECTOR = '[data-testid="editor-scroll-container"]';
const WYSIWYG_SELECTOR = '.ProseMirror:not(.composer-prosemirror)';
const SOURCE_SELECTOR = '.cm-editor';
const CHUNK_WRAPPER_SELECTOR = `${WYSIWYG_SELECTOR} .ok-chunk-wrapper`;
export const TOOLBAR_OVERLAP_PX = 56;

const MODE_RADIO_NAME: Record<LandingMode, string> = {
  wysiwyg: 'Visual editor',
  source: 'Markdown source',
};

export async function toggleMode(page: Page, to: LandingMode): Promise<void> {
  await page.getByRole('radio', { name: MODE_RADIO_NAME[to] }).click();
  const mounted = to === 'source' ? SOURCE_SELECTOR : WYSIWYG_SELECTOR;
  await expect(page.locator(mounted).first()).toBeVisible();
}

interface LandingMark {
  kind: 'land' | 'abandoned';
  grade: string;
  delta: number;
  target?: number;
}

const LAND_MARK = 'ok/landing/land';
const ABANDON_MARK = 'ok/landing/abandoned';

export async function landingMarkCount(page: Page): Promise<number> {
  return page.evaluate(
    ([land, abandon]) =>
      performance.getEntriesByName(land).length + performance.getEntriesByName(abandon).length,
    [LAND_MARK, ABANDON_MARK] as const,
  );
}

interface RawMarkPayload {
  name: string;
  props: Record<string, string>;
}

function parseMark(raw: RawMarkPayload | null): LandingMark {
  if (!raw) {
    throw new Error('waitForLandingSettled: a terminal landing mark was counted but not readable');
  }
  const kind = raw.name === ABANDON_MARK ? 'abandoned' : 'land';
  const mark: LandingMark = {
    kind,
    grade: raw.props.grade ?? 'unknown',
    delta: Number(raw.props.delta ?? 'NaN'),
  };
  if (kind === 'abandoned') mark.target = Number(raw.props.target ?? 'NaN');
  return mark;
}

export async function waitForLandingSettled(
  page: Page,
  opts?: { since?: number; timeout?: number },
): Promise<LandingMark> {
  const since = opts?.since ?? 0;
  await expect
    .poll(() => landingMarkCount(page), { timeout: opts?.timeout ?? 10_000 })
    .toBeGreaterThan(since);

  const raw = await page.evaluate(
    ([land, abandon]) => {
      const entries = [
        ...performance.getEntriesByName(land),
        ...performance.getEntriesByName(abandon),
      ].sort((a, b) => a.startTime - b.startTime);
      const latest = entries[entries.length - 1];
      if (!latest) return null;
      const detail = (latest as PerformanceMeasure & { detail?: unknown }).detail as
        | { devtools?: { properties?: Array<[string, string]> } }
        | undefined;
      const props: Record<string, string> = {};
      for (const [k, v] of detail?.devtools?.properties ?? []) props[k] = v;
      return { name: latest.name, props };
    },
    [LAND_MARK, ABANDON_MARK] as const,
  );
  return parseMark(raw);
}

export async function injectForcedEstimateError(page: Page, cvHeightPx = 400): Promise<void> {
  const value = `${cvHeightPx}px`;
  await page.addStyleTag({ content: `:root{--ok-cv-h:${value};}` });
  const applied = await page.evaluate(
    ([wrapperSelector]) => {
      const root = getComputedStyle(document.documentElement).getPropertyValue('--ok-cv-h').trim();
      const wrapper = document.querySelector<HTMLElement>(wrapperSelector);
      const onWrapper = wrapper
        ? getComputedStyle(wrapper).getPropertyValue('--ok-cv-h').trim()
        : null;
      return { root, onWrapper };
    },
    [CHUNK_WRAPPER_SELECTOR] as const,
  );
  expect(applied.root, 'forced --ok-cv-h did not apply on :root at runtime').toBe(value);
  if (applied.onWrapper !== null) {
    expect(applied.onWrapper, 'forced --ok-cv-h did not inherit to the chunk wrapper').toBe(value);
  }
}

interface SourceLandingProbe {
  materialized: boolean;
  visible: boolean;
  topOffsetFromReadableTop: number;
  centerOffsetFromReadableCenter: number;
  readableHeight: number;
  caretHead: number;
}

interface WysiwygLandingProbe {
  materialized: boolean;
  visible: boolean;
  decoyVisible: boolean | null;
  topOffsetFromReadableTop: number;
  centerOffsetFromReadableCenter: number;
  readableHeight: number;
}

interface AssertLandedSourceOptions {
  mode: 'source';
  targetText: string;
  placement?: LandingPlacement;
  toolbarPx?: number;
}

interface AssertLandedWysiwygOptions {
  mode: 'wysiwyg';
  targetMarker: string;
  decoyMarker?: string;
  placement?: LandingPlacement;
  toolbarPx?: number;
}

type AssertLandedOptions = AssertLandedSourceOptions | AssertLandedWysiwygOptions;

export async function assertLanded(page: Page, options: AssertLandedOptions): Promise<void> {
  const { placement } = options;
  const toolbarPx = options.toolbarPx ?? TOOLBAR_OVERLAP_PX;
  if (options.mode === 'source') {
    await assertLandedSource(page, options.targetText, placement, toolbarPx);
  } else {
    await assertLandedWysiwyg(
      page,
      options.targetMarker,
      options.decoyMarker,
      placement,
      toolbarPx,
    );
  }
}

async function assertLandedSource(
  page: Page,
  targetText: string,
  placement: LandingPlacement | undefined,
  toolbarPx: number,
): Promise<void> {
  const probe = await page.evaluate(
    ({ targetText, toolbarPx, scrollSelector, sourceSelector }): SourceLandingProbe => {
      const scroller = Array.from(document.querySelectorAll<HTMLElement>(scrollSelector)).find(
        (el) => el.getClientRects().length > 0,
      );
      if (!scroller) throw new Error('assertLanded(source): no visible scroll container');

      const content = Array.from(document.querySelectorAll<HTMLElement>(sourceSelector))
        .find((el) => el.getClientRects().length > 0)
        ?.querySelector('.cm-content');
      const handle = content as
        | (Element & {
            cmTile?: { root?: { view?: unknown } };
            cmView?: { rootView?: { view?: unknown } };
          })
        | null
        | undefined;
      const view = (handle?.cmTile?.root?.view ?? handle?.cmView?.rootView?.view) as
        | {
            state: {
              doc: { toString(): string; length: number };
              selection: { main: { head: number } };
            };
            viewport: { from: number; to: number };
            coordsAtPos(pos: number): { top: number; bottom: number } | null;
          }
        | undefined;
      if (!view)
        throw new Error('assertLanded(source): no CodeMirror EditorView on the content DOM');

      const docText = view.state.doc.toString();
      const idx = docText.indexOf(targetText);
      if (idx === -1) {
        throw new Error(`assertLanded(source): target text "${targetText}" not in the document`);
      }

      const scrollRect = scroller.getBoundingClientRect();
      const readableTop = scrollRect.top + toolbarPx;
      const readableHeight = scrollRect.bottom - readableTop;
      const inViewport = idx >= view.viewport.from && idx <= view.viewport.to;
      const coords = view.coordsAtPos(idx);
      if (!inViewport || !coords) {
        return {
          materialized: false,
          visible: false,
          topOffsetFromReadableTop: Number.NaN,
          centerOffsetFromReadableCenter: Number.NaN,
          readableHeight,
          caretHead: view.state.selection.main.head,
        };
      }
      const center = (coords.top + coords.bottom) / 2;
      return {
        materialized: true,
        visible: coords.top < scrollRect.bottom && coords.bottom > readableTop,
        topOffsetFromReadableTop: coords.top - readableTop,
        centerOffsetFromReadableCenter: center - (readableTop + scrollRect.bottom) / 2,
        readableHeight,
        caretHead: view.state.selection.main.head,
      };
    },
    {
      targetText,
      toolbarPx,
      scrollSelector: SCROLL_CONTAINER_SELECTOR,
      sourceSelector: SOURCE_SELECTOR,
    },
  );

  assertPlacement('source', probe, placement);
}

async function assertLandedWysiwyg(
  page: Page,
  targetMarker: string,
  decoyMarker: string | undefined,
  placement: LandingPlacement | undefined,
  toolbarPx: number,
): Promise<void> {
  const probe = await page.evaluate(
    ({
      targetMarker,
      decoyMarker,
      toolbarPx,
      scrollSelector,
      wrapperSelector,
    }): WysiwygLandingProbe => {
      const scroller = Array.from(document.querySelectorAll<HTMLElement>(scrollSelector)).find(
        (el) => el.getClientRects().length > 0,
      );
      if (!scroller) throw new Error('assertLanded(wysiwyg): no visible scroll container');

      const wrappers = Array.from(document.querySelectorAll<HTMLElement>(wrapperSelector));
      const findWrapper = (marker: string): HTMLElement | undefined =>
        wrappers.find((w) => w.textContent?.includes(marker));

      const target = findWrapper(targetMarker);
      if (!target) {
        throw new Error(`assertLanded(wysiwyg): target block "${targetMarker}" not in the DOM`);
      }
      const targetProbe = target.firstElementChild;
      if (!targetProbe) {
        throw new Error(
          `assertLanded(wysiwyg): target block "${targetMarker}" has no element child to probe`,
        );
      }
      const materialized = targetProbe.getBoundingClientRect().height > 0;

      const scrollRect = scroller.getBoundingClientRect();
      const readableTop = scrollRect.top + toolbarPx;
      const readableHeight = scrollRect.bottom - readableTop;
      const inBand = (r: DOMRect): boolean => r.top < scrollRect.bottom && r.bottom > readableTop;

      let decoyVisible: boolean | null = null;
      if (decoyMarker !== undefined) {
        const decoy = findWrapper(decoyMarker);
        if (!decoy) {
          throw new Error(`assertLanded(wysiwyg): decoy block "${decoyMarker}" not in the DOM`);
        }
        decoyVisible = inBand(decoy.getBoundingClientRect());
      }

      const rect = target.getBoundingClientRect();
      const center = rect.top + rect.height / 2;
      return {
        materialized,
        visible: inBand(rect),
        decoyVisible,
        topOffsetFromReadableTop: rect.top - readableTop,
        centerOffsetFromReadableCenter: center - (readableTop + scrollRect.bottom) / 2,
        readableHeight,
      };
    },
    {
      targetMarker,
      decoyMarker: decoyMarker ?? undefined,
      toolbarPx,
      scrollSelector: SCROLL_CONTAINER_SELECTOR,
      wrapperSelector: CHUNK_WRAPPER_SELECTOR,
    },
  );

  expect(
    probe.materialized,
    `WYSIWYG target "${targetMarker}" is content-visibility-skipped (not landed)`,
  ).toBe(true);
  if (probe.decoyVisible !== null) {
    expect(
      probe.decoyVisible,
      `WYSIWYG decoy "${decoyMarker}" is within the readable area — the landing rendered the wrong region`,
    ).toBe(false);
  }
  assertPlacement('wysiwyg', probe, placement);
}

function assertPlacement(
  mode: LandingMode,
  probe: SourceLandingProbe | WysiwygLandingProbe,
  placement: LandingPlacement | undefined,
): void {
  expect(
    probe.materialized,
    `${mode} target is not materialized (not rendered in the viewport)`,
  ).toBe(true);
  expect(probe.visible, `${mode} target is not within the readable area after landing`).toBe(true);

  const band = probe.readableHeight;
  if (placement === 'top') {
    expect(
      probe.topOffsetFromReadableTop,
      `${mode} top-placed target is not near the top of the readable area`,
    ).toBeLessThan(band * 0.5);
    expect(probe.topOffsetFromReadableTop).toBeGreaterThan(-band * 0.25);
  } else if (placement === 'center') {
    expect(
      Math.abs(probe.centerOffsetFromReadableCenter),
      `${mode} center-placed target is not near the readable-area center`,
    ).toBeLessThan(band * 0.3);
  }
}

export async function scrollWysiwygBlockToTop(page: Page, marker: string): Promise<number> {
  return page.evaluate(
    async ({ marker, wrapperSelector, scrollSelector, toolbarPx }) => {
      const scroller = Array.from(document.querySelectorAll<HTMLElement>(scrollSelector)).find(
        (el) => el.getClientRects().length > 0,
      );
      if (!scroller) throw new Error('scrollWysiwygBlockToTop: no visible scroll container');
      const findWrapper = (): HTMLElement | undefined =>
        Array.from(document.querySelectorAll<HTMLElement>(wrapperSelector)).find((w) =>
          w.textContent?.includes(marker),
        );
      if (!findWrapper())
        throw new Error(`scrollWysiwygBlockToTop: block "${marker}" not in the DOM`);
      const nextFrame = (): Promise<void> =>
        new Promise((resolve) => {
          requestAnimationFrame(() => resolve());
        });

      const REQUIRED_STABLE_FRAMES = 5;
      const MAX_FRAMES = 90;
      let delta = Number.POSITIVE_INFINITY;
      let stableFrames = 0;
      for (let i = 0; i < MAX_FRAMES; i++) {
        const wrapper = findWrapper();
        if (!wrapper) break;
        const readableTop = scroller.getBoundingClientRect().top + toolbarPx;
        delta = wrapper.getBoundingClientRect().top - readableTop;
        const painted = (wrapper.firstElementChild?.getBoundingClientRect().height ?? 0) > 0;
        if (Math.abs(delta) <= 2 && painted) {
          stableFrames += 1;
          if (stableFrames >= REQUIRED_STABLE_FRAMES) break;
        } else {
          stableFrames = 0;
          if (Math.abs(delta) > 2) scroller.scrollTop += delta;
        }
        await nextFrame();
      }
      return delta;
    },
    {
      marker,
      wrapperSelector: CHUNK_WRAPPER_SELECTOR,
      scrollSelector: SCROLL_CONTAINER_SELECTOR,
      toolbarPx: TOOLBAR_OVERLAP_PX,
    },
  );
}

export async function readSourceCaretHead(page: Page): Promise<number> {
  return page.evaluate((sourceSelector) => {
    const content = Array.from(document.querySelectorAll<HTMLElement>(sourceSelector))
      .find((el) => el.getClientRects().length > 0)
      ?.querySelector('.cm-content');
    const handle = content as
      | (Element & {
          cmTile?: { root?: { view?: unknown } };
          cmView?: { rootView?: { view?: unknown } };
        })
      | null
      | undefined;
    const view = (handle?.cmTile?.root?.view ?? handle?.cmView?.rootView?.view) as
      | { state: { selection: { main: { head: number } } } }
      | undefined;
    if (!view) throw new Error('readSourceCaretHead: no CodeMirror EditorView on the content DOM');
    return view.state.selection.main.head;
  }, SOURCE_SELECTOR);
}

export async function readWysiwygCaretHead(page: Page): Promise<number> {
  return page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('readWysiwygCaretHead: window.__activeEditor not set');
    return editor.state.selection.head;
  });
}
