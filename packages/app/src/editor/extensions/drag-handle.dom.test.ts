import type { VirtualElement } from '@floating-ui/dom';
import { type Node as PmNode, Schema } from '@tiptap/pm/model';
import { EditorState, Plugin } from '@tiptap/pm/state';
import { EditorView } from '@tiptap/pm/view';
import { beforeEach, describe, expect, test, vi } from 'vitest';

type NodeChange = (arg: { node: PmNode | null; pos: number }) => void;

type PluginOptions = {
  element: HTMLElement;
  onNodeChange: NodeChange;
  getReferencedVirtualElement?: () => VirtualElement | null;
  onElementDragEnd?: () => void;
};

let captured: PluginOptions | null = null;
const upstreamMove = vi.fn();

vi.mock('@tiptap/extension-drag-handle', () => ({
  DragHandlePlugin: (options: PluginOptions) => {
    captured = options;
    return { plugin: new Plugin({ props: { handleDOMEvents: { mousemove: upstreamMove } } }) };
  },
  normalizeNestedOptions: () => ({}),
}));

const { BlockDragHandle, blockDragHoverKey } = await import('./drag-handle.ts');

type TestEditor = {
  view: Pick<EditorView, 'nodeDOM' | 'state' | 'dispatch'>;
  on: typeof import('@tiptap/core').Editor.prototype.on;
};

function mountControls({ view }: { view?: Partial<TestEditor['view']> } = {}) {
  const editor: TestEditor = {
    on: vi.fn(),
    view: {
      nodeDOM: view?.nodeDOM?.bind(view) ?? (() => null),
      state: view?.state ?? EditorState.create({ schema }),
      dispatch: view?.dispatch?.bind(view) ?? vi.fn(),
    },
  };
  captured = null;
  const build = BlockDragHandle.config.addProseMirrorPlugins as (this: {
    editor: TestEditor;
  }) => Plugin[];
  const plugins = build.call({ editor });
  const hover = plugins.find((plugin) => plugin.spec.key === blockDragHoverKey);
  if (!hover) throw new Error('Block hover plugin was never constructed');
  if (!captured) throw new Error('DragHandlePlugin was never constructed');
  const { element, onNodeChange, getReferencedVirtualElement, onElementDragEnd } = captured;
  const addBtn = element.querySelector('.ok-add-block-btn');
  const grip = element.querySelector('.ok-drag-grip');
  if (!(addBtn instanceof HTMLElement) || !(grip instanceof HTMLElement)) {
    throw new Error('block controls are missing a button');
  }
  return {
    addBtn,
    grip,
    fire: onNodeChange,
    reference: () => getReferencedVirtualElement?.() ?? null,
    endDrag: () => onElementDragEnd?.(),
    element,
    hover,
  };
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

  test('list items have a human-readable accessible name', () => {
    controls.fire({ node: listItem(), pos: 1 });
    expect(controls.grip.getAttribute('aria-label')).toBe('Select list item');
  });
});

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0] },
    list: { group: 'block', content: 'listItem+' },
    listItem: { content: 'paragraph' },
    text: {},
  },
});

