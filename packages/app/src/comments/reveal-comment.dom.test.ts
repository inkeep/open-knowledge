/**
 * Following a comment into a document that is still arriving.
 *
 * The regression this pins: an editor registers itself when it MOUNTS and its
 * content lands afterwards over the CRDT, so a reveal that treated the mount as
 * arrival searched an empty document, found no passage, and stopped. The click
 * landed on the right page and never scrolled; clicking the same comment again
 * — now against a loaded doc — worked. Hence the "click it twice" report.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const RETRY_MS = 80;
const REVEAL_WAIT_MS = 10_000;
const SETTLE_MS = 1_500;

/**
 * A stand-in editor whose "document" is a string the fake resolver searches.
 * `content.size` tracks that string — the reveal uses it to decide when a
 * re-FIND is worth running; the scroll double below owns the geometry.
 */
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
/** Whether that editor is on screen — false models a hidden pooled pane. */
let editorVisible = true;
let registryListeners: Set<() => void>;
const captured = {
  scrolled: 0,
  opened: [] as string[],
  focused: [] as string[],
};

vi.doMock('@/components/doc-panel-events', () => ({ requestDocPanelTab: () => {} }));

// doc-hash is deliberately NOT stubbed: nothing here needs it isolated, only
// present. A stub would be a second copy of the route-hash contract, and this
// file asserts nothing about the hash.

/** False models a scroller owned by a landing that does not yield. */
let scrollAllowed = true;
/**
 * True models the passage sitting outside the comfortable band — the real
 * function measures and scrolls only then, so the double scrolls once per
 * displacement and is a no-op while the passage stays put.
 */
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
    // The real one declines an empty quote outright. `indexOf('')` answers 0,
    // so a double without this guard "finds" a zero-width range at the top of
    // every document — and the no-passage case then passes whatever the code
    // under test does with it.
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

/** Content lands over the CRDT — a mounted editor filling in after the fact. */
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
    // Mounted, empty: exactly the state a freshly navigated-to document is in.
    editor = makeEditor('');

    reveal();
    // The document is open, so its card lights up in the panel right away —
    // but there is nothing to scroll to yet.
    expect(captured.focused).toEqual(['t1']);
    expect(captured.scrolled).toBe(0);

    contentArrives();
    vi.advanceTimersByTime(RETRY_MS);

    expect(captured.scrolled).toBe(1);
    expect(captured.opened).toEqual(['t1']);
    // The panel is told once, on arrival — not on every tick of the wait.
    expect(captured.focused).toEqual(['t1']);
  });

  test('scrolls once and then stops, for a document that stops changing', () => {
    editor = makeEditor('press the tofu first');

    reveal();
    expect(captured.scrolled).toBe(1);

    // The settle window watches, but an unchanged document gives it nothing to
    // correct — and once it closes nothing is left running, so a reader who
    // scrolls away is not dragged back.
    vi.advanceTimersByTime(REVEAL_WAIT_MS * 2);
    expect(captured.scrolled).toBe(1);
    expect(captured.opened).toEqual(['t1']);
  });

  test('re-scrolls when the passage slides after landing', () => {
    editor = makeEditor('press the tofu first');
    reveal();
    expect(captured.scrolled).toBe(1);

    // Content arriving above, a late layout shift — anything that moves the
    // passage without the reader asking. This is the "took me there, but past
    // it" case: the words were right and the position went stale.
    displaced = true;
    vi.advanceTimersByTime(RETRY_MS);
    expect(captured.scrolled).toBe(2);
    // Corrected, not re-announced: the thread is already open.
    expect(captured.opened).toEqual(['t1']);

    // Past the settle window the document is left alone.
    vi.advanceTimersByTime(SETTLE_MS);
    displaced = true;
    vi.advanceTimersByTime(RETRY_MS * 4);
    expect(captured.scrolled).toBe(2);
  });

  test("the reader's own scroll ends the settle window immediately", () => {
    editor = makeEditor('press the tofu first');
    reveal();
    expect(captured.scrolled).toBe(1);

    // The reader scrolls away mid-window...
    window.dispatchEvent(new Event('wheel'));

    // ...so a later displacement is THEIR position now, not drift to correct.
    displaced = true;
    vi.advanceTimersByTime(RETRY_MS * 4);
    expect(captured.scrolled).toBe(1);
  });

  test('waits for a scroller a non-yielding landing still owns', () => {
    editor = makeEditor('press the tofu first');
    scrollAllowed = false;

    reveal();
    // Declined, so nothing has landed — the thread must not read as revealed.
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

    // The words never came (an orphaned anchor, or a document that failed to
    // sync). Landing on it later must not yank a reader who has moved on.
    contentArrives();
    vi.advanceTimersByTime(RETRY_MS * 4);
    expect(captured.scrolled).toBe(0);
    expect(captured.opened).toEqual([]);
  });

  test('says so when it gives up, rather than failing silently', () => {
    // The document is up — its card even lit — so what failed is the passage.
    editor = makeEditor('');

    reveal();
    expect(captured.focused).toEqual(['t1']);
    // Nothing yet: giving up early would toast over a document still arriving.
    expect(toasted).toEqual([]);

    vi.advanceTimersByTime(REVEAL_WAIT_MS + RETRY_MS);
    expect(toasted).toHaveLength(1);
    expect(toasted[0]).toMatch(/passage/i);
  });

  test('names the document, not the passage, when the document never came up', () => {
    // Never visible, so the passage was never even looked for — telling this
    // reader their text has changed would send them after the wrong problem.
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

    // Well past the deadline: a landing cancels it, so nothing fires later.
    vi.advanceTimersByTime(REVEAL_WAIT_MS * 2);
    expect(toasted).toEqual([]);
  });

  test('a thread with no body passage lands on the document itself', () => {
    // A property thread: its words are in the frontmatter value, which the
    // properties panel reveals. `revealThread` passes an empty quote, and this
    // used to search for it, never find it, and then blame the passage.
    editor = makeEditor('press the tofu first');
    revealComment({ docName: 'recipes/stir-fry', quote: '', threadId: 't1' });

    expect(captured.focused).toEqual(['t1']);
    expect(captured.opened).toEqual(['t1']);

    vi.advanceTimersByTime(REVEAL_WAIT_MS + RETRY_MS);
    expect(toasted).toEqual([]);
  });

  test('an empty quote still waits for the document to arrive', () => {
    // The landing is "the right document is on screen" — which is exactly what
    // is not true yet while a cross-document jump is still navigating.
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
    // Their intent ended the jump — that is not a failure to report.
    window.dispatchEvent(new Event('wheel'));
    vi.advanceTimersByTime(REVEAL_WAIT_MS * 2);

    expect(toasted).toEqual([]);
  });

  test('waits for a pooled document to be shown, not merely mounted', () => {
    // Mounted, loaded, and hidden behind `<Activity mode="hidden">` — the state
    // every recently-visited document is in. Measuring it would scroll a pane
    // with no layout, so this counts as not-there.
    editor = makeEditor('press the tofu first');
    editorVisible = false;

    reveal();
    expect(captured.scrolled).toBe(0);
    expect(captured.focused).toEqual([]);

    // Navigation brings it to the front.
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
