import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { describe, expect, test, vi } from 'vitest';
import { OPT_OUT_ATTR } from '../clipboard/index.ts';
import {
  appendTrailingParagraph,
  docNeedsTrailingAffordance,
  OK_TRAILING_AFFORDANCE_CLASS,
  renderHint,
  trailingAffordanceKey,
  trailingAffordancePlugin,
} from './trailing-affordance.ts';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*' },
    codeBlock: { group: 'block', content: 'text*' },
    table: { group: 'block', content: 'block*' },
    list: { group: 'block', content: 'listItem+' },
    listItem: { content: 'paragraph+' },
    thematicBreak: { group: 'block' },
    text: { group: 'inline' },
  },
  marks: {},
});

function tailNode(lastType: string) {
  if (lastType === 'table') {
    return schema.node('table', null, [schema.node('paragraph', null, [schema.text('cell')])]);
  }
  if (lastType === 'list') {
    return schema.node('list', null, [
      schema.node('listItem', null, [schema.node('paragraph', null, [schema.text('item')])]),
    ]);
  }
  if (lastType === 'thematicBreak') return schema.node('thematicBreak');
  return schema.node(lastType, null, [schema.text('tail')]);
}

function stateEndingIn(lastType: string): EditorState {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('body')]),
    tailNode(lastType),
  ]);
  return EditorState.create({ doc, plugins: [trailingAffordancePlugin()] });
}

function hover(state: EditorState, next: boolean): EditorState {
  return state.apply(state.tr.setMeta(trailingAffordanceKey, next));
}

function selecting(state: EditorState): EditorState {
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 5)));
}

function decorationsOf(state: EditorState) {
  const plugin = state.plugins.find((p) => p.spec.key === trailingAffordanceKey);
  expect(plugin).toBeDefined();
  return plugin?.props.decorations?.call(plugin, state) ?? null;
}

describe('docNeedsTrailingAffordance', () => {
  test.each([
    'table',
    'heading',
    'codeBlock',
    'list',
    'thematicBreak',
  ])('engages when the last block is a %s — nothing can host a caret below it', (type) => {
    expect(docNeedsTrailingAffordance(stateEndingIn(type).doc)).toBe(true);
  });

  test('stands down when the last block is a paragraph', () => {
    expect(docNeedsTrailingAffordance(stateEndingIn('paragraph').doc)).toBe(false);
  });
});

describe('docNeedsTrailingAffordance against the production schema', () => {
  const markdown = new MarkdownManager({ extensions: sharedExtensions });
  const prodSchema = getSchema(sharedExtensions);

  function docFrom(src: string) {
    return prodSchema.nodeFromJSON(markdown.parse(src));
  }

  test.each([
    ['a table', '| a |\n| - |\n| b |', 'table'],
    ['a heading', 'body\n\n## H', 'heading'],
    ['a fenced code block', 'body\n\n```js\nx\n```', 'codeBlock'],
    ['a bullet list', 'body\n\n- item', 'list'],
    ['an ordered list', 'body\n\n1. item', 'list'],
    ['a thematic break', 'body\n\n---', 'thematicBreak'],
    ['a blockquote', 'body\n\n> quoted', 'blockquote'],
    ['an HTML comment', 'body\n\n<!-- note -->', 'commentBlock'],
    ['a footnote definition', 'body[^1]\n\n[^1]: note', 'footnoteDefinition'],
    ['a link reference definition', 'body\n\n[a]: http://example.com', 'linkRefDef'],
  ])('engages when the document ends in %s', (_label, src, expectedType) => {
    const doc = docFrom(src);
    expect(doc.lastChild?.type.name).toBe(expectedType);
    expect(docNeedsTrailingAffordance(doc)).toBe(true);
  });

  test('stands down when real markdown ends in a paragraph', () => {
    const doc = docFrom('body\n\ntail');
    expect(doc.lastChild?.type.name).toBe('paragraph');
    expect(docNeedsTrailingAffordance(doc)).toBe(false);
  });
});

