import { cleanup, fireEvent, render } from '@testing-library/react';
import type { NodeViewProps } from '@tiptap/core';
import { afterEach, describe, expect, test } from 'vitest';
import { TagView } from './TagView.tsx';

afterEach(() => {
  cleanup();
});

function renderPlaceholder(): HTMLInputElement {
  const props = {
    node: { attrs: { value: '' }, type: { name: 'tag' } },
    getPos: () => undefined,
    editor: {},
  } as unknown as NodeViewProps;
  const { container } = render(<TagView {...props} />);
  return container.querySelector('input') as HTMLInputElement;
}

describe('TagView placeholder — IME composition', () => {
  test('keeps an in-progress composition the tag grammar would reject', () => {
    const input = renderPlaceholder();
    fireEvent.compositionStart(input);
    fireEvent.input(input, { target: { value: "ni'hao" }, isComposing: true });
    expect(input.value).toBe("ni'hao");
  });

  test('a confirmed composition that is a valid tag stays in the draft', () => {
    const input = renderPlaceholder();
    fireEvent.compositionStart(input);
    fireEvent.input(input, { target: { value: 'にほんご' }, isComposing: true });
    fireEvent.input(input, { target: { value: '日本語' }, isComposing: true });
    fireEvent.compositionEnd(input, { data: '日本語' });
    expect(input.value).toBe('日本語');
  });

  test('a confirmed composition outside the grammar reverts to the last valid draft', () => {
    const input = renderPlaceholder();
    fireEvent.input(input, { target: { value: 'tag' } });
    fireEvent.compositionStart(input);
    fireEvent.input(input, { target: { value: 'tag。' }, isComposing: true });
    fireEvent.compositionEnd(input, { target: { value: 'tag。' } });
    expect(input.value).toBe('tag');
  });

  test('Enter and Space that confirm an IME candidate do not commit the tag', () => {
    const input = renderPlaceholder();
    fireEvent.input(input, { target: { value: 'にほん' } });
    expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(input, { key: ' ', isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })).toBe(true);
    expect(input.value).toBe('にほん');
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
  });
});
