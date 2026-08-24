/**
 * DOM-tier tests for all three parts of the editor's visible-region contract:
 * `deriveEditorClipOptions`, which describes the region (scroll container
 * minus the toolbar band and the live bottom-composer / conflict-footer
 * overlays), `deriveEditorShiftOptions`, which clamps a surface into it, and
 * `deriveEditorSizeOptions`, which caps a surface that would not fit inside it
 * at any coordinate. The consumers are the formatting bubble bar, the comment
 * composer, and the lint callout, so neither the module nor these tests belong
 * to any one of them.
 *
 * DOM tier because the derivable resolves the `.editor-doc-scroll` ancestor
 * via `closest()` on a rendered tree and reads the overlay-height CSS vars
 * off the document root's inline style — both real-DOM behaviors.
 *
 * The load-bearing property is liveness: the options function is re-invoked
 * per `computePosition` pass and must reflect the overlay vars *at that
 * moment* (the composer card grows with its draft and collapses to nothing),
 * not a snapshot from when the menu mounted.
 *
 * Invocation: `pnpm run test:dom` from `packages/app/`.
 */

import { cleanup, render } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { afterEach, describe, expect, test } from 'vitest';
import { TOOLBAR_HEIGHT } from '../extensions/frozen-table-headers';
import {
  deriveEditorClipOptions,
  deriveEditorShiftOptions,
  deriveEditorSizeOptions,
} from './editor-visible-region';

/** Renders the editor-DOM shape the derivable walks: a `.editor-doc-scroll`
 *  scroll container wrapping the ProseMirror mount the editor points at. */
function renderEditorInScroller(): { editor: Editor; scroller: HTMLElement } {
  const { container } = render(
    <div className="editor-doc-scroll">
      <div data-testid="pm-mount" />
    </div>,
  );
  const scroller = container.querySelector('.editor-doc-scroll') as HTMLElement;
  const dom = container.querySelector('[data-testid="pm-mount"]') as HTMLElement;
  return { editor: { editorView: { dom } } as unknown as Editor, scroller };
}

/** An editor whose ProseMirror view has not mounted yet (recycle/remount
 *  race): `getEditorView` reads the real `editorView` field, which is
 *  `undefined` until the view exists. */
function preMountEditor(): Editor {
  return {} as unknown as Editor;
}

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty('--ask-composer-height');
  document.documentElement.style.removeProperty('--conflict-footer-height');
});

describe('deriveEditorClipOptions', () => {
  test('bounds to the editor scroll container with the toolbar band as top inset', () => {
    const { editor, scroller } = renderEditorInScroller();
    const options = deriveEditorClipOptions(editor)();
    expect(options.boundary).toBe(scroller);
    expect(options.padding).toEqual({ top: TOOLBAR_HEIGHT, bottom: 0 });
  });

  test('bottom inset tracks the published composer height', () => {
    const { editor } = renderEditorInScroller();
    document.documentElement.style.setProperty('--ask-composer-height', '236px');
    expect(deriveEditorClipOptions(editor)().padding.bottom).toBe(236);
  });

  test('conflict-footer overlay alone sets the bottom inset', () => {
    const { editor } = renderEditorInScroller();
    document.documentElement.style.setProperty('--conflict-footer-height', '48px');
    expect(deriveEditorClipOptions(editor)().padding.bottom).toBe(48);
  });

  test('composer and conflict-footer overlays stack into one bottom inset', () => {
    const { editor } = renderEditorInScroller();
    document.documentElement.style.setProperty('--ask-composer-height', '236px');
    document.documentElement.style.setProperty('--conflict-footer-height', '48px');
    expect(deriveEditorClipOptions(editor)().padding.bottom).toBe(284);
  });

  test('re-reads overlay heights on every invocation', () => {
    const { editor } = renderEditorInScroller();
    const derive = deriveEditorClipOptions(editor);
    expect(derive().padding.bottom).toBe(0);
    document.documentElement.style.setProperty('--ask-composer-height', '180px');
    expect(derive().padding.bottom).toBe(180);
    document.documentElement.style.removeProperty('--ask-composer-height');
    expect(derive().padding.bottom).toBe(0);
  });

  test('malformed overlay value reads as no inset', () => {
    const { editor } = renderEditorInScroller();
    document.documentElement.style.setProperty('--ask-composer-height', 'auto');
    expect(deriveEditorClipOptions(editor)().padding.bottom).toBe(0);
  });

  test('omits the boundary when no scroll container is resolvable', () => {
    const { container } = render(<div data-testid="pm-mount" />);
    const dom = container.querySelector('[data-testid="pm-mount"]') as HTMLElement;
    const editor = { editorView: { dom } } as unknown as Editor;
    const options = deriveEditorClipOptions(editor)();
    expect('boundary' in options).toBe(false);
    expect(options.padding.top).toBe(TOOLBAR_HEIGHT);
  });

  test('pre-mount editor (no ProseMirror view yet) falls back to the default boundary', () => {
    const options = deriveEditorClipOptions(preMountEditor())();
    expect('boundary' in options).toBe(false);
    expect(options.padding.top).toBe(TOOLBAR_HEIGHT);
  });
});