describe('hint decoration', () => {
  test('is absent until the pointer enters the zone', () => {
    expect(decorationsOf(stateEndingIn('table'))).toBeNull();
  });

  test('appears at the end of the document while hovered', () => {
    const state = hover(stateEndingIn('table'), true);
    const set = decorationsOf(state);
    const found = set?.find() ?? [];
    expect(found).toHaveLength(1);
    expect(found[0]?.from).toBe(state.doc.content.size);
  });

  test('stays absent while hovered when the last block is a paragraph', () => {
    expect(decorationsOf(hover(stateEndingIn('paragraph'), true))).toBeNull();
  });

  test('disappears again when the pointer leaves', () => {
    const state = hover(hover(stateEndingIn('table'), true), false);
    expect(decorationsOf(state)).toBeNull();
  });

  test('hovering does not change the document', () => {
    const before = stateEndingIn('table');
    const after = hover(before, true);
    expect(after.doc.eq(before.doc)).toBe(true);
  });
});

describe('renderHint', () => {
  test('is inert chrome — non-editable, hidden from AT, omitted from copies', () => {
    const el = renderHint();
    expect(el.classList.contains(OK_TRAILING_AFFORDANCE_CLASS)).toBe(true);
    expect(el.getAttribute('contenteditable')).toBe('false');
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.getAttribute(OPT_OUT_ATTR)).toBe('true');
  });

  test('renders a single plus glyph', () => {
    const el = renderHint();
    const plus = el.querySelector(`.${OK_TRAILING_AFFORDANCE_CLASS}-plus`);
    expect(plus).not.toBeNull();
    expect(plus?.querySelector('svg')).not.toBeNull();
  });
});

describe('appendTrailingParagraph', () => {
  function stubView(state: EditorState) {
    const focus = vi.fn();
    const view = {
      state,
      focus,
      dispatch: (tr: unknown) => {
        view.state = view.state.apply(tr as never);
      },
    };
    return { view, focus };
  }

  test('adds one empty paragraph at the end and puts the caret in it', () => {
    const { view, focus } = stubView(stateEndingIn('table'));
    appendTrailingParagraph(view as unknown as EditorView);

    const last = view.state.doc.lastChild;
    expect(last?.type.name).toBe('paragraph');
    expect(last?.textContent).toBe('');
    expect(view.state.doc.childCount).toBe(3);
    expect(view.state.selection.$head.parent).toBe(last);
    expect(focus).toHaveBeenCalled();
  });

  test('the inserted paragraph retires the hint', () => {
    const { view } = stubView(hover(stateEndingIn('table'), true));
    appendTrailingParagraph(view as unknown as EditorView);
    expect(docNeedsTrailingAffordance(view.state.doc)).toBe(false);
  });
});

