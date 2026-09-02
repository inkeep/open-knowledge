import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const RETRY_MS = 80;
const REVEAL_WAIT_MS = 10_000;
const SETTLE_MS = 1_500;

interface FakeEditor {
  state: { doc: { text: string; content: { size: number } } };
  isDestroyed: boolean;
}

function makeEditor(text: string): FakeEditor {
  const doc = {
    text,
    content: {
      get size() {
        return doc.text.length;
      },
    },
  };
  return { state: { doc }, isDestroyed: false };
}

let editor: FakeEditor | null = null;
let editorVisible = true;
let registryListeners: Set<() => void>;
const captured = {
  scrolled: 0,
  opened: [] as string[],
  focused: [] as string[],
};

vi.doMock('@/components/doc-panel-events', () => ({ requestDocPanelTab: () => {} }));

let scrollAllowed = true;
let displaced = true;
vi.doMock('./scroll-to-anchor', () => ({
  scrollAnchorIntoView: () => {
    if (!scrollAllowed) return false;
    if (displaced) {
      captured.scrolled += 1;
      displaced = false;
    }
    return true;
  },
}));

vi.doMock('./anchor-search', () => ({
  findQuoteRange: (doc: { text: string }, quote: string) => {
    if (quote.length === 0) return null;
    const at = doc.text.indexOf(quote);
    return at === -1 ? null : { from: at, to: at + quote.length };
  },
}));

vi.doMock('@/editor/active-editor', () => ({
  getVisibleEditorForDoc: () => (editorVisible ? editor : null),
  subscribeEditorRegistry: (listener: () => void) => {
    registryListeners.add(listener);
    return () => registryListeners.delete(listener);
  },
}));

vi.doMock('./store', () => ({
  emitFocusThread: (id: string) => captured.focused.push(id),
  emitOpenThread: (id: string) => captured.opened.push(id),
}));

const toasted: string[] = [];
vi.doMock('sonner', () => ({
  toast: { error: (message: string) => toasted.push(message) },
}));

const { revealComment } = await import('./reveal-comment');

function reveal() {
  revealComment({ docName: 'recipes/stir-fry', quote: 'the tofu', threadId: 't1' });
}

function contentArrives() {
  if (editor) editor.state.doc.text = 'press the tofu first';
}

