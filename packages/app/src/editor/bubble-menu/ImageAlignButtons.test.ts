import { describe, expect, test } from 'bun:test';
import type { Editor } from '@tiptap/react';
import { isImageNodeSelected } from './ImageAlignButtons';

function makeEditor(selection: object): Editor {
  return {
    state: { selection },
  } as unknown as Editor;
}

describe('isImageNodeSelected', () => {
  test('returns true for NodeSelection over img jsxComponent', () => {
    const editor = makeEditor({
      node: {
        type: { name: 'jsxComponent' },
        attrs: { componentName: 'img', props: { src: 'x.png', align: 'left' } },
      },
    });
    expect(isImageNodeSelected(editor)).toBe(true);
  });

  test('returns true even when align is not set (defaults to center)', () => {
    const editor = makeEditor({
      node: {
        type: { name: 'jsxComponent' },
        attrs: { componentName: 'img', props: { src: 'x.png' } },
      },
    });
    expect(isImageNodeSelected(editor)).toBe(true);
  });

  test('returns true for NodeSelection over CommonMarkImage jsxComponent', () => {
    const editor = makeEditor({
      node: {
        type: { name: 'jsxComponent' },
        attrs: { componentName: 'CommonMarkImage', props: { src: 'x.png', alt: '' } },
      },
    });
    expect(isImageNodeSelected(editor)).toBe(true);
  });

  test('returns true for NodeSelection over Embed jsxComponent', () => {
    const editor = makeEditor({
      node: {
        type: { name: 'jsxComponent' },
        attrs: { componentName: 'Embed', props: { src: 'https://example.com' } },
      },
    });
    expect(isImageNodeSelected(editor)).toBe(true);
  });

  test('returns true for NodeSelection over video jsxComponent (PRD-6822)', () => {
    const editor = makeEditor({
      node: {
        type: { name: 'jsxComponent' },
        attrs: { componentName: 'video', props: { src: 'x.mp4' } },
      },
    });
    expect(isImageNodeSelected(editor)).toBe(true);
  });

  test('returns false for NodeSelection over a non-alignable jsxComponent', () => {
    const editor = makeEditor({
      node: {
        type: { name: 'jsxComponent' },
        attrs: { componentName: 'Callout', props: { type: 'note' } },
      },
    });
    expect(isImageNodeSelected(editor)).toBe(false);
  });

  test('returns false for NodeSelection over a non-jsxComponent node', () => {
    const editor = makeEditor({
      node: {
        type: { name: 'mathInline' },
        attrs: {},
      },
    });
    expect(isImageNodeSelected(editor)).toBe(false);
  });

  test('returns false when selection has no `node` field (TextSelection)', () => {
    const editor = makeEditor({ from: 5, to: 10 });
    expect(isImageNodeSelected(editor)).toBe(false);
  });

  test('returns false for empty selection (no `node`, no shape)', () => {
    const editor = makeEditor({});
    expect(isImageNodeSelected(editor)).toBe(false);
  });
});