describe('trailing zone interaction', () => {
  const LAST_BLOCK_BOTTOM = 100;
  const EDITOR_BOX = { top: 0, bottom: 400, left: 40, right: 800 };
  const IN_ZONE = { clientX: 400, clientY: 200 };
  const ABOVE_ZONE = { clientX: 400, clientY: 50 };

  function rect(box: Partial<DOMRect>): DOMRect {
    return { top: 0, bottom: 0, left: 0, right: 0, ...box } as DOMRect;
  }

  function stubView(
    state: EditorState,
    { editable = true, withHint = false }: { editable?: boolean; withHint?: boolean } = {},
  ) {
    const dom = document.createElement('div');
    const block = document.createElement('p');
    block.getBoundingClientRect = () => rect({ bottom: LAST_BLOCK_BOTTOM });
    dom.append(block);
    if (withHint) {
      const hint = renderHint();
      hint.getBoundingClientRect = () => rect({ bottom: EDITOR_BOX.bottom });
      dom.append(hint);
    }
    dom.getBoundingClientRect = () => rect(EDITOR_BOX);

    const lastBlockPos = state.doc.content.size - (state.doc.lastChild?.nodeSize ?? 0);

    const view = {
      state,
      dom,
      editable,
      focus: vi.fn(),
      nodeDOM(pos: number) {
        return pos === lastBlockPos ? block : null;
      },
      dispatch(tr: unknown) {
        view.state = view.state.apply(tr as never);
      },
    };
    return view;
  }

  type EventName = 'mousemove' | 'mouseleave' | 'pointerdown' | 'pointerup' | 'pointercancel';

  function fire(
    view: ReturnType<typeof stubView>,
    type: EventName,
    init: MouseEventInit & { pointerId?: number },
    target?: Element,
  ) {
    const plugin = view.state.plugins.find((p) => p.spec.key === trailingAffordanceKey);
    const handler = plugin?.props.handleDOMEvents?.[type];
    expect(handler).toBeDefined();
    const { pointerId, ...mouseInit } = init;
    const event = new MouseEvent(type, { button: 0, cancelable: true, ...mouseInit });
    if (pointerId !== undefined) Object.defineProperty(event, 'pointerId', { value: pointerId });
    if (target) Object.defineProperty(event, 'target', { value: target });
    const handled = handler?.call(plugin, view as unknown as EditorView, event);
    return { handled, event };
  }

  function click(
    view: ReturnType<typeof stubView>,
    at: MouseEventInit & { pointerId?: number },
    target?: Element,
  ) {
    fire(view, 'pointerdown', at, target);
    return fire(view, 'pointerup', at, target);
  }

  function glyphIn(view: ReturnType<typeof stubView>): Element {
    const glyph = view.dom.querySelector(`.${OK_TRAILING_AFFORDANCE_CLASS}-plus`);
    expect(glyph).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above.
    return glyph!;
  }

  test('a primary click below the last block authors the paragraph', () => {
    const view = stubView(stateEndingIn('table'));
    const { handled, event } = click(view, { ...IN_ZONE });

    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.childCount).toBe(3);
    expect(view.state.doc.lastChild?.type.name).toBe('paragraph');
  });

  test('the press itself claims nothing', () => {
    const view = stubView(stateEndingIn('table'));
    const { handled, event } = fire(view, 'pointerdown', { ...IN_ZONE });

    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(view.state.doc.childCount).toBe(2);
  });

  test('a press that travels far enough to be a drag authors nothing', () => {
    const view = stubView(stateEndingIn('table'));
    fire(view, 'pointerdown', { ...IN_ZONE });
    const { handled } = fire(view, 'pointerup', {
      clientX: IN_ZONE.clientX,
      clientY: IN_ZONE.clientY + 60,
    });

    expect(handled).toBe(false);
    expect(view.state.doc.childCount).toBe(2);
  });

  test('a press cancelled mid-gesture authors nothing on the next release', () => {
    const view = stubView(stateEndingIn('table'));
    fire(view, 'pointerdown', { ...IN_ZONE });
    fire(view, 'pointercancel', { ...IN_ZONE });

    expect(fire(view, 'pointerup', { ...IN_ZONE }).handled).toBe(false);
    expect(view.state.doc.childCount).toBe(2);
  });

  test('a press outside the zone is not redeemed by releasing inside it', () => {
    const view = stubView(stateEndingIn('table'));
    fire(view, 'pointerdown', { ...ABOVE_ZONE });

    expect(fire(view, 'pointerup', { ...IN_ZONE }).handled).toBe(false);
    expect(view.state.doc.childCount).toBe(2);
  });

  test("a second contact in the zone does not drop the first finger's press", () => {
    const view = stubView(stateEndingIn('table'));
    fire(view, 'pointerdown', { ...IN_ZONE, pointerId: 1 });
    fire(view, 'pointerdown', { ...IN_ZONE, pointerId: 2 });

    expect(fire(view, 'pointerup', { ...IN_ZONE, pointerId: 1 }).handled).toBe(true);
    expect(view.state.doc.childCount).toBe(3);
  });

  test('a second contact in the zone cannot redeem a tap of its own', () => {
    const view = stubView(stateEndingIn('table'));
    const palm = { ...IN_ZONE, pointerId: 2 };
    fire(view, 'pointerdown', { ...IN_ZONE, pointerId: 1 });
    fire(view, 'pointerdown', palm);

    expect(fire(view, 'pointerup', palm).handled).toBe(false);
    expect(view.state.doc.childCount).toBe(2);
  });

  test('the contact that lands second cannot author, even when it is the real one', () => {
    const view = stubView(stateEndingIn('table'));
    const inZonePalm = { ...IN_ZONE, pointerId: 2 };
    fire(view, 'pointerdown', inZonePalm);
    fire(view, 'pointerdown', { ...IN_ZONE, pointerId: 1 });

    expect(fire(view, 'pointerup', { ...IN_ZONE, pointerId: 1 }).handled).toBe(false);
    expect(view.state.doc.childCount).toBe(2);
  });

  test("another pointer's cancel does not end this press", () => {
    const view = stubView(stateEndingIn('table'));
    fire(view, 'pointerdown', { ...IN_ZONE, pointerId: 1 });
    fire(view, 'pointercancel', { ...IN_ZONE, pointerId: 2 });

    expect(fire(view, 'pointerup', { ...IN_ZONE, pointerId: 1 }).handled).toBe(true);
    expect(view.state.doc.childCount).toBe(3);
  });

  test('a release from a pointer that never pressed authors nothing', () => {
    const view = stubView(stateEndingIn('table'));
    fire(view, 'pointerdown', { ...IN_ZONE, pointerId: 1 });

    expect(fire(view, 'pointerup', { ...IN_ZONE, pointerId: 2 }).handled).toBe(false);
    expect(view.state.doc.childCount).toBe(2);
  });

  test('a click that ends a selection leaves the selection to ProseMirror', () => {
    const view = stubView(selecting(stateEndingIn('table')));
    expect(click(view, { ...IN_ZONE }).handled).toBe(false);
    expect(view.state.doc.childCount).toBe(2);
  });

  test('the hint does not raise the zone floor onto itself', () => {
    const view = stubView(hover(stateEndingIn('table'), true), { withHint: true });
    expect(click(view, { ...IN_ZONE }).handled).toBe(true);
    expect(view.state.doc.childCount).toBe(3);
  });

  test.each([
    ['a secondary click', { button: 2 }],
    ['a middle click', { button: 1 }],
    ['a ctrl-click', { button: 0, ctrlKey: true }],
  ])('%s is left alone — the document is not touched and the event survives', (_label, init) => {
    const view = stubView(stateEndingIn('table'));
    const { handled, event } = click(view, { ...IN_ZONE, ...init });

    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(view.state.doc.childCount).toBe(2);
  });

  test.each([
    ['above the last block', ABOVE_ZONE],
    ['below the editor', { clientX: 400, clientY: 900 }],
    ['left of the editor', { clientX: 10, clientY: 200 }],
    ['right of the editor', { clientX: 1200, clientY: 200 }],
  ])('a click %s is outside the zone', (_label, at) => {
    const view = stubView(stateEndingIn('table'));
    expect(click(view, at).handled).toBe(false);
    expect(view.state.doc.childCount).toBe(2);
  });

  test('a read-only view never authors anything', () => {
    const view = stubView(stateEndingIn('table'), { editable: false });
    expect(click(view, { ...IN_ZONE }).handled).toBe(false);
    expect(view.state.doc.childCount).toBe(2);
  });

  test('a document already ending in a paragraph is left to ProseMirror', () => {
    const view = stubView(stateEndingIn('paragraph'));
    expect(click(view, { ...IN_ZONE }).handled).toBe(false);
    expect(view.state.doc.childCount).toBe(2);
  });

  test('moving into and out of the zone toggles the hint without claiming the event', () => {
    const view = stubView(stateEndingIn('table'));

    expect(fire(view, 'mousemove', { ...IN_ZONE }).handled).toBe(false);
    expect(trailingAffordanceKey.getState(view.state)).toBe(true);

    expect(fire(view, 'mousemove', { ...ABOVE_ZONE }).handled).toBe(false);
    expect(trailingAffordanceKey.getState(view.state)).toBe(false);
  });

  test('the glyph is in the zone even where the coordinates are not', () => {
    const view = stubView(hover(stateEndingIn('table'), true), { withHint: true });
    const outsideLeft = { clientX: EDITOR_BOX.left - 12, clientY: 200 };

    expect(fire(view, 'mousemove', outsideLeft, glyphIn(view)).handled).toBe(false);
    expect(trailingAffordanceKey.getState(view.state)).toBe(true);

    expect(click(view, outsideLeft, glyphIn(view)).handled).toBe(true);
    expect(view.state.doc.childCount).toBe(3);
    expect(view.state.doc.lastChild?.type.name).toBe('paragraph');
  });

  test("the composer's reserved band is not part of the zone", () => {
    const view = stubView(stateEndingIn('table'));
    view.dom.style.setProperty('--ask-composer-height', '200px');

    const underComposer = { clientX: 400, clientY: EDITOR_BOX.bottom - 100 };
    expect(click(view, underComposer).handled).toBe(false);
    expect(view.state.doc.childCount).toBe(2);

    expect(click(view, { ...IN_ZONE }).handled).toBe(true);
  });

  test('the click retires the hint it was rendered for', () => {
    const view = stubView(hover(stateEndingIn('table'), true), { withHint: true });
    click(view, { ...IN_ZONE });
    expect(trailingAffordanceKey.getState(view.state)).toBe(false);
  });

  describe('on a coarse pointer', () => {
    function coarse() {
      const spy = vi
        .spyOn(window, 'matchMedia')
        .mockImplementation((query) => ({ matches: query.includes('coarse') }) as MediaQueryList);
      return spy;
    }

    test('a synthesized mousemove outside the zone does not retire the hint', () => {
      const spy = coarse();
      try {
        const view = stubView(hover(stateEndingIn('table'), true), { withHint: true });
        expect(fire(view, 'mousemove', { ...ABOVE_ZONE }).handled).toBe(false);
        expect(trailingAffordanceKey.getState(view.state)).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    test('mouseleave does not retire the hint', () => {
      const spy = coarse();
      try {
        const view = stubView(hover(stateEndingIn('table'), true), { withHint: true });
        expect(fire(view, 'mouseleave', {}).handled).toBe(false);
        expect(trailingAffordanceKey.getState(view.state)).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    test('a tap authors the paragraph and leaves the hint pinned', () => {
      const spy = coarse();
      try {
        const view = stubView(hover(stateEndingIn('table'), true), { withHint: true });
        expect(click(view, { ...IN_ZONE }).handled).toBe(true);
        expect(view.state.doc.lastChild?.type.name).toBe('paragraph');
        expect(trailingAffordanceKey.getState(view.state)).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe('plugin view lifecycle', () => {
  function stubMedia(matches: boolean) {
    const listeners = new Set<() => void>();
    const mql = {
      matches,
      addEventListener: (_type: string, fn: () => void) => {
        listeners.add(fn);
      },
      removeEventListener: (_type: string, fn: () => void) => {
        listeners.delete(fn);
      },
    };
    return {
      mql,
      listenerCount: () => listeners.size,
      change(next: boolean) {
        mql.matches = next;
        for (const fn of listeners) fn();
      },
    };
  }

  function harness(matches: boolean, { editable = true } = {}) {
    const media = stubMedia(matches);
    const spy = vi
      .spyOn(window, 'matchMedia')
      .mockImplementation(() => media.mql as unknown as MediaQueryList);
    const state = stateEndingIn('table');
    const view = {
      state,
      dom: document.createElement('div'),
      editable,
      dispatch(tr: unknown) {
        view.state = view.state.apply(tr as never);
      },
    };
    const plugin = state.plugins.find((p) => p.spec.key === trailingAffordanceKey);
    expect(plugin?.spec.view).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted defined above.
    const handle = plugin!.spec.view!(view as unknown as EditorView);
    return {
      media,
      handle,
      view,
      pinned: () => trailingAffordanceKey.getState(view.state),
      restore: () => spy.mockRestore(),
    };
  }

  test('pins the hint on a coarse pointer once the initial microtask flushes', async () => {
    const h = harness(true);
    try {
      expect(h.pinned()).toBe(false);
      await Promise.resolve();
      expect(h.pinned()).toBe(true);
    } finally {
      h.handle?.destroy?.();
      h.restore();
    }
  });

  test('leaves a read-only coarse view unpinned, and undecorated', async () => {
    const h = harness(true, { editable: false });
    try {
      await Promise.resolve();
      expect(h.pinned()).toBe(false);
      expect(decorationsOf(h.view.state)).toBeNull();
    } finally {
      h.handle?.destroy?.();
      h.restore();
    }
  });

  test('re-asks when the pointer type changes under it', async () => {
    const h = harness(false);
    try {
      await Promise.resolve();
      expect(h.pinned()).toBe(false);
      h.media.change(true);
      expect(h.pinned()).toBe(true);
    } finally {
      h.handle?.destroy?.();
      h.restore();
    }
  });

  test('re-asks when the view flips out of editable', async () => {
    const h = harness(true);
    try {
      await Promise.resolve();
      expect(h.pinned()).toBe(true);
      h.view.editable = false;
      h.handle?.update?.(h.view as unknown as EditorView, h.view.state);
      expect(h.pinned()).toBe(false);
    } finally {
      h.handle?.destroy?.();
      h.restore();
    }
  });

  test('does not re-ask on an update that left editability alone', async () => {
    const h = harness(false);
    try {
      await Promise.resolve();
      h.view.state = hover(h.view.state, true);
      h.handle?.update?.(h.view as unknown as EditorView, h.view.state);
      expect(h.pinned()).toBe(true);
    } finally {
      h.handle?.destroy?.();
      h.restore();
    }
  });

  test('drops the media listener on destroy', async () => {
    const h = harness(false);
    try {
      await Promise.resolve();
      expect(h.media.listenerCount()).toBe(1);
      h.handle?.destroy?.();
      expect(h.media.listenerCount()).toBe(0);
      h.media.change(true);
      expect(h.pinned()).toBe(false);
    } finally {
      h.restore();
    }
  });
});
