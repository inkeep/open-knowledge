/**
 * Unit tests for `focusInsertedComponent`'s branch selection — which post-
 * insert focus/auto-open action fires for each descriptor shape.
 *
 * The interesting case is a self-closing leaf with NO editable props (today
 * MermaidFence): its source is authored in the fullscreen edit modal, so
 * every prop is hidden and `hasEditableProps` is false. Before the fix this
 * fell through to a no-op — the slash insert did nothing visible. Now it must
 * flag a pending auto-open (consumed by the NodeView to open the edit modal),
 * exactly like the editable-props popover path.
 */

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { Editor } from '@tiptap/react';
import type { JsxComponentDescriptor } from '../registry/types';
import {
  _resetPendingAutoOpenForTest,
  consumeAutoOpen,
  focusInsertedComponent,
} from './component-items';

// `focusInsertedComponent` schedules `setNodeSelection` inside rAF. The Bun
// unit runtime has no DOM, so rAF may be absent — stub it as a no-op (we only
// assert the synchronous pending-auto-open flag, not the deferred selection).
beforeAll(() => {
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    (
      globalThis as { requestAnimationFrame: (cb: FrameRequestCallback) => number }
    ).requestAnimationFrame = () => 0;
  }
});

afterEach(() => {
  _resetPendingAutoOpenForTest();
});

// Minimal editor stub — the branch under test only reaches `commands.*`
// inside the rAF callback (stubbed away) or synchronously for the children
// path; neither needs a real editor.
const fakeEditor = {
  commands: {
    setNodeSelection: () => true,
    setTextSelection: () => true,
  },
} as unknown as Editor;

function descriptor(partial: Partial<JsxComponentDescriptor>): JsxComponentDescriptor {
  return {
    name: 'X',
    surface: 'canonical',
    hasChildren: false,
    props: [],
    ...partial,
  } as JsxComponentDescriptor;
}

describe('focusInsertedComponent — post-insert focus branch', () => {
  test('source-bearing self-closing leaf (all props hidden) flags a pending auto-open', () => {
    const mermaidLike = descriptor({
      name: 'MermaidFence',
      hasChildren: false,
      // Single required-but-hidden prop → hasEditableProps === false.
      props: [{ name: 'chart', type: 'string', required: true, hidden: true }],
    });
    focusInsertedComponent(fakeEditor, 12, mermaidLike);
    expect(consumeAutoOpen(12)).toBe(true);
  });

  test('descriptor with editable props flags a pending auto-open (popover path)', () => {
    const withProps = descriptor({
      name: 'img',
      hasChildren: false,
      props: [{ name: 'src', type: 'string', required: true }],
    });
    focusInsertedComponent(fakeEditor, 8, withProps);
    expect(consumeAutoOpen(8)).toBe(true);
  });

  test('children-only descriptor does NOT flag an auto-open (cursor goes inside)', () => {
    const container = descriptor({
      name: 'Callout',
      hasChildren: true,
      props: [],
    });
    focusInsertedComponent(fakeEditor, 20, container);
    expect(consumeAutoOpen(20)).toBe(false);
  });
});