/**
 * The producer's counterpart: `deriveEditorClipOptions` describes the visible
 * region, and `deriveEditorShiftOptions` keeps a surface inside it. Its
 * options are pure arithmetic over the same inputs, so they are pinnable at
 * this tier — unlike the rendered coordinate, which needs a real layout engine
 * (`tests/stress/selection-surface-pane-clip.e2e.ts`).
 */

/**
 * A chain that applies its anchor gap AFTER the clamp (tiptap's BubbleMenu
 * plugin builds `flip -> shift -> offset`) leaves that many pixels still to be
 * added when the clamp is computed, so the clamp region has to absorb them.
 *
 * Deliberately NOT the production gap (`SELECTION_SURFACE_GAP_PX`, 8): a
 * distinct probe value is what distinguishes a producer that compensates by
 * the argument it was handed from one that reaches for the module constant.
 */
const PENDING_OFFSET_PX = 12;

/** Restates `PANE_GUTTER_PX`, which the module keeps private. */
const EXPECTED_PANE_GUTTER_PX = 8;

/** Overlay heights chosen to make the bottom inset a non-zero, non-round sum. */
const COMPOSER_HEIGHT_PX = 236;
const CONFLICT_FOOTER_HEIGHT_PX = 48;

describe('deriveEditorShiftOptions', () => {
  test('clamps both axes against the region deriveEditorClipOptions describes', () => {
    const { editor, scroller } = renderEditorInScroller();
    const options = deriveEditorShiftOptions(editor)({ placement: 'top' });
    // Cross-axis is the load-bearing half: for a top/bottom placement the Y
    // axis is shift's cross axis, which is the axis a selection scrolled
    // behind the toolbar escapes along.
    expect(options.mainAxis).toBe(true);
    expect(options.crossAxis).toBe(true);
    expect(options.boundary).toBe(scroller);
  });

  test('uncompensated insets match the clip region exactly', () => {
    const { editor } = renderEditorInScroller();
    document.documentElement.style.setProperty('--ask-composer-height', `${COMPOSER_HEIGHT_PX}px`);
    document.documentElement.style.setProperty(
      '--conflict-footer-height',
      `${CONFLICT_FOOTER_HEIGHT_PX}px`,
    );
    const clip = deriveEditorClipOptions(editor)();
    const options = deriveEditorShiftOptions(editor)({ placement: 'top' });
    expect(options.padding.top).toBe(clip.padding.top);
    expect(options.padding.top).toBe(TOOLBAR_HEIGHT);
    expect(options.padding.bottom).toBe(clip.padding.bottom);
    expect(options.padding.bottom).toBe(COMPOSER_HEIGHT_PX + CONFLICT_FOOTER_HEIGHT_PX);
  });

  test.each([
    'top',
    'top-start',
  ] as const)('a %s placement absorbs a pending anchor gap by tightening the top inset', (placement) => {
    const { editor } = renderEditorInScroller();
    document.documentElement.style.setProperty('--ask-composer-height', `${COMPOSER_HEIGHT_PX}px`);
    const options = deriveEditorShiftOptions(editor, {
      pendingOffsetPx: PENDING_OFFSET_PX,
    })({ placement });
    // A top-side surface is pushed further UP by the pending gap, so the
    // region it may be clamped into starts that much lower.
    expect(options.padding.top).toBe(TOOLBAR_HEIGHT + PENDING_OFFSET_PX);
    expect(options.padding.bottom).toBe(COMPOSER_HEIGHT_PX - PENDING_OFFSET_PX);
  });

  test.each([
    'bottom',
    'bottom-start',
  ] as const)('a %s placement mirrors the compensation', (placement) => {
    const { editor } = renderEditorInScroller();
    document.documentElement.style.setProperty('--ask-composer-height', `${COMPOSER_HEIGHT_PX}px`);
    const options = deriveEditorShiftOptions(editor, {
      pendingOffsetPx: PENDING_OFFSET_PX,
    })({ placement });
    expect(options.padding.top).toBe(TOOLBAR_HEIGHT - PENDING_OFFSET_PX);
    expect(options.padding.bottom).toBe(COMPOSER_HEIGHT_PX + PENDING_OFFSET_PX);
  });

  test.each([
    'left',
    'right',
  ] as const)('a %s placement needs no compensation — the pending gap is horizontal there', (placement) => {
    const { editor } = renderEditorInScroller();
    document.documentElement.style.setProperty('--ask-composer-height', `${COMPOSER_HEIGHT_PX}px`);
    const options = deriveEditorShiftOptions(editor, {
      pendingOffsetPx: PENDING_OFFSET_PX,
    })({ placement });
    expect(options.padding.top).toBe(TOOLBAR_HEIGHT);
    expect(options.padding.bottom).toBe(COMPOSER_HEIGHT_PX);
  });

  test('a top placement with no composer up drives the bottom inset negative', () => {
    const { editor } = renderEditorInScroller();
    // Negative is correct, and it is the one arithmetic a reader is most
    // likely to "fix". The plugin's trailing `offset()` re-adds exactly this
    // much: its clamp ceiling is `B - h - padding.bottom`, so a bottom inset
    // of `-p` puts it at `B - h + p` and the offset lands it on `B - h`, the
    // loop's value. Clamp the inset at 0 and the ceiling is `B - h`, the
    // offset takes it to `B - h - p`, and the plugin settles a gap ABOVE the
    // loop. Pinned here because the browser tier never runs with the Ask AI
    // composer collapsed, which is the only state that reaches it.
    const options = deriveEditorShiftOptions(editor, {
      pendingOffsetPx: PENDING_OFFSET_PX,
    })({ placement: 'top' });
    expect(options.padding.bottom).toBe(-PENDING_OFFSET_PX);
  });

  test('keeps a symmetric horizontal gutter that no placement moves', () => {
    const { editor } = renderEditorInScroller();
    const derive = deriveEditorShiftOptions(editor, { pendingOffsetPx: PENDING_OFFSET_PX });
    const top = derive({ placement: 'top' }).padding;
    const bottom = derive({ placement: 'bottom' }).padding;
    expect(top.left).toBe(top.right);
    // The value, not just the symmetry: the e2e's containment tolerance is
    // itself 8 px, so a change to the gutter is invisible at that tier.
    expect(top.left).toBe(EXPECTED_PANE_GUTTER_PX);
    expect(bottom.left).toBe(top.left);
    expect(bottom.right).toBe(top.right);
  });

  test('falls back to insets alone when no scroll container is resolvable', () => {
    const { container } = render(<div data-testid="pm-mount" />);
    const dom = container.querySelector('[data-testid="pm-mount"]') as HTMLElement;
    const editor = { editorView: { dom } } as unknown as Editor;
    const options = deriveEditorShiftOptions(editor)({ placement: 'top' });
    expect('boundary' in options).toBe(false);
    expect(options.mainAxis).toBe(true);
    expect(options.crossAxis).toBe(true);
    expect(options.padding.top).toBe(TOOLBAR_HEIGHT);
  });

  test('pre-mount editor still clamps, against the default boundary', () => {
    const options = deriveEditorShiftOptions(preMountEditor())({ placement: 'top' });
    expect('boundary' in options).toBe(false);
    expect(options.mainAxis).toBe(true);
    expect(options.crossAxis).toBe(true);
    expect(options.padding.top).toBe(TOOLBAR_HEIGHT);
  });
});

