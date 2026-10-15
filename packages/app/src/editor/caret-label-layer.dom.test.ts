import { Schema } from '@tiptap/pm/model';
import { EditorState, Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, EditorView } from '@tiptap/pm/view';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { attachCaretLabel, caretLabelLayerPlugin } from './caret-label-layer.ts';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', toDOM: () => ['p', 0] },
    text: {},
  },
});

const remoteCaretKey = new PluginKey<number | null>('remoteCaret');

function remoteCaret(name: string): HTMLElement {
  const caret = document.createElement('span');
  caret.className = 'collaboration-cursor__caret';
  const label = document.createElement('div');
  label.className = 'collaboration-cursor__label';
  label.textContent = name;
  attachCaretLabel(caret, label);
  return caret;
}

function remoteCaretPlugin(): Plugin<number | null> {
  return new Plugin<number | null>({
    key: remoteCaretKey,
    state: {
      init: () => 1,
      apply: (tr, value) => {
        const next = tr.getMeta(remoteCaretKey) as number | null | undefined;
        return next === undefined ? value : next;
      },
    },
    props: {
      decorations(state) {
        const pos = remoteCaretKey.getState(state);
        if (pos == null) return DecorationSet.empty;
        return DecorationSet.create(state.doc, [
          Decoration.widget(pos, () => remoteCaret('Omar'), { key: `caret-${pos}` }),
        ]);
      },
    },
  });
}

function mountEditor(): { view: EditorView; host: HTMLElement } {
  const host = document.createElement('div');
  document.body.append(host);
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('Action Owner Admin')]),
  ]);
  const view = new EditorView(host, {
    state: EditorState.create({ doc, plugins: [remoteCaretPlugin(), caretLabelLayerPlugin()] }),
  });
  return { view, host };
}

function moveRemoteCaret(view: EditorView, pos: number | null): void {
  view.dispatch(view.state.tr.setMeta(remoteCaretKey, pos));
}

function stubResizeObserver(): (target: Element) => void {
  const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly entry: { callback: ResizeObserverCallback; targets: Set<Element> };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: new Set() };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.add(target);
      }
      unobserve(target: Element) {
        this.entry.targets.delete(target);
      }
      disconnect() {
        this.entry.targets.clear();
      }
    },
  );
  return (target) => {
    for (const { callback, targets } of observers) {
      if (targets.has(target)) callback([], {} as ResizeObserver);
    }
  };
}

function labels(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.collaboration-cursor__label'));
}

describe('caret label layer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  test('renders the label beside the document, never inside it', () => {
    const { view, host } = mountEditor();

    const [label] = labels();
    expect(label?.textContent).toBe('Omar');
    expect(view.dom.contains(label ?? null)).toBe(false);
    expect(label?.parentElement?.parentElement).toBe(host);
    expect(view.dom.querySelectorAll('.collaboration-cursor__caret')).toHaveLength(1);
    view.destroy();
  });

  test('keeps one label per live caret and drops it when the caret leaves', () => {
    const { view } = mountEditor();

    moveRemoteCaret(view, 7);
    expect(labels()).toHaveLength(1);

    moveRemoteCaret(view, null);
    expect(labels()).toHaveLength(0);
    view.destroy();
  });

  test('follows the document when it moves to a new parent, never entering the document', () => {
    const { view, host } = mountEditor();
    const nextHost = document.createElement('div');
    document.body.append(nextHost);

    nextHost.append(view.dom);
    moveRemoteCaret(view, 7);

    const layer = nextHost.querySelector('.collaboration-cursor__label-layer');
    expect(layer?.parentElement).toBe(nextHost);
    expect(host.querySelector('.collaboration-cursor__label-layer')).toBeNull();
    expect(view.dom.querySelector('.collaboration-cursor__label-layer')).toBeNull();
    expect(labels()).toHaveLength(1);
    view.destroy();
  });

  test('follows the document when it is re-attached without a transaction', () => {
    const resize = stubResizeObserver();
    const { view, host } = mountEditor();
    const nextHost = document.createElement('div');
    document.body.append(nextHost);

    nextHost.append(view.dom);
    resize(view.dom);

    expect(nextHost.querySelector('.collaboration-cursor__label-layer')?.parentElement).toBe(
      nextHost,
    );
    expect(host.querySelector('.collaboration-cursor__label-layer')).toBeNull();
    expect(labels()).toHaveLength(1);
    view.destroy();
  });

  test('removes the layer and its labels when the editor is destroyed', () => {
    const { view, host } = mountEditor();

    view.destroy();
    expect(labels()).toHaveLength(0);
    expect(host.querySelector('.collaboration-cursor__label-layer')).toBeNull();
  });
});
