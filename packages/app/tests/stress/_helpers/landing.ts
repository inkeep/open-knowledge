/**
 * End-to-end helpers for mode-switch landing assertions.
 *
 * Landing tests are worthless if they pass by accident — a missing target that
 * reads as "not visible, so skip" is a false green. Every helper here is built
 * around one rule: the thing being asserted about must be proven present before
 * any position claim is made, and its absence fails loudly. The two editors are
 * measured asymmetrically because their virtualization differs — WYSIWYG keeps
 * every block in the DOM under `content-visibility: auto` (so a landed block is
 * checked for materialization on its rendered child element, and a decoy far
 * block is checked to be non-materialized as a wrong-geometry cross-check),
 * while CodeMirror renders only the lines near the viewport (so off-viewport
 * lines have no DOM at all, and assertions go through the view's own coordinate
 * lookup, never a bounding box).
 *
 * The settle wait observes the `ok/landing/*` performance marks the landing
 * controller emits rather than sleeping, so it tracks the app's real terminal
 * signal (land or abandon) instead of a guessed duration.
 */

import { expect, type Page } from '@playwright/test';

/** The two editor modes, mirrored locally so the helper needs no app-src import. */
type LandingMode = 'wysiwyg' | 'source';

/** Where a landing is expected to place its target within the readable area. */
type LandingPlacement = 'top' | 'center';

const SCROLL_CONTAINER_SELECTOR = '[data-testid="editor-scroll-container"]';
const WYSIWYG_SELECTOR = '.ProseMirror:not(.composer-prosemirror)';
const SOURCE_SELECTOR = '.cm-editor';
const CHUNK_WRAPPER_SELECTOR = `${WYSIWYG_SELECTOR} .ok-chunk-wrapper`;
/** The toolbar overlays the top of the shared scroller; the readable area starts below it. */
const TOOLBAR_OVERLAP_PX = 56;

const MODE_RADIO_NAME: Record<LandingMode, string> = {
  wysiwyg: 'Visual editor',
  source: 'Markdown source',
};

/**
 * Click the mode toggle and wait until the target editor is mounted and
 * visible. Both editors stay in the DOM across a flip; the swap is a
 * content-visibility class change, so `toBeVisible` is the honest ready signal.
 */
export async function toggleMode(page: Page, to: LandingMode): Promise<void> {
  await page.getByRole('radio', { name: MODE_RADIO_NAME[to] }).click();
  const mounted = to === 'source' ? SOURCE_SELECTOR : WYSIWYG_SELECTOR;
  await expect(page.locator(mounted).first()).toBeVisible();
}

/** Which terminal signal a landing produced, plus its recorded payload. */
interface LandingMark {
  kind: 'land' | 'abandoned';
  grade: string;
  delta: number;
  /** Only present on an abandoned landing. */
  target?: number;
}

const LAND_MARK = 'ok/landing/land';
const ABANDON_MARK = 'ok/landing/abandoned';

/**
 * Count of terminal landing marks (`land` + `abandoned`) emitted so far. A
 * cancelled landing emits neither, by design. Snapshot this before an action
 * and pass it as `since` to `waitForLandingSettled` so a test that toggles more
 * than once waits for the NEXT landing, not a stale earlier one.
 */
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

/**
 * Wait until the landing controller records a terminal mark beyond the `since`
 * baseline, then return the latest one parsed. Fails loudly if none appears in
 * time — a landing that never lands, cancels, or abandons is a defect, not a
 * pass. Reads the mark's DevTools-track properties to recover the grade, delta,
 * and (for an abandon) the target the controller stamped on it.
 */
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
      // `mark()` emits via `performance.measure(name, { detail })`, stamping the
      // payload as DevTools-track property tuples. Recover them into a record.
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

/**
 * Force the WYSIWYG chunk-height estimate to a wrong value by overriding the
 * `--ok-cv-h` custom property through a page style tag, then confirm it applies
 * at runtime. A page style tag is required: an init-script injection runs before
 * the app's own stylesheet and is overridden by it. Over-tall estimates make a
 * naive landing overshoot, which is the failure a landing test must be able to
 * provoke on demand.
 */
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
    // When a chunk wrapper exists the override must reach it (it is the actual
    // consumer of the variable) — otherwise the estimate error would be inert.
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
  /**
   * Whether the decoy block is within the readable area. The wrong-geometry
   * cross-check is geometric, not content-visibility-based: whether Chromium
   * actually skips an off-screen chunk in a headless run is a runtime decision,
   * but an off-screen block's box is always far outside the readable band.
   */
  decoyVisible: boolean | null;
  topOffsetFromReadableTop: number;
  centerOffsetFromReadableCenter: number;
  readableHeight: number;
}