describe('deriveEditorSizeOptions', () => {
  const PANE_WIDTH_PX = 300;

  /** jsdom gives every element a zero rect, so the region has to be stated. */
  function renderEditorInPaneOfWidth(widthPx: number): {
    editor: Editor;
    floating: HTMLElement;
  } {
    const { editor, scroller } = renderEditorInScroller();
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, widthPx, 800);
    return { editor, floating: document.createElement('div') };
  }

  test('caps the surface at the pane less both gutters', () => {
    const { editor, floating } = renderEditorInPaneOfWidth(PANE_WIDTH_PX);
    deriveEditorSizeOptions(editor)().apply({ elements: { floating } });
    expect(floating.style.maxWidth).toBe(`${PANE_WIDTH_PX - EXPECTED_PANE_GUTTER_PX * 2}px`);
  });

  test('folds an author cap in with min() rather than replacing it', () => {
    const { editor, floating } = renderEditorInPaneOfWidth(PANE_WIDTH_PX);
    // The inline write outranks the stylesheet, so a producer that ignored the
    // author's ceiling would WIDEN a capped surface on a roomy pane. `min()`
    // is what keeps this a ceiling in both directions.
    deriveEditorSizeOptions(editor, { authorMaxWidth: '22rem' })().apply({
      elements: { floating },
    });
    expect(floating.style.maxWidth).toBe(
      `min(22rem, ${PANE_WIDTH_PX - EXPECTED_PANE_GUTTER_PX * 2}px)`,
    );
  });

  test('re-reads the region on every invocation', () => {
    const { editor, scroller } = renderEditorInScroller();
    const floating = document.createElement('div');
    const derive = deriveEditorSizeOptions(editor);
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 500, 800);
    derive().apply({ elements: { floating } });
    expect(floating.style.maxWidth).toBe(`${500 - EXPECTED_PANE_GUTTER_PX * 2}px`);
    // The pane resizes under a live surface whenever a session dock is dragged,
    // which is the very geometry this cap exists for.
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 200, 800);
    derive().apply({ elements: { floating } });
    expect(floating.style.maxWidth).toBe(`${200 - EXPECTED_PANE_GUTTER_PX * 2}px`);
  });

  test('never emits a negative cap for a pane narrower than its gutters', () => {
    const { editor, floating } = renderEditorInPaneOfWidth(4);
    deriveEditorSizeOptions(editor)().apply({ elements: { floating } });
    expect(floating.style.maxWidth).toBe('0px');
  });

  test('clears the cap when no scroll container is resolvable', () => {
    const { container } = render(<div data-testid="pm-mount" />);
    const dom = container.querySelector('[data-testid="pm-mount"]') as HTMLElement;
    const editor = { editorView: { dom } } as unknown as Editor;
    const floating = document.createElement('div');
    floating.style.maxWidth = '123px';
    deriveEditorSizeOptions(editor)().apply({ elements: { floating } });
    // Cleared, not left stale: a surface that outlived its pane must not stay
    // pinned to the width that pane used to have.
    expect(floating.style.maxWidth).toBe('');
  });

  test('pre-mount editor clears the cap rather than throwing', () => {
    const floating = document.createElement('div');
    floating.style.maxWidth = '123px';
    deriveEditorSizeOptions(preMountEditor())().apply({ elements: { floating } });
    expect(floating.style.maxWidth).toBe('');
  });
});
