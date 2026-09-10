// @vitest-environment jsdom
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { history, undo } from '@tiptap/pm/history';
import type { Node as PmNode } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { dropPoint } from '@tiptap/pm/transform';
import { EditorView } from '@tiptap/pm/view';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createClipboardHtmlSerializer } from '../clipboard/serialize.ts';
import { createListItemDragController } from './list-item-drag';

const schema = getSchema(sharedExtensions);
const markdown = new MarkdownManager({ extensions: sharedExtensions });
const disposers: (() => void)[] = [];

function setup(text: string) {
  const controller = createListItemDragController();
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const view = new EditorView(mount, {
    state: EditorState.create({
      doc: schema.nodeFromJSON(markdown.parse(text)),
      plugins: [controller.plugin, history()],
    }),
    handleScrollToSelection: () => true,
  });
  disposers.push(() => {
    controller.destroy();
    view.destroy();
  });
  const position = (textContent: string, type = 'listItem') => {
    let found = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === type && node.textContent === textContent) found = pos;
    });
    if (found < 0) throw new Error(`Missing ${type}: ${textContent}`);
    return found;
  };
  const data = new Map<string, string>();
  const transfer = {
    types: ['text/html', 'text/plain'],
    clearData: vi.fn(),
    setData: vi.fn((type: string, value: string) => data.set(type, value)),
    setDragImage: vi.fn(),
    getData: (type: string) => data.get(type) ?? '',
    files: [],
  };
  const start = (textContent: string, type = 'listItem', coordinates: MouseEventInit = {}) => {
    const pos = position(textContent, type);
    const event = new MouseEvent('dragstart', { bubbles: true, ...coordinates });
    Object.defineProperty(event, 'dataTransfer', {
      value: transfer,
    });
    expect(controller.start(event as DragEvent, view, view.state.doc.nodeAt(pos), pos)).toBe(true);
  };
  const drop = (pos: number) => {
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos, inside: -1 });
    const event = new MouseEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    view.dom.dispatchEvent(event);
  };
  const serialize = () => markdown.serialize(view.state.doc.toJSON());
  const select = (from: number, to: number) =>
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
  return { view, position, start, drop, serialize, select, transfer, controller };
}

