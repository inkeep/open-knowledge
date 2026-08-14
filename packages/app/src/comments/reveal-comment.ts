/**
 * Jump from a comment to the passage it is anchored to.
 *
 * The queue is project-wide, so the target doc is often NOT the one on screen.
 * That makes this two steps rather than one: navigate if needed, then wait for
 * that document to actually be there before scrolling to the passage — a jump
 * issued during navigation would land on an editor that doesn't exist yet and
 * silently do nothing.
 *
 * "There" means on screen and loaded, neither of which registration implies.
 * An editor registers when it MOUNTS: its content arrives afterwards over the
 * CRDT, and `EditorActivityPool` keeps the last few visited documents mounted
 * but hidden. Reading registration as arrival therefore failed two ways — it
 * searched an empty document and gave up (the click landed on the right page and
 * never scrolled, while clicking again, now against a loaded doc, worked), and
 * for a recently-visited document it skipped the navigation entirely and
 * scrolled a pane nobody could see. So the wait is for the PASSAGE, in a VISIBLE
 * editor, and it keeps looking until both hold or the deadline passes.
 *
 * The passage is located by its quoted text, the same durable record the anchor
 * itself is built on, so this keeps working after the text has moved.
 */

import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import { requestDocPanelTab } from '@/components/doc-panel-events';
import { getVisibleEditorForDoc, subscribeEditorRegistry } from '@/editor/active-editor';
import { hashFromDocName } from '@/lib/doc-hash';
import { type AnchorContext, findQuoteRange } from './anchor-search';
import { scrollAnchorIntoView } from './scroll-to-anchor';
import { emitFocusThread, emitOpenThread } from './store';

/** Give up on a document that never arrives (bad docName, failed load, dead sync). */
const REVEAL_WAIT_MS = 10_000;

/**
 * How often to re-ask while the document is still arriving.
 *
 * A poll rather than an event: the registry announces a MOUNT, and what this
 * waits for is content, which lands through the CRDT afterwards — and even with
 * the text in place, ProseMirror can still be a frame away from being able to
 * give coordinates for it. One clock covers all three.
 */
const RETRY_MS = 80;

/**
 * How long to keep watching AFTER the passage has been scrolled to.
 *
 * A freshly-opened document is not done moving when the words are in place:
 * content can still be arriving above the passage, and layout above it settles
 * for a while after that (hydration, decorations, fonts) — either one slides the
 * passage away from where it was put, without any further scroll of ours. During
 * this window the passage's on-screen position is re-verified and corrected —
 * geometry, not document size, because a layout shift moves the passage without
 * changing a single character.
 *
 * The reader outranks the window: any scroll intent of theirs (wheel, touch,
 * scrollbar, keys) ends it immediately, so nobody is dragged back to a passage
 * they chose to leave.
 */
const SETTLE_MS = 1_500;

/** The reader took the scroller — end corrections instantly. */
const INTENT_EVENTS = ['wheel', 'touchstart', 'mousedown', 'keydown'] as const;

/**
 * Scroll to a comment's passage and open its thread there, navigating to the
 * document first when it isn't the one open. Also opens the Comments tab so the
 * thread is visible beside the passage it belongs to.
 */
