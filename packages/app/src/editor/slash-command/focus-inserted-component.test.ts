import type { Editor } from '@tiptap/react';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { JsxComponentDescriptor } from '../registry/types';
import {
  _resetPendingAutoOpenForTest,
  consumeAutoOpen,
  focusInsertedComponent,
} from './component-items';

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