interface AssertLandedSourceOptions {
  mode: 'source';
  /** Unique text of the target block; located in the CodeMirror document. */
  targetText: string;
  placement?: LandingPlacement;
  /** Toolbar overlap; defaults to the shared 56px. */
  toolbarPx?: number;
}

interface AssertLandedWysiwygOptions {
  mode: 'wysiwyg';
  /** Marker of the block that must be landed on and materialized. */
  targetMarker: string;
  /**
   * Marker of a far block that must NOT be materialized — the wrong-geometry
   * cross-check that distinguishes a real landing from "everything rendered" or
   * a landing at the wrong end of the document.
   */
  decoyMarker?: string;
  placement?: LandingPlacement;
  toolbarPx?: number;
}

type AssertLandedOptions = AssertLandedSourceOptions | AssertLandedWysiwygOptions;

/**
 * Assert that a landing brought its target into the readable area, measured the
 * way each editor actually virtualizes. Structural absence (target text, editor
 * view, or the probe element missing) throws inside the page so the failure is
 * loud and specific; position claims are asserted from returned measurements.
 */
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
      // CodeMirror attaches its view to the content DOM. Read it the way the
      // library's own `EditorView.findFromDOM` does, tolerating the field rename
      // across CodeMirror versions. A miss throws — the source oracle cannot be
      // honest without the view's coordinate lookup.
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
      // Materialization is read on the wrapper's first element child, not the
      // wrapper: content-visibility skips the layout of a chunk's descendants, so
      // a skipped block's child has a zero-height box while a painted block's
      // child has a real one. The `checkVisibility` API is unreliable headless
      // (it reports a just-scrolled-in block as still skipped and an off-screen
      // one as visible), so the laid-out box height is the honest signal. A
      // wrapper with no element child means the block-shape assumption changed.
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

/**
 * Assert the target is present, materialized, and within the readable area. When
 * a placement is given, additionally pin it to the top or centre of that area;
 * with no placement the check is visibility-only (the target landed on-screen,
 * without a claim about where).
 */
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
    // The anchor block should sit near the top of the readable area, tolerating
    // block granularity (a degraded grade may land an adjacent block at the top)
    // but not a landing that leaves it at the bottom or off-screen.
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

/**
 * Scroll the shared scroller so the WYSIWYG block carrying `marker` sits at the
 * top of the readable area, honoring the toolbar scroll-padding. Used to set up
 * a non-trivial landing anchor: with the block at the top, a mode flip captures
 * it as the viewport anchor.
 *
 * Convergence is required, not a single `scrollIntoView`: off-screen chunks
 * reserve an over-tall `content-visibility` estimate, so a one-shot scroll
 * overshoots and the block lands above the fold. This measures the block's real
 * rect each frame and corrects until it rests at the readable top — the same
 * measure-and-redispatch the landing controller does.
 *
 * It also holds until the block has actually painted: a chunk just scrolled into
 * view is content-visibility-skipped for a frame, and while skipped its content
 * is not laid out, so ProseMirror's `posAtCoords` finds nothing there and the
 * subsequent mode flip captures no anchor. Waiting for the child's box to gain
 * height is the paint signal.
 *
 * Reaching the top for a single frame is not enough. When the target rests at the
 * readable top, the blocks that entered the render margin just above it refine
 * their over-tall `content-visibility` estimate to real heights over the next few
 * frames, silently dragging the target upward while `scrollTop` holds. So this
 * requires the block to hold at the top across several consecutive frames before
 * returning: it re-corrects whenever a refinement knocks it off, and only reports
 * a settled viewport — the precondition a real user's flip acts on. Returns the
 * residual offset so a caller can assert it converged.
 */
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

/**
 * The CodeMirror caret head offset, read from the view's own state. Used by the
 * caret oracle: a plain toggle must leave it unchanged, a jump must place it at
 * the landed range start. Throws if the source view is not reachable.
 */
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

/**
 * The ProseMirror caret head, read from the active editor's own state. The
 * source-to-WYSIWYG caret oracle uses it: a plain toggle must leave the WYSIWYG
 * selection unchanged. Reads ProseMirror state, not the DOM, so it is valid even
 * while the WYSIWYG view is CSS-hidden underneath source mode (the editor stays
 * mounted across a flip). Throws if the dev-exposed editor is not reachable.
 */
export async function readWysiwygCaretHead(page: Page): Promise<number> {
  return page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('readWysiwygCaretHead: window.__activeEditor not set');
    return editor.state.selection.head;
  });
}