export function revealComment(input: {
  docName: string;
  quote: string;
  threadId: string;
  /** Stored context — disambiguates a quote that appears more than once. */
  context?: AnchorContext;
}): void {
  let announced = false;
  /** When the passage was first scrolled to — the start of the settle window. */
  let landedAt: number | null = null;
  /** The resolved passage, re-found only when the document's content changes. */
  let range: { from: number; to: number } | null = null;
  let sizeAtLastFind = -1;

  const attempt = (): boolean => {
    const editor = getVisibleEditorForDoc(input.docName);
    if (!editor || editor.isDestroyed) return false;
    // The document is on screen, which is worth saying even if the passage never
    // resolves — an orphaned anchor has nothing to scroll to, and its card
    // still has to light up in the panel. Once only: this runs on every tick.
    if (!announced) {
      announced = true;
      emitFocusThread(input.threadId);
    }
    // Nothing to look for in the body. A property thread's words live in the
    // frontmatter value, which the properties panel owns and reveals itself, so
    // getting the right document on screen IS the whole job here — and a
    // comment on a whole field has no words at all. Searching for an empty
    // quote finds nothing by definition, so without this the jump never landed:
    // it sat out the full wait and then reported the passage as lost, on a
    // navigation that had worked.
    if (input.quote === '') {
      if (landedAt === null) {
        landedAt = Date.now();
        emitOpenThread(input.threadId);
      }
      return true;
    }
    // Re-locate the quote only when content has changed — the find is a
    // full-document scan, far too heavy to run on every tick of the settle
    // window. The GEOMETRY check below runs every tick regardless: layout can
    // move a passage without changing a single character of content.
    const size = editor.state.doc.content.size;
    if (range === null || size !== sizeAtLastFind) {
      range = findQuoteRange(editor.state.doc, input.quote, input.context);
      sizeAtLastFind = size;
    }
    if (!range) return false;
    // Pointed at, not selected. Focusing the editor and selecting the passage
    // put a live text selection on it — blue, with the formatting bubble menu
    // over it — so arriving at a comment read as picking its words up to edit.
    // Opening the thread deepens the highlight instead, which is what the margin
    // marker does and what "here it is" should mean.
    //
    // A no-op when the passage is already comfortably placed, so the settle
    // window's re-verifications cost a measurement, not a scroll. Instant, not
    // smooth: corrections against a still-settling layout must not race their
    // own animation. Declined means a landing that does not yield owns the
    // scroller — another explicit jump. Leave it alone and retry next tick.
    if (!scrollAnchorIntoView(editor, range, input.docName, { instant: true })) return false;
    if (landedAt === null) {
      landedAt = Date.now();
      emitOpenThread(input.threadId);
    }
    return true;
  };

  requestDocPanelTab('comments');
  // Scroll now if everything is already in place, but do NOT stop there: the
  // settle window below is what catches a passage that moves afterwards.
  attempt();

  // Only when the document isn't on screen — which includes one sitting mounted
  // but hidden in the pool, the case that used to skip navigation and scroll
  // nothing. Re-assigning the hash of a document already in front of the reader
  // is a no-op in the browser, but it says the wrong thing here: what is being
  // waited for in that case is the content, not the navigation.
  if (getVisibleEditorForDoc(input.docName) === null) {
    window.location.assign(hashFromDocName(input.docName));
  }

  let settled = false;
  const stop = (): void => {
    if (settled) return;
    settled = true;
    unsubscribe();
    window.clearInterval(ticker);
    window.clearTimeout(deadline);
    for (const event of INTENT_EVENTS) window.removeEventListener(event, onIntent, true);
  };
  // Window-level and capture-phase: the container the reader scrolls could be
  // the editor's, but intent anywhere — the panel, another pane — equally means
  // they have moved on from this jump.
  const onIntent = (): void => stop();
  const tick = (): void => {
    // A successful attempt is not the end: the settle window keeps re-verifying
    // the passage's position while the arriving document moves under it.
    if (attempt() && landedAt !== null && Date.now() - landedAt >= SETTLE_MS) stop();
  };
  // The registry fires the moment the editor mounts, which is the earliest this
  // can possibly succeed — worth taking rather than waiting out a tick for it.
  const unsubscribe = subscribeEditorRegistry(tick);
  const ticker = window.setInterval(tick, RETRY_MS);
  // Giving up is a fact worth reporting. Ten seconds of a comment card that
  // does nothing when clicked reads as a missed click, so the reader clicks it
  // again and waits out another ten. Which of the two things went wrong is
  // knowable here — the document never came up, or it did and the words were
  // not in it — and they call for different next moves, so say which.
  //
  // Only on the deadline path: `stop` also runs on a landing and on the reader
  // scrolling away, and both of those clear this timer first.
  const deadline = window.setTimeout(() => {
    if (landedAt === null) {
      toast.error(
        announced
          ? t`Couldn't find that passage — the text it was on may have changed.`
          : t`That document didn't open in time. Try again once it has synced.`,
      );
    }
    stop();
  }, REVEAL_WAIT_MS);
  for (const event of INTENT_EVENTS) window.addEventListener(event, onIntent, true);
  // The editor may have registered between the attempt above and this line.
  tick();
}
