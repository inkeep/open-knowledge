import type { Node as PmNode } from '@tiptap/pm/model';
import { beforeEach, describe, expect, test, vi } from 'vitest';

type NodeChange = (arg: { node: PmNode | null; pos: number }) => void;

let captured: { element: HTMLElement; onNodeChange: NodeChange } | null = null;

vi.mock('@tiptap/extension-drag-handle', () => ({
  DragHandlePlugin: (options: { element: HTMLElement; onNodeChange: NodeChange }) => {
    captured = { element: options.element, onNodeChange: options.onNodeChange };
    return { plugin: {} };
  },
  normalizeNestedOptions: () => ({}),
}));

const { BlockDragHandle } = await import('./drag-handle.ts');

function mountControls(): { addBtn: HTMLElement; grip: HTMLElement; fire: NodeChange } {
  captured = null;
  const build = BlockDragHandle.config.addProseMirrorPlugins as (this: {
    editor: unknown;
  }) => unknown[];
  build.call({ editor: {} });
  if (!captured) throw new Error('DragHandlePlugin was never constructed');
  const { element, onNodeChange } = captured;
  const addBtn = element.querySelector('.ok-add-block-btn');
  const grip = element.querySelector('.ok-drag-grip');
  if (!(addBtn instanceof HTMLElement) || !(grip instanceof HTMLElement)) {
    throw new Error('block controls are missing a button');
  }
  return { addBtn, grip, fire: onNodeChange };
}

describe('block controls label refresh', () => {
  let controls: ReturnType<typeof mountControls>;

  beforeEach(() => {
    controls = mountControls();
  });

  test('both buttons are labelled at construction', () => {
    expect(controls.addBtn.getAttribute('aria-label')).toBe('Add block below');
    expect(controls.grip.getAttribute('aria-label')).toBe('Select block');
  });

  test('a node change rewrites the + button label rather than leaving it as found', () => {
    controls.addBtn.setAttribute('aria-label', 'stale');
    controls.fire({ node: null, pos: 0 });
    expect(controls.addBtn.getAttribute('aria-label')).toBe('Add block below');
  });

  test('a node change rewrites the grip label too', () => {
    controls.grip.setAttribute('aria-label', 'stale');
    controls.fire({ node: null, pos: 0 });
    expect(controls.grip.getAttribute('aria-label')).toBe('Select block');
  });
});