describe('list item handle reachability', () => {
  test('keeps the nested target while crossing its first-line gutter, then releases other rows', () => {
    const view = new EditorView(document.createElement('div'), {
      state: EditorState.create({ schema }),
    });
    try {
      const item = document.createElement('li');
      vi.spyOn(view, 'nodeDOM').mockReturnValue(item);
      vi.spyOn(item, 'getBoundingClientRect').mockReturnValue(new DOMRect(180, 100, 400, 100));
      const controls = mountControls({ view });
      controls.fire({ node: listItem(), pos: 1 });
      controls.element.style.visibility = '';
      vi.spyOn(controls.element, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(100, 104, 42, 20),
      );
      const events = controls.hover.props.handleDOMEvents;
      const move = (x: number, y: number) =>
        events?.mousemove?.call(
          controls.hover,
          view,
          new MouseEvent('mousemove', { clientX: x, clientY: y, shiftKey: true }),
        );
      upstreamMove.mockClear();
      expect(move(150, 114)).toBe(true);
      expect(upstreamMove).toHaveBeenCalledWith(
        view,
        expect.objectContaining({ clientX: 182, clientY: 114, shiftKey: true }),
      );
      expect(move(150, 145)).toBe(false);
      expect(move(90, 114)).toBe(false);
      expect(move(200, 114)).toBe(false);
      expect(upstreamMove).toHaveBeenCalledTimes(1);
      expect(
        events?.mouseleave?.call(
          controls.hover,
          view,
          new MouseEvent('mouseleave', { clientX: 150, clientY: 114 }),
        ),
      ).toBe(true);
      controls.element.style.visibility = 'hidden';
      expect(move(150, 114)).toBe(false);
    } finally {
      view.destroy();
    }
  });

  test('clears the remembered upstream target when a native drag finishes', () => {
    const state = EditorState.create({ schema });
    const dispatch = vi.fn();
    const controls = mountControls({ view: { state, dispatch } });
    controls.endDrag();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].getMeta('hideDragHandle')).toBe(true);
  });

  test('invalidates a hovered target on document edits but keeps selection-only changes', () => {
    const controls = mountControls();
    controls.fire({ node: listItem(), pos: 1 });
    const state = EditorState.create({ schema, plugins: [controls.hover] });
    expect(state.applyTransaction(state.tr).transactions).toHaveLength(1);
    const edited = state.applyTransaction(state.tr.insertText('Edited', 1));
    expect(edited.transactions).toHaveLength(2);
    expect(edited.transactions[1].getMeta('hideDragHandle')).toBe(true);
    expect(edited.state.doc.textContent).toBe('Edited');
    controls.fire({ node: null, pos: -1 });
    expect(state.applyTransaction(state.tr.insertText('Next', 1)).transactions).toHaveLength(1);
  });
});

function listItem() {
  return schema.nodes.listItem.create(
    null,
    schema.nodes.paragraph.create(null, schema.text('Item')),
  );
}

describe('list item gutter positioning', () => {
  test.each([
    ['ul', 24],
    ['ol', 40],
    ['ul', 0],
  ])('anchors %s with %s pixels of marker padding to the list gutter', (tag, padding) => {
    const list = document.createElement(tag);
    const item = document.createElement('li');
    list.appendChild(item);
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 400, 200));
    vi.spyOn(item, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(100 + padding, 128, 400 - padding, 28),
    );
    const controls = mountControls({ view: { nodeDOM: () => item } });
    controls.fire({ node: listItem(), pos: 1 });
    const bounds = controls.reference()?.getBoundingClientRect();
    expect(bounds).toMatchObject({ left: 100, right: 500, top: 128, height: 28 });
  });

  test('uses the immediate nested list gutter and retains the hovered item height', () => {
    const outer = document.createElement('ol');
    const parent = document.createElement('li');
    const nested = document.createElement('ul');
    const item = document.createElement('li');
    outer.appendChild(parent);
    parent.appendChild(nested);
    nested.appendChild(item);
    vi.spyOn(outer, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 400, 300));
    vi.spyOn(nested, 'getBoundingClientRect').mockReturnValue(new DOMRect(140, 128, 360, 200));
    vi.spyOn(item, 'getBoundingClientRect').mockReturnValue(new DOMRect(164, 156, 336, 84));
    const controls = mountControls({ view: { nodeDOM: () => item } });
    controls.fire({ node: listItem(), pos: 5 });
    expect(controls.reference()?.getBoundingClientRect()).toMatchObject({
      left: 140,
      top: 156,
      height: 84,
    });
  });

  test('keeps the existing native anchor for paragraphs', () => {
    const nodeDOM = vi.fn();
    const controls = mountControls({ view: { nodeDOM } });
    controls.fire({ node: schema.nodes.paragraph.create(), pos: 0 });
    expect(controls.reference()).toBeNull();
    expect(nodeDOM).not.toHaveBeenCalled();
  });
});
