import { cleanup, render } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { afterEach, describe, expect, test } from 'vitest';
import { TOOLBAR_HEIGHT } from '../extensions/frozen-table-headers';
import {
  deriveEditorClipOptions,
  deriveEditorShiftOptions,
  deriveEditorSizeOptions,
} from './editor-visible-region';

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

const PENDING_OFFSET_PX = 12;

const EXPECTED_PANE_GUTTER_PX = 8;

const COMPOSER_HEIGHT_PX = 236;
const CONFLICT_FOOTER_HEIGHT_PX = 48;

describe('deriveEditorShiftOptions', () => {
  test('clamps both axes against the region deriveEditorClipOptions describes', () => {
    const { editor, scroller } = renderEditorInScroller();
    const options = deriveEditorShiftOptions(editor)({ placement: 'top' });
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
    expect(floating.style.maxWidth).toBe('');
  });

  test('pre-mount editor clears the cap rather than throwing', () => {
    const floating = document.createElement('div');
    floating.style.maxWidth = '123px';
    deriveEditorSizeOptions(preMountEditor())().apply({ elements: { floating } });
    expect(floating.style.maxWidth).toBe('');
  });
});