function items(node: PmNode): string[] {
  const result: string[] = [];
  node.forEach((item) => {
    result.push(item.textContent);
  });
  return result;
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('list item dragging', () => {
  test('exports whole selected items with slice boundaries for a different editor', () => {
    const source = setup('- Alpha\n- Bravo %%private note%%\n- Charlie\n- Delta\n');
    const destination = setup('Before\n\nAfter\n');
    const clipboard = createClipboardHtmlSerializer({ mdManager: markdown });
    clipboard.setView(source.view);
    source.view.setProps({ clipboardSerializer: clipboard.serializer });
    source.select(source.position('Bravo private note') + 4, source.position('Charlie') + 5);
    const originalSelection = source.view.state.selection;
    source.start('Bravo private note');
    expect(source.view.state.selection).toEqual(originalSelection);
    const html = source.transfer.getData('text/html');
    expect(html).toContain('data-pm-slice="1 1 []"');
    expect(html).toContain('Bravo');
    expect(html).toContain('Charlie');
    expect(html).not.toContain('private note');
    expect(html).not.toContain('Alpha');
    vi.spyOn(destination.view, 'posAtCoords').mockReturnValue({
      pos: destination.position('After', 'paragraph'),
      inside: -1,
    });
    const event = new MouseEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: source.transfer });
    destination.view.dom.dispatchEvent(event);
    destination.view.state.doc.check();
    expect(destination.serialize()).toBe('Before\n\n- Bravo\n- Charlie\n\nAfter\n');
    expect(source.serialize()).toBe('- Alpha\n- Bravo %%private note%%\n- Charlie\n- Delta\n');
  });

  test('keeps task previews out of focus navigation and the accessibility tree', () => {
    const { start, transfer } = setup('- [ ] First\n- [x] Second\n');
    start('Second');
    const preview = transfer.setDragImage.mock.calls[0]?.[0] as HTMLElement;
    expect(preview.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(preview.hasAttribute('inert')).toBe(true);
    expect(preview.getAttribute('aria-hidden')).toBe('true');
  });

  test('preserves a nested bullet marker in the drag preview', () => {
    const { view, start, transfer } = setup('- Parent\n  - Child\n  - Sibling\n');
    const nestedList = view.dom.querySelector('ul ul');
    if (!(nestedList instanceof HTMLElement)) throw new Error('Nested list must exist');
    nestedList.style.listStyleType = 'circle';
    start('Child');
    const preview = transfer.setDragImage.mock.calls[0]?.[0] as HTMLElement;
    expect((preview.firstElementChild as HTMLElement).style.listStyleType).toBe('circle');
  });

  test('scrubs comments only from outbound data while internal moves retain them', () => {
    const { view, start, drop, position, transfer, serialize } = setup(
      '- A\n- Visible %%private note%%\n- C\n',
    );
    start('Visible private note');
    expect(transfer.setData).toHaveBeenCalledWith('text/plain', 'Visible ');
    const html = transfer.setData.mock.calls.find(([type]) => type === 'text/html')?.[1];
    expect(html).toContain('Visible');
    expect(html).not.toContain('private note');
    expect(html).not.toContain('data-comment-mark');
    expect(view.dragging?.slice.content.textBetween(0, view.dragging.slice.content.size)).toContain(
      'private note',
    );
    drop(position('A'));
    expect(serialize()).toBe('- Visible %%private note%%\n- A\n- C\n');
  });

  test('styles the composed preview and anchors its hotspot to the first moved row', () => {
    const { view, position, start, transfer } = setup('- A\n- B\n- C\n');
    view.dom.style.fontFamily = 'Arial';
    view.dom.style.fontSize = '18px';
    view.dom.style.lineHeight = '30px';
    const list = view.dom.querySelector('ul');
    const item = view.nodeDOM(position('C'));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === list) return new DOMRect(100, 100, 500, 90);
      if (this === item) return new DOMRect(124, 160, 476, 30);
      return new DOMRect(0, 0, 500, 30);
    });
    start('C', 'listItem', { clientX: 80, clientY: 171 });
    const preview = transfer.setDragImage.mock.calls[0]?.[0] as HTMLElement;
    expect(preview.classList.contains('ProseMirror')).toBe(true);
    expect(preview.style.fontFamily).toBe('Arial');
    expect(preview.style.fontSize).toBe('18px');
    expect(preview.style.lineHeight).toBe('30px');
    expect(preview.style.width).toBe('500px');
    expect(preview.style.padding).toBe('0px');
    expect(preview.querySelectorAll('li')).toHaveLength(1);
    expect(preview.textContent).toBe('C');
    expect(transfer.setDragImage).toHaveBeenCalledWith(preview, -20, 11);
  });

  test('applying a speculative transaction leaves the live drag and old state intact', () => {
    const { view, position, start, controller } = setup('- A\n- B\n- C\n');
    start('B');
    const initial = controller.plugin.getState(view.state);
    const dragging = view.dragging;
    const previewCount = document.body.childElementCount;
    const next = view.state.apply(view.state.tr.deleteRange(position('B'), position('C')));
    expect(controller.plugin.getState(next)).toEqual({ status: 'canceled' });
    expect(controller.plugin.getState(view.state)).toBe(initial);
    expect(initial?.status).toBe('active');
    expect(view.dragging).toBe(dragging);
    expect(document.body.childElementCount).toBe(previewCount);
    view.updateState(next);
    expect(view.dragging).toBeNull();
    expect(document.body.childElementCount).toBe(previewCount - 1);
  });

  test('cleans up a failed drag image and permits the next drag', () => {
    const { view, start, transfer, controller, drop, position } = setup('- A\n- B\n- C\n');
    transfer.setDragImage.mockImplementationOnce(() => {
      throw new Error('drag image failed');
    });
    expect(() => start('B')).toThrow('drag image failed');
    expect(document.body.childElementCount).toBe(1);
    expect(view.dragging).toBeNull();
    expect(controller.plugin.getState(view.state)).toEqual({ status: 'idle' });
    start('C');
    drop(position('B'));
    expect(items(view.state.doc.child(0))).toEqual(['A', 'C', 'B']);
  });

  test('cleans up a failed drop dispatch without retaining an active drag', () => {
    const { view, start, position, controller } = setup('- A\n- B\n- C\n');
    start('C');
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: position('B'), inside: -1 });
    vi.spyOn(view, 'dispatch').mockImplementationOnce(() => {
      throw new Error('drop dispatch failed');
    });
    const event = new MouseEvent('drop', { cancelable: true });
    expect(() =>
      controller.plugin.props.handleDOMEvents?.drop?.call(controller.plugin, view, event),
    ).toThrow('drop dispatch failed');
    expect(document.body.childElementCount).toBe(1);
    expect(view.dragging).toBeNull();
    expect(controller.plugin.getState(view.state)).toEqual({ status: 'idle' });
  });

  test('ends the cancellation tombstone on dragend before a later external drop', () => {
    const { view, position, start, controller } = setup('- A\n- B\n- C\n');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    start('B');
    view.dispatch(view.state.tr.deleteRange(position('B'), position('C')));
    view.dispatch(view.state.tr.insertText('Updated ', position('A') + 2));
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      '[list-item-drag] drag canceled: source invalidated during drag',
    );
    document.dispatchEvent(new Event('dragend'));
    const event = new MouseEvent('drop', { cancelable: true });
    expect(
      controller.plugin.props.handleDOMEvents?.drop?.call(controller.plugin, view, event),
    ).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  test.each([
    ['bullet', '- A\n- B\n- C\n'],
    ['ordered', '1. A\n2. B\n3. C\n'],
    ['task', '- [ ] A\n- [x] B\n- [ ] C\n'],
  ])('reorders one %s item and undo restores it in one step', (_kind, input) => {
    const { view, start, drop, position } = setup(input);
    const before = view.state.doc;
    start('C');
    drop(position('B'));
    expect(items(view.state.doc.child(0))).toEqual(['A', 'C', 'B']);
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(view.state.doc.eq(before)).toBe(true);
  });

  test('persists sequential ordinals after reorder and preserves unrelated source numbering', () => {
    const { start, drop, position, serialize } = setup('1. A\n2. B\n3. C\n\nBreak\n\n7. X\n9. Y\n');
    start('C');
    drop(position('B'));
    expect(serialize()).toContain('1. A\n2. C\n3. B');
    expect(serialize()).toContain('7. X\n9. Y');
  });

  test('moves selected items together', () => {
    const { view, select, position, start, drop } = setup('- A\n- B\n- C\n- D\n');
    select(position('B') + 2, position('C') + 3);
    start('B');
    drop(position('A'));
    expect(items(view.state.doc.child(0))).toEqual(['B', 'C', 'A', 'D']);
  });

  test('ignores a selection that does not cover the hovered item', () => {
    const { view, select, position, start, drop } = setup('- A\n- B\n- C\n- D\n');
    select(position('A') + 2, position('B') + 3);
    start('D');
    drop(position('C'));
    expect(items(view.state.doc.child(0))).toEqual(['A', 'B', 'D', 'C']);
  });

  test.each([
    ['ordered', '4. A\n5. B\n6. C\n', true, null],
    ['task', '- [ ] A\n- [x] B\n- [ ] C\n', false, true],
  ])('preserves %s list kind and item state outside its list', (_kind, input, ordered, checked) => {
    const { view, start, drop, position } = setup(`${input}\nGap\n\nEnd\n`);
    start('B');
    drop(position('End', 'paragraph'));
    const moved = view.state.doc.child(2);
    expect(moved.type.name).toBe('list');
    expect(moved.attrs.ordered).toBe(ordered);
    expect(moved.firstChild?.attrs.checked).toBe(checked);
    expect(items(moved)).toEqual(['B']);
    expect(items(view.state.doc.child(0))).toEqual(['A', 'C']);
  });

  test('moves a whole selected list as one block', () => {
    const { view, start, drop, position, select } = setup('- A\n- B\n- C\n\nGap\n\nEnd\n');
    select(position('A') + 2, position('C') + 3);
    start('B');
    drop(position('End', 'paragraph'));
    expect(view.state.doc.firstChild?.textContent).toBe('Gap');
    expect(items(view.state.doc.child(1))).toEqual(['A', 'B', 'C']);
  });

  test('moves a selected list and adjacent paragraph together', () => {
    const { view, start, drop, position, select } = setup('- A\n- B\n\nIncluded\n\nGap\n\nEnd\n');
    select(position('A') + 2, position('Included', 'paragraph') + 4);
    start('A');
    drop(position('End', 'paragraph'));
    expect(view.state.doc.firstChild?.textContent).toBe('Gap');
    expect(items(view.state.doc.child(1))).toEqual(['A', 'B']);
    expect(view.state.doc.child(2).textContent).toBe('Included');
  });

  test.each([
    ['Gamma', 'listItem'],
    ['Included', 'paragraph'],
  ])(
    'moves only trailing selected items with the following paragraph using the %s grip',
    (gripText, gripType) => {
      const { view, start, drop, position, select } = setup(
        '1. Alpha\n2. Beta\n3. Gamma\n\nIncluded\n\nGap\n\nEnd\n',
      );
      select(position('Gamma') + 2, position('Included', 'paragraph') + 4);
      start(gripText, gripType);
      drop(position('End', 'paragraph'));
      expect(items(view.state.doc.child(0))).toEqual(['Alpha', 'Beta']);
      expect(view.state.doc.child(1).textContent).toBe('Gap');
      expect(items(view.state.doc.child(2))).toEqual(['Gamma']);
      expect(view.state.doc.child(2).child(0).attrs.sourceOrdinal).toBe(1);
      expect(view.state.doc.child(3).textContent).toBe('Included');
    },
  );

  test('moves a selected paragraph and only the leading selected items of the following list', () => {
    const { view, start, drop, position, select } = setup(
      'Included\n\n1. Alpha\n2. Beta\n3. Gamma\n\nGap\n\nEnd\n',
    );
    select(position('Included', 'paragraph') + 2, position('Beta') + 4);
    start('Beta');
    drop(position('End', 'paragraph'));
    expect(items(view.state.doc.child(0))).toEqual(['Gamma']);
    expect(view.state.doc.child(0).child(0).attrs.sourceOrdinal).toBe(1);
    expect(view.state.doc.child(1).textContent).toBe('Gap');
    expect(view.state.doc.child(2).textContent).toBe('Included');
    expect(items(view.state.doc.child(3))).toEqual(['Alpha', 'Beta']);
  });

  test.each([
    [
      'Child',
      'Included',
      'paragraph',
      '- Parent\n\nGap\n\n- Child\n- Sibling\n- Outer\n\nIncluded\n\nEnd\n',
    ],
    [
      'Sibling',
      'Included',
      'paragraph',
      '- Parent\n  - Child\n\nGap\n\n- Sibling\n- Outer\n\nIncluded\n\nEnd\n',
    ],
    [
      'Child',
      'Outer',
      'listItem',
      '- Parent\n\nIncluded\n\nGap\n\n- Child\n- Sibling\n- Outer\n\nEnd\n',
    ],
    [
      'Sibling',
      'Outer',
      'listItem',
      '- Parent\n  - Child\n\nIncluded\n\nGap\n\n- Sibling\n- Outer\n\nEnd\n',
    ],
  ])(
    'moves nested mixed selection from %s through %s without invalid wrappers',
    (fromText, toText, toType, expected) => {
      const { view, start, drop, position, select, serialize } = setup(
        '- Parent\n  - Child\n  - Sibling\n- Outer\n\nIncluded\n\nGap\n\nEnd\n',
      );
      select(position(fromText) + 2, position(toText, toType) + 4);
      start(fromText);
      const dragging = view.dragging;
      if (!dragging) throw new Error('Expected active drag');
      dragging.slice.content.forEach((node) => {
        node.check();
      });
      drop(position('End', 'paragraph'));
      expect(() => view.state.doc.check()).not.toThrow();
      const output = serialize();
      for (const token of ['Parent', 'Child', 'Sibling', 'Outer', 'Included', 'Gap', 'End']) {
        expect(output.split(token)).toHaveLength(2);
      }
      expect(output).toBe(expected);
      expect(markdown.serialize(markdown.parse(output))).toBe(expected);
      expect(view.state.doc.child(0).child(0).child(0).textContent).toBe('Parent');
      const movedList = view.state.doc.child(
        view.state.doc.childCount - (toText === 'Included' ? 3 : 2),
      );
      expect(items(movedList)).toEqual(
        fromText === 'Child' ? ['Child', 'Sibling', 'Outer'] : ['Sibling', 'Outer'],
      );
      if (fromText === 'Sibling') {
        expect(view.state.doc.child(0).child(0).lastChild?.textContent).toBe('Child');
      }
    },
  );

  test('moving to its own range is a no-op', () => {
    const { view, start, drop, position } = setup('- A\n- B\n- C\n');
    const before = view.state.doc;
    start('B');
    drop(position('B'));
    expect(view.state.doc.eq(before)).toBe(true);
  });

  test('moves nested children with their parent item', () => {
    const { view, start, drop, position } = setup('- A\n  - Child\n- B\n- C\n');
    start('AChild');
    drop(position('C') + view.state.doc.child(0).child(2).nodeSize);
    expect(items(view.state.doc.child(0))).toEqual(['B', 'C', 'AChild']);
    expect(view.state.doc.firstChild?.lastChild?.lastChild?.type.name).toBe('list');
  });

  test('moving the only item removes its empty source list without touching unrelated ordinals', () => {
    const { view, start, drop, position, serialize } = setup(
      '1. A\n\nSeparator\n\n7. X\n9. Y\n\nGap\n\nEnd\n',
    );
    start('A');
    drop(position('End', 'paragraph'));
    expect(items(view.state.doc.child(1))).toEqual(['X', 'Y']);
    expect(serialize()).toContain('7. X\n9. Y');
  });

  test('normalizes both ordered lists when moving between them', () => {
    const { view, start, drop, position, serialize } = setup(
      '1. A\n2. B\n3. C\n\nGap\n\n5. X\n6. Y\n',
    );
    start('B');
    drop(position('Y'));
    expect(items(view.state.doc.child(0))).toEqual(['A', 'C']);
    expect(items(view.state.doc.child(2))).toEqual(['X', 'B', 'Y']);
    expect(serialize()).toContain('1. A\n2. C');
    expect(serialize()).toContain('5. X\n6. B\n7. Y');
  });

  test('moves a nested child independently', () => {
    const { view, start, drop, position } = setup('- A\n  - Child\n  - Sibling\n- B\n- C\n');
    start('Child');
    drop(position('B'));
    expect(items(view.state.doc.child(0))).toEqual(['ASibling', 'Child', 'B', 'C']);
  });

  test('shows a block drop target outside the source list', () => {
    const { view, start, position } = setup('- A\n- B\n- C\n\nOutside\n');
    start('B');
    const dragging = view.dragging;
    if (!dragging) throw new Error('Expected active drag');
    const paragraph = position('Outside', 'paragraph');
    expect(dropPoint(view.state.doc, paragraph + 2, dragging.slice)).toBe(paragraph);
  });

  test('consumes a canceled drag after another edit deletes its source', () => {
    const { view, start, drop, position } = setup('- A\n- B\n- C\n');
    const fallbackDrop = vi.fn(() => false);
    view.setProps({ handleDrop: fallbackDrop });
    start('B');
    expect(document.body.childElementCount).toBe(2);
    view.dispatch(view.state.tr.deleteRange(position('B'), position('C')));
    expect(view.dragging).toBeNull();
    expect(document.body.childElementCount).toBe(1);
    drop(position('A'));
    expect(fallbackDrop).not.toHaveBeenCalled();
    expect(items(view.state.doc.child(0))).toEqual(['A', 'C']);
    start('C');
    drop(position('A'));
    expect(items(view.state.doc.child(0))).toEqual(['C', 'A']);
  });

  test('moves current content when the dragged item changes during the drag', () => {
    const { view, start, drop, position } = setup('- A\n- B\n- C\n');
    start('C');
    view.dispatch(view.state.tr.insertText(' updated', position('C') + 3));
    drop(position('B'));
    expect(items(view.state.doc.child(0))).toEqual(['A', 'C updated', 'B']);
  });

  test('maps the source range across edits arriving during the drag', () => {
    const { view, start, drop, position } = setup('- A\n- B\n- C\n');
    start('C');
    view.dispatch(view.state.tr.insertText(' changed', position('A') + 3));
    drop(position('B'));
    expect(items(view.state.doc.child(0))).toEqual(['A changed', 'C', 'B']);
  });
});