beforeEach(() => {
  vi.useFakeTimers();
  registryListeners = new Set();
  editor = null;
  editorVisible = true;
  scrollAllowed = true;
  displaced = true;
  captured.scrolled = 0;
  captured.opened = [];
  captured.focused = [];
  toasted.length = 0;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('revealing a comment', () => {
  test('keeps looking until the passage lands, not just until the editor mounts', () => {
    editor = makeEditor('');

    reveal();
    expect(captured.focused).toEqual(['t1']);
    expect(captured.scrolled).toBe(0);

    contentArrives();
    vi.advanceTimersByTime(RETRY_MS);

    expect(captured.scrolled).toBe(1);
    expect(captured.opened).toEqual(['t1']);
    expect(captured.focused).toEqual(['t1']);
  });

  test('scrolls once and then stops, for a document that stops changing', () => {
    editor = makeEditor('press the tofu first');

    reveal();
    expect(captured.scrolled).toBe(1);

    vi.advanceTimersByTime(REVEAL_WAIT_MS * 2);
    expect(captured.scrolled).toBe(1);
    expect(captured.opened).toEqual(['t1']);
  });

  test('re-scrolls when the passage slides after landing', () => {
    editor = makeEditor('press the tofu first');
    reveal();
    expect(captured.scrolled).toBe(1);

    displaced = true;
    vi.advanceTimersByTime(RETRY_MS);
    expect(captured.scrolled).toBe(2);
    expect(captured.opened).toEqual(['t1']);

    vi.advanceTimersByTime(SETTLE_MS);
    displaced = true;
    vi.advanceTimersByTime(RETRY_MS * 4);
    expect(captured.scrolled).toBe(2);
  });

  test("the reader's own scroll ends the settle window immediately", () => {
    editor = makeEditor('press the tofu first');
    reveal();
    expect(captured.scrolled).toBe(1);

    window.dispatchEvent(new Event('wheel'));

    displaced = true;
    vi.advanceTimersByTime(RETRY_MS * 4);
    expect(captured.scrolled).toBe(1);
  });

  test('waits for a scroller a non-yielding landing still owns', () => {
    editor = makeEditor('press the tofu first');
    scrollAllowed = false;

    reveal();
    expect(captured.scrolled).toBe(0);
    expect(captured.opened).toEqual([]);

    scrollAllowed = true;
    vi.advanceTimersByTime(RETRY_MS);
    expect(captured.scrolled).toBe(1);
    expect(captured.opened).toEqual(['t1']);
  });

  test('gives up at the deadline rather than waiting forever', () => {
    editor = makeEditor('');

    reveal();
    vi.advanceTimersByTime(REVEAL_WAIT_MS + RETRY_MS);

    contentArrives();
    vi.advanceTimersByTime(RETRY_MS * 4);
    expect(captured.scrolled).toBe(0);
    expect(captured.opened).toEqual([]);
  });

  test('says so when it gives up, rather than failing silently', () => {
    editor = makeEditor('');

    reveal();
    expect(captured.focused).toEqual(['t1']);
    expect(toasted).toEqual([]);

    vi.advanceTimersByTime(REVEAL_WAIT_MS + RETRY_MS);
    expect(toasted).toHaveLength(1);
    expect(toasted[0]).toMatch(/passage/i);
  });

  test('names the document, not the passage, when the document never came up', () => {
    editor = makeEditor('press the tofu first');
    editorVisible = false;

    reveal();
    vi.advanceTimersByTime(REVEAL_WAIT_MS + RETRY_MS);

    expect(toasted).toHaveLength(1);
    expect(toasted[0]).toMatch(/didn't open in time/i);
  });

  test('stays quiet when the reveal succeeded', () => {
    editor = makeEditor('press the tofu first');

    reveal();
    expect(captured.scrolled).toBe(1);

    vi.advanceTimersByTime(REVEAL_WAIT_MS * 2);
    expect(toasted).toEqual([]);
  });

  test('a thread with no body passage lands on the document itself', () => {
    editor = makeEditor('press the tofu first');
    revealComment({ docName: 'recipes/stir-fry', quote: '', threadId: 't1' });

    expect(captured.focused).toEqual(['t1']);
    expect(captured.opened).toEqual(['t1']);

    vi.advanceTimersByTime(REVEAL_WAIT_MS + RETRY_MS);
    expect(toasted).toEqual([]);
  });

  test('an empty quote still waits for the document to arrive', () => {
    editor = makeEditor('press the tofu first');
    editorVisible = false;
    revealComment({ docName: 'recipes/stir-fry', quote: '', threadId: 't1' });
    expect(captured.opened).toEqual([]);

    editorVisible = true;
    vi.advanceTimersByTime(RETRY_MS);
    expect(captured.opened).toEqual(['t1']);
    expect(toasted).toEqual([]);
  });

  test('stays quiet when the reader scrolled away instead', () => {
    editor = makeEditor('');

    reveal();
    window.dispatchEvent(new Event('wheel'));
    vi.advanceTimersByTime(REVEAL_WAIT_MS * 2);

    expect(toasted).toEqual([]);
  });

  test('waits for a pooled document to be shown, not merely mounted', () => {
    editor = makeEditor('press the tofu first');
    editorVisible = false;

    reveal();
    expect(captured.scrolled).toBe(0);
    expect(captured.focused).toEqual([]);

    editorVisible = true;
    vi.advanceTimersByTime(RETRY_MS);

    expect(captured.scrolled).toBe(1);
    expect(captured.opened).toEqual(['t1']);
  });

  test('picks the document up the moment it registers, without waiting out a tick', () => {
    reveal();
    expect(captured.focused).toEqual([]);

    editor = makeEditor('press the tofu first');
    for (const listener of registryListeners) listener();

    expect(captured.scrolled).toBe(1);
    expect(captured.focused).toEqual(['t1']);
  });
});
