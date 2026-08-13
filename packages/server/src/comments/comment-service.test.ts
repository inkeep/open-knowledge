import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getLogger } from '../logger.ts';
import { CommentIndex } from './comment-index.ts';
import {
  CommentService,
  DocNotFoundError,
  PassageNotFoundError,
  PropertyNotFoundError,
  ThreadNotFoundError,
} from './comment-service.ts';
import { CommentThreadStore } from './thread-store.ts';

const log = getLogger('comment-service-test');

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'comment-service-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const ORIGINAL = 'The rollout is scheduled for Q3. We expect minimal downtime.';

let store: CommentThreadStore;
let index: CommentIndex;
let bodies: Map<string, string>;
/** Frontmatter records per doc — what a property thread re-finds against. */
let frontmatter: Map<string, Record<string, unknown>>;
let clock: number;
let ids: number;
let svc: CommentService;
/** Document reads, counted so the dispatch path can assert it does not double-read. */
let docBodyReads: number;

beforeEach(async () => {
  store = new CommentThreadStore(tmp(), log);
  await store.init();
  index = new CommentIndex();
  bodies = new Map([['notes/rollout', ORIGINAL]]);
  frontmatter = new Map<string, Record<string, unknown>>([
    [
      'notes/rollout',
      {
        title: 'Rollout notes',
        tags: ['infra', 'q3'],
        summary: 'Ships in Q3. Downtime should be minimal.',
        author: { name: 'Ada' },
      },
    ],
  ]);
  clock = 1000;
  ids = 0;
  docBodyReads = 0;
  svc = new CommentService({
    store,
    index,
    getDocBody: (doc) => {
      docBodyReads += 1;
      return bodies.get(doc) ?? null;
    },
    getDocFrontmatter: (doc) => frontmatter.get(doc) ?? null,
    now: () => ++clock,
    newId: () => `t${++ids}`,
  });
});

async function makeThread(quote = 'minimal downtime') {
  const start = ORIGINAL.indexOf(quote);
  return svc.createThread({
    docName: 'notes/rollout',
    start,
    end: start + quote.length,
    author: 'principal-abc',
    body: 'still accurate?',
  });
}

describe('CommentService — create / read / list', () => {
  test('creates an anchored thread and indexes it', async () => {
    const meta = await makeThread();
    expect(meta.state).toBe('anchored');
    expect(meta.anchor.exact).toBe('minimal downtime');
    expect(index.threadsForDoc('notes/rollout')).toEqual([meta.threadId]);

    expect((await svc.readThread(meta.threadId)).latestComment).toBe('still accurate?');
  });

  test('listThreads returns cover sheets for a doc', async () => {
    await makeThread('minimal downtime');
    await makeThread('Q3');
    const list = await svc.listThreads('notes/rollout');
    expect(list.map((m) => m.anchor.exact).sort()).toEqual(['Q3', 'minimal downtime']);
  });

  test('listThreads without a doc spans the whole project', async () => {
    bodies.set('other/doc', ORIGINAL);
    await makeThread('minimal downtime');
    await svc.createThread({
      docName: 'other/doc',
      start: ORIGINAL.indexOf('Q3'),
      end: ORIGINAL.indexOf('Q3') + 2,
      author: 'principal-abc',
      body: 'elsewhere',
    });

    const all = await svc.listThreads();
    expect(all.map((m) => m.docName).sort()).toEqual(['notes/rollout', 'other/doc']);
    // still scopes correctly when asked for one doc
    expect(await svc.listThreads('other/doc')).toHaveLength(1);
  });

  test('createThread with queue posts straight into the queue', async () => {
    const start = ORIGINAL.indexOf('minimal downtime');
    const meta = await svc.createThread({
      docName: 'notes/rollout',
      start,
      end: start + 'minimal downtime'.length,
      author: 'principal-abc',
      body: 'batch this',
      queue: true,
    });
    expect(meta.queued).toBe(true);
    expect(meta.state).toBe('anchored');
  });

  test('anchors by quote when the caller has no body offsets', async () => {
    // The rich-text editor only has ProseMirror positions, so it sends words.
    const meta = await svc.createThread({
      docName: 'notes/rollout',
      quote: 'minimal downtime',
      author: 'principal-abc',
      body: 'still true?',
    });
    expect(meta.anchor.exact).toBe('minimal downtime');
    expect(ORIGINAL.slice(meta.anchor.start, meta.anchor.end)).toBe('minimal downtime');
  });

  test('matches a passage the editor rendered without its markdown syntax', async () => {
    // A selection spanning a heading and a list item arrives as the editor
    // renders it — no "##", no "1.", blocks joined by a newline — while the body
    // still carries all of it. Only syntax and whitespace may differ; the words
    // must still match exactly.
    bodies.set('notes/steps', '## Steps\n\n1. Heat oven to 425F.\n2. Toss the sweet potato.');
    const meta = await svc.createThread({
      docName: 'notes/steps',
      quote: 'Steps\nHeat oven to 425F.',
      author: 'principal-abc',
      body: 'how hot?',
    });
    expect(meta.state).toBe('anchored');
    // the resolved range covers the real source text, markers and all
    const body = bodies.get('notes/steps') ?? '';
    expect(body.slice(meta.anchor.start, meta.anchor.end)).toBe('Steps\n\n1. Heat oven to 425F.');
  });

  test('anchors a passage that starts after a bold run inside a list item', async () => {
    // The reported 400: the source line is "- **Peanut sauce:** 3 tbsp ...", so
    // the selected words are not a literal substring of the body — the bold
    // markers sit inside the passage.
    bodies.set(
      'recipes/stir-fry',
      '## Ingredients\n\n- 2 tbsp neutral oil\n- **Peanut sauce:** 3 tbsp peanut butter, water to loosen\n',
    );
    const meta = await svc.createThread({
      docName: 'recipes/stir-fry',
      quote: 'Peanut sauce: 3 tbsp peanut butter',
      author: 'principal-abc',
      body: 'how much water?',
    });
    expect(meta.state).toBe('anchored');
    const body = bodies.get('recipes/stir-fry') ?? '';
    expect(body.slice(meta.anchor.start, meta.anchor.end)).toBe(
      'Peanut sauce:** 3 tbsp peanut butter',
    );
  });

  test('anchors a selection dragged across a language-tagged code block', async () => {
    // The reported 400: a fence's backticks were already elastic but the info
    // string after them was not, so every selection crossing into or out of a
    // tagged code block died on the `ts`.
    bodies.set(
      'specs/language',
      'Add `appearance.language` to `ConfigSchema`:\n\n```ts\nlanguage: z\n  .optional(),\n```\n\nAcceptance: the leaf validates.',
    );
    const meta = await svc.createThread({
      docName: 'specs/language',
      quote: 'to ConfigSchema:\nlanguage: z\n  .optional(),\nAcceptance: the leaf validates.',
      author: 'principal-abc',
      body: 'is this the right scope?',
    });
    expect(meta.state).toBe('anchored');
    const body = bodies.get('specs/language') ?? '';
    // The stored range covers the real source, fence and all.
    expect(body.slice(meta.anchor.start, meta.anchor.end)).toContain('```ts');
  });

  test('anchors a selected table row', async () => {
    // Picking a row hands over the cell texts with the pipes and padding gone,
    // so the row is not a literal substring of the source line.
    bodies.set(
      'notes/freezing',
      '| Method | Temperature | Hold time |\n| --- | --- | --- |\n| 1 | -4F or below | >= 168 hours |\n| 2 | -31F or below | >= 15 hours |',
    );
    const meta = await svc.createThread({
      docName: 'notes/freezing',
      quote: '2\n-31F or below\n>= 15 hours',
      author: 'principal-abc',
      body: 'is this still current?',
    });
    expect(meta.state).toBe('anchored');
    const body = bodies.get('notes/freezing') ?? '';
    expect(body.slice(meta.anchor.start, meta.anchor.end)).toBe('2 | -31F or below | >= 15 hours');
  });

  test('relaxed matching still refuses different words', async () => {
    bodies.set('notes/steps', '## Steps\n\n1. Heat oven to 425F.');
    await expect(
      svc.createThread({
        docName: 'notes/steps',
        quote: 'Steps Heat oven to 500F.',
        author: 'principal-abc',
        body: 'x',
      }),
    ).rejects.toBeInstanceOf(PassageNotFoundError);
  });

  test('rejects a quote that is not in the document', async () => {
    await expect(
      svc.createThread({
        docName: 'notes/rollout',
        quote: 'text that was never here',
        author: 'principal-abc',
        body: 'x',
      }),
    ).rejects.toBeInstanceOf(PassageNotFoundError);
  });

  test('replaceAnchor accepts a quote too', async () => {
    const { threadId } = await makeThread();
    const meta = await svc.replaceAnchor(threadId, { quote: 'Q3' });
    expect(meta.anchor.exact).toBe('Q3');
    expect(meta.state).toBe('anchored');
  });

  test('createThread on a missing doc throws', async () => {
    await expect(
      svc.createThread({ docName: 'gone', start: 0, end: 1, author: 'principal-x', body: 'x' }),
    ).rejects.toBeInstanceOf(DocNotFoundError);
  });

  test('listing threads reads no files at all', async () => {
    // The app refetches the whole project on every mutation and every push
    // notification, so a per-thread file read here made one click cost O(every
    // comment ever made). The index holds the threads; this pins that it is
    // actually what answers.
    await makeThread('minimal downtime');
    await makeThread('Q3');
    const reads = vi.spyOn(store, 'readMeta');

    const all = await svc.listThreads();
    const scoped = await svc.listThreads('notes/rollout');

    expect(all).toHaveLength(2);
    expect(scoped).toHaveLength(2);
    expect(reads).not.toHaveBeenCalled();
  });

  test('a mutation is visible to the very next list', async () => {
    // The other half of the trade: reads never hit disk, so a write that failed
    // to refresh the index would serve the pre-mutation state indefinitely.
    const { threadId } = await makeThread();
    await svc.editComment(threadId, 'revised ask');
    await svc.resolve(threadId);

    const [meta] = await svc.listThreads('notes/rollout');
    expect(meta.latestComment).toBe('revised ask');
    expect(meta.state).toBe('resolved');
  });

  test('a rename is visible to the very next list', async () => {
    const { threadId } = await makeThread();
    bodies.set('notes/rollout-2026', ORIGINAL);
    await svc.renameDoc('notes/rollout', 'notes/rollout-2026');

    expect(await svc.listThreads('notes/rollout')).toEqual([]);
    const moved = await svc.listThreads('notes/rollout-2026');
    expect(moved.map((m) => m.threadId)).toEqual([threadId]);
    expect(moved[0].docName).toBe('notes/rollout-2026');
  });

  test('a deleted thread leaves the list immediately', async () => {
    const { threadId } = await makeThread();
    await svc.delete(threadId);
    expect(await svc.listThreads()).toEqual([]);
  });

  test('prepareDispatch reads the document once, not once per use', async () => {
    // The re-find and the repeated-quote check both want the same body. Reading
    // it twice is invisible in behaviour and doubles the cost of a batch, which
    // runs this sequentially per thread.
    const { threadId } = await makeThread();
    docBodyReads = 0;
    await svc.prepareDispatch(threadId);
    expect(docBodyReads).toBe(1);
  });

  test('a batch reads each thread its document exactly once', async () => {
    const a = await makeThread('minimal downtime');
    const b = await makeThread('Q3');
    docBodyReads = 0;
    await svc.prepareDispatchBatch([a.threadId, b.threadId]);
    expect(docBodyReads).toBe(2);
  });

  describe('a repeated quote resolves to the occurrence the caller selected', () => {
    // Two identical sentences under different headings — the case where taking
    // the first match anchors the comment to a passage nobody picked, and the
    // create-time context widening then cements it with nothing flagged.
    const REPEATED = [
      '## Rollout',
      'We will ship with minimal downtime.',
      '',
      '## Rollback',
      'We will ship with minimal downtime.',
    ].join('\n');
    const SECOND = REPEATED.lastIndexOf('minimal downtime');

    beforeEach(() => {
      bodies.set('notes/repeat', REPEATED);
    });

    async function commentOnRepeat(context: { prefix?: string; suffix?: string }) {
      return svc.createThread({
        docName: 'notes/repeat',
        quote: 'minimal downtime',
        ...context,
        author: 'principal-abc',
        body: 'not true for rollback',
      });
    }

    test('the context around the selection picks the second one', async () => {
      // Rendered text, as the editor would capture it — no `##`, which is
      // exactly why the scoring has to tolerate a partial match.
      const meta = await commentOnRepeat({ prefix: 'Rollback\nWe will ship with ' });
      expect(meta.anchor.start).toBe(SECOND);
    });

    test('the suffix side works on its own', async () => {
      const first = REPEATED.indexOf('minimal downtime');
      const meta = await commentOnRepeat({ suffix: '.\n\n## Rollback' });
      expect(meta.anchor.start).toBe(first);
    });

    test('no context still lands on the first occurrence', async () => {
      // Nothing better to go on — the previous behavior, now the fallback
      // rather than the rule.
      const meta = await commentOnRepeat({});
      expect(meta.anchor.start).toBe(REPEATED.indexOf('minimal downtime'));
    });

    test('the widened context describes the passage that was actually chosen', async () => {
      // The failure this guards is silent: a wrong pick produces a perfectly
      // valid, unique anchor, so only the stored context reveals which passage
      // the thread really points at.
      const meta = await commentOnRepeat({ prefix: 'Rollback\nWe will ship with ' });
      expect(meta.anchor.prefix).toContain('Rollback');
      expect(meta.anchor.prefix).not.toContain('Rollout');
    });
  });
});

describe('CommentService — edit / resolve / reopen', () => {
  test('an edit replaces the comment and the lifecycle moves through it', async () => {
    const { threadId } = await makeThread();
    await svc.editComment(threadId, 'still right?');
    expect((await svc.readThread(threadId)).latestComment).toBe('still right?');

    let meta = await svc.resolve(threadId);
    expect(meta.state).toBe('resolved');
    meta = await svc.reopen(threadId);
    expect(meta.state).toBe('anchored');
    // The comment survives the round trip; only state moved.
    expect(meta.latestComment).toBe('still right?');
  });

  test('reopening re-checks the anchor rather than assuming it is still there', async () => {
    // `resolved` does not preserve what the anchor state was underneath it, so
    // reopening has to re-establish it — otherwise a thread closed while
    // orphaned would reopen claiming to be anchored.
    const { threadId } = await makeThread();
    await svc.resolve(threadId);
    bodies.set('notes/rollout', 'The rollout is scheduled for Q3. All clear now.');

    expect((await svc.reopen(threadId)).state).toBe('orphaned');
  });

  test('unknown thread throws', async () => {
    await expect(svc.editComment('nope', 'b')).rejects.toBeInstanceOf(ThreadNotFoundError);
  });
});

describe('CommentService — deleteDoc (document deleted)', () => {
  test('deletes every thread on the doc and reports how many', async () => {
    await makeThread('minimal downtime');
    await makeThread('Q3');

    expect(await svc.deleteDoc('notes/rollout')).toBe(2);
    expect(await svc.listThreads('notes/rollout')).toEqual([]);
    expect(await svc.listThreads()).toEqual([]);
  });

  test('leaves other documents alone', async () => {
    bodies.set('other/doc', ORIGINAL);
    const keep = await svc.createThread({
      docName: 'other/doc',
      quote: 'Q3',
      author: 'principal-abc',
      body: 'elsewhere',
    });
    await makeThread();

    expect(await svc.deleteDoc('notes/rollout')).toBe(1);
    expect((await svc.listThreads()).map((m) => m.threadId)).toEqual([keep.threadId]);
  });

  test('a doc with no threads is a no-op', async () => {
    await makeThread();
    expect(await svc.deleteDoc('notes/never-commented')).toBe(0);
    expect(await svc.listThreads()).toHaveLength(1);
  });

  test('the threads are gone from disk, not just the index', async () => {
    // The index is a cache rebuilt from disk at boot, so dropping only the
    // cached entry would resurrect every deleted thread on the next restart.
    const { threadId } = await makeThread();
    await svc.deleteDoc('notes/rollout');

    expect(await store.readMeta(threadId)).toBeNull();
    expect(await store.scanCoverSheets()).toEqual([]);
  });

  test('a deleted doc takes its queued comments out of the batch with it', async () => {
    // The reason this matters: a thread on a missing document reads as a
    // HEALTHY anchor — the re-find bails out when the body cannot be read — so
    // left in the queue it would be dispatched with `anchorLost: false`,
    // telling an agent to edit a document that no longer exists.
    const start = ORIGINAL.indexOf('minimal downtime');
    await svc.createThread({
      docName: 'notes/rollout',
      start,
      end: start + 'minimal downtime'.length,
      author: 'principal-abc',
      body: 'batch this',
      queue: true,
    });
    expect((await svc.listThreads()).filter((m) => m.queued)).toHaveLength(1);

    await svc.deleteDoc('notes/rollout');
    expect(await svc.listThreads()).toEqual([]);
  });
});

describe('CommentService — refindDoc (document settled)', () => {
  test('deleting a commented passage orphans the thread without anyone asking', async () => {
    // The gap this closes: state used to refresh only when a comment was queued
    // or sent, so a deleted passage left the comment looking healthy — highlight
    // silently gone, card unchanged — until you tried to send it.
    const { threadId } = await makeThread();
    bodies.set('notes/rollout', 'The rollout is scheduled for Q3. All clear now.');

    expect(await svc.refindDoc('notes/rollout')).toBe(true);
    expect((await svc.readThread(threadId)).state).toBe('orphaned');
  });

  test('restoring the passage recovers the thread', async () => {
    const { threadId } = await makeThread();
    bodies.set('notes/rollout', 'gone');
    await svc.refindDoc('notes/rollout');
    bodies.set('notes/rollout', ORIGINAL);

    expect(await svc.refindDoc('notes/rollout')).toBe(true);
    expect((await svc.readThread(threadId)).state).toBe('anchored');
  });

  test('an unchanged document reports no change and writes nothing', async () => {
    // This runs on every settle of every document, so the steady state has to
    // be free. A write here would mean one per thread per keystroke burst.
    await makeThread();
    const writes = vi.spyOn(store, 'update');

    expect(await svc.refindDoc('notes/rollout')).toBe(false);
    expect(writes).not.toHaveBeenCalled();
  });

  test('a passage that merely moved is left alone', async () => {
    // Position is a hint, not authority. Re-capturing it on every settle would
    // be a write per thread for text that is still exactly where the words say.
    await makeThread();
    bodies.set('notes/rollout', `Heads up: dates may slip. ${ORIGINAL}`);
    const writes = vi.spyOn(store, 'update');

    expect(await svc.refindDoc('notes/rollout')).toBe(false);
    expect(writes).not.toHaveBeenCalled();
  });

  test('a doc with no threads never touches the document', async () => {
    // Every settle of every document reaches this, including the vast majority
    // that carry no comments at all.
    await makeThread();
    docBodyReads = 0;

    expect(await svc.refindDoc('notes/untouched')).toBe(false);
    expect(docBodyReads).toBe(0);
  });

  test('editing the anchored passage re-captures the quote the panel shows', async () => {
    // The reported gap: the highlight follows an edited passage live (bracket
    // recovery), but this pass kept only the anchored/orphaned bit — so the
    // card's quote named text no longer in the document until some later
    // dispatch re-found. A rewritten quote is user-visible state: persist it
    // and say so, so clients refetch.
    // Mid-document, so both stored brackets are substantial — a quote at the
    // very end gets a one-character suffix ("."), which is legitimately too
    // ambiguous for the recovery to accept.
    const { threadId } = await makeThread('scheduled');
    // Edit INSIDE the passage: the quote is no longer literal, but the stored
    // context still brackets it.
    bodies.set('notes/rollout', ORIGINAL.replace('scheduled', 'penciled in'));

    expect(await svc.refindDoc('notes/rollout')).toBe(true);
    const after = await svc.readThread(threadId);
    expect(after.state).toBe('anchored');
    expect(after.anchor?.exact).toBe('penciled in');
  });

  test('resolved threads are skipped', async () => {
    const { threadId } = await makeThread();
    await svc.resolve(threadId);
    bodies.set('notes/rollout', 'nothing left');

    expect(await svc.refindDoc('notes/rollout')).toBe(false);
    expect((await svc.readThread(threadId)).state).toBe('resolved');
  });
});

describe('CommentService — refindOnLoad', () => {
  test('follows the anchor silently when text is inserted above it', async () => {
    const { threadId, anchor } = await makeThread();
    bodies.set('notes/rollout', `Heads up: dates may slip. ${ORIGINAL}`);

    const meta = await svc.refindOnLoad(threadId);

    expect(meta.state).toBe('anchored');
    expect(meta.anchor.start).not.toBe(anchor.start); // hint moved
    expect(meta.anchor.exact).toBe('minimal downtime'); // and still the same words
  });

  test('orphans explicitly when the quoted text is gone', async () => {
    const { threadId } = await makeThread();
    bodies.set('notes/rollout', 'The rollout is scheduled for Q3. All clear now.');

    const meta = await svc.refindOnLoad(threadId);
    expect(meta.state).toBe('orphaned');

    // idempotent: a second load while still gone reports the same thing
    expect((await svc.refindOnLoad(threadId)).state).toBe('orphaned');
  });

  test('recovers when the text returns', async () => {
    const { threadId } = await makeThread();
    bodies.set('notes/rollout', 'gone');
    expect((await svc.refindOnLoad(threadId)).state).toBe('orphaned');
    bodies.set('notes/rollout', ORIGINAL);

    expect((await svc.refindOnLoad(threadId)).state).toBe('anchored');
  });

  test('skips resolved threads', async () => {
    const { threadId } = await makeThread();
    await svc.resolve(threadId);
    bodies.set('notes/rollout', 'gone'); // would orphan if it ran
    const meta = await svc.refindOnLoad(threadId);
    expect(meta.state).toBe('resolved');
  });
});

describe('CommentService — re-placement and dispatch queue', () => {
  test('replaceAnchor re-anchors an orphaned thread', async () => {
    const { threadId } = await makeThread();
    bodies.set('notes/rollout', 'Rollout moved to Q4. We expect minimal downtime still.');
    await svc.refindOnLoad(threadId); // still finds "minimal downtime"; force orphan instead:
    bodies.set('notes/rollout', 'Totally different text about nothing.');
    let meta = await svc.refindOnLoad(threadId);
    expect(meta.state).toBe('orphaned');

    const next = 'Totally different text about nothing.';
    const start = next.indexOf('different');
    meta = await svc.replaceAnchor(threadId, { start, end: start + 'different'.length });
    expect(meta.state).toBe('anchored');
    expect(meta.anchor.exact).toBe('different');
  });

  test('queueForDispatch: anchored thread queues and is not orphaned', async () => {
    const { threadId } = await makeThread();
    const res = await svc.queueForDispatch(threadId);
    expect(res.orphaned).toBe(false);
    expect(res.meta.queued).toBe(true);
    expect(res.meta.state).toBe('anchored');
  });

  test('queueForDispatch: lost anchor stays queued but is held (orphaned)', async () => {
    const { threadId } = await makeThread();
    bodies.set('notes/rollout', 'nothing to see here');
    const res = await svc.queueForDispatch(threadId);
    expect(res.orphaned).toBe(true);
    expect(res.meta.queued).toBe(true); // stays IN the queue
    expect(res.meta.state).toBe('orphaned'); // but blocked
    // and the same is true when read back, not just in the return value
    const stored = await svc.readThread(threadId);
    expect(stored.queued).toBe(true);
    expect(stored.state).toBe('orphaned');
  });

  test('unqueue clears the queue flag', async () => {
    const { threadId } = await makeThread();
    await svc.queueForDispatch(threadId);
    const meta = await svc.unqueue(threadId);
    expect(meta.queued).toBe(false);
  });
});

describe('CommentService — dispatch (client-delivered, resolve-on-send)', () => {
  test('prepare hands back the ingredients the client composes with', async () => {
    const { threadId } = await makeThread();
    const res = await svc.prepareDispatch(threadId);

    expect(res.payload.docName).toBe('notes/rollout');
    expect(res.payload.instruction).toBe('still accurate?');
    expect(res.payload.passage.exact).toBe('minimal downtime');
    expect(res.payload.anchorLost).toBe(false);
    // queued while it is out for delivery, not yet resolved
    expect(res.meta.queued).toBe(true);
    expect(res.meta.state).toBe('anchored');
  });

  test('prepare sends the revised comment, not the text it replaced', async () => {
    // Dispatch must carry the revision, not the text it replaced — handing an
    // agent the opening ask would have it act on words the reviewer deliberately
    // rewrote.
    const { threadId } = await makeThread(); // opens with "still accurate?"
    await svc.editComment(threadId, 'actually: cite the SLA');

    const instruction = (await svc.prepareDispatch(threadId)).payload.instruction;

    expect(instruction).toBe('actually: cite the SLA');
    expect(instruction).not.toContain('still accurate?');
  });

  test('a single-comment thread sends the bare body, unlabelled', async () => {
    const { threadId } = await makeThread();
    const instruction = (await svc.prepareDispatch(threadId)).payload.instruction;
    expect(instruction).toBe('still accurate?');
  });

  test('complete closes the thread', async () => {
    const { threadId } = await makeThread();
    await svc.prepareDispatch(threadId);
    const meta = await svc.completeDispatch(threadId);

    expect(meta.state).toBe('resolved');
    expect(meta.queued).toBe(false);
    // closing clears the queue in the same write, so a crash between the two
    // cannot leave a resolved thread still sitting in the batch
    expect(await svc.readThread(threadId)).toMatchObject({
      state: 'resolved',
      queued: false,
    });
  });

  test('an orphaned thread is still sent, flagged so the agent is told', async () => {
    const { threadId } = await makeThread();
    bodies.set('notes/rollout', 'nothing to see here');
    const res = await svc.prepareDispatch(threadId);

    // sent by default — the payload carries the quoted words, not a stale offset
    expect(res.payload.anchorLost).toBe(true);
    expect(res.payload.passage.exact).toBe('minimal downtime');
    expect(res.payload.instruction).toBe('still accurate?');
    // the loss is still recorded on the thread, so re-placement stays offerable
    expect(res.meta.state).toBe('orphaned');
    expect((await svc.readThread(threadId)).state).toBe('orphaned');
  });

  test('a delivery the client could not complete leaves the thread open', async () => {
    const { threadId } = await makeThread();
    await svc.prepareDispatch(threadId);
    // client failed to launch the agent → releases the queue instead of completing
    const meta = await svc.unqueue(threadId);

    expect(meta.state).toBe('anchored'); // NOT resolved
    expect(meta.queued).toBe(false);
  });

  test('batch prepare returns results in the requested order', async () => {
    const a = await makeThread('minimal downtime');
    const b = await makeThread('Q3');
    const c = await makeThread('rollout');

    const results = await svc.prepareDispatchBatch([c.threadId, a.threadId, b.threadId]);
    expect(results.map((r) => r.threadId)).toEqual([c.threadId, a.threadId, b.threadId]);
    expect(results.every((r) => r.ok)).toBe(true);
    for (const r of results) if (r.ok) expect(r.payload.docName).toBe('notes/rollout');
  });

  test('one missing id does not fail the rest of the batch', async () => {
    const a = await makeThread('minimal downtime');
    const b = await makeThread('Q3');

    const results = await svc.prepareDispatchBatch([a.threadId, 'gone', b.threadId]);
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    const missing = results[1];
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toBe('not-found');
    // the surviving items really were queued
    expect((await store.readMeta(a.threadId))?.queued).toBe(true);
    expect((await store.readMeta(b.threadId))?.queued).toBe(true);
  });

  test('batch complete resolves every selected thread', async () => {
    const a = await makeThread('minimal downtime');
    const b = await makeThread('Q3');
    await svc.prepareDispatchBatch([a.threadId, b.threadId]);

    const results = await svc.completeDispatchBatch([a.threadId, b.threadId]);
    expect(results.every((r) => r.ok)).toBe(true);
    for (const id of [a.threadId, b.threadId]) {
      const meta = await store.readMeta(id);
      expect(meta?.state).toBe('resolved');
      expect(meta?.queued).toBe(false);
    }
  });

  test('deselected threads stay queued when the batch goes out', async () => {
    const selected = await makeThread('minimal downtime');
    const deselected = await makeThread('Q3');
    await svc.queueForDispatch(deselected.threadId); // queued, but not in the batch

    await svc.prepareDispatchBatch([selected.threadId]);
    await svc.completeDispatchBatch([selected.threadId]);

    expect((await store.readMeta(selected.threadId))?.state).toBe('resolved');
    const left = await store.readMeta(deselected.threadId);
    expect(left?.queued).toBe(true); // still waiting for a later batch
    expect(left?.state).toBe('anchored');
  });

  test('a dispatched thread can be reopened', async () => {
    const { threadId } = await makeThread();
    await svc.prepareDispatch(threadId);
    await svc.completeDispatch(threadId);
    const meta = await svc.reopen(threadId);
    expect(meta.state).toBe('anchored');
  });

  test('reopening re-queues, so the next send carries it without a second click', async () => {
    // A send clears `queued` on its way to `resolved`. Reopening is the
    // correction for a send that did not settle the thing, so the comment comes
    // back in the batch rather than waiting to be ticked again.
    const { threadId } = await makeThread();
    await svc.prepareDispatch(threadId);
    await svc.completeDispatch(threadId);
    expect((await svc.readThread(threadId)).queued).toBe(false);

    expect((await svc.reopen(threadId)).queued).toBe(true);
  });

  test('a reopened thread that lost its passage is queued and orphaned', async () => {
    // Reopen re-finds, and a resolved thread's anchor is not maintained — so the
    // passage can be gone by now. It still ships: the dispatch tells the agent
    // the anchor was lost, which is more use than a comment silently held back.
    const { threadId } = await makeThread();
    await svc.prepareDispatch(threadId);
    await svc.completeDispatch(threadId);
    bodies.set('notes/rollout', 'Nothing of the original passage survives here.');

    const meta = await svc.reopen(threadId);
    expect(meta.state).toBe('orphaned');
    expect(meta.queued).toBe(true);
  });
});

describe('CommentService — renameDoc (US-12)', () => {
  test('threads follow a renamed doc in both the index and the cover sheets', async () => {
    const a = await makeThread('minimal downtime');
    const b = await makeThread('Q3');
    expect(index.threadsForDoc('notes/rollout').sort()).toEqual([a.threadId, b.threadId].sort());

    await svc.renameDoc('notes/rollout', 'notes/rollout-2026');

    expect(index.threadsForDoc('notes/rollout')).toEqual([]);
    expect(index.threadsForDoc('notes/rollout-2026').sort()).toEqual(
      [a.threadId, b.threadId].sort(),
    );
    expect((await store.readMeta(a.threadId))?.docName).toBe('notes/rollout-2026');
    expect((await store.readMeta(b.threadId))?.docName).toBe('notes/rollout-2026');
  });

  test('is a no-op when the doc has no threads', async () => {
    await expect(svc.renameDoc('empty', 'empty-2')).resolves.toBeUndefined();
  });
});

describe('CommentService — delete', () => {
  test('removes the thread from store and index', async () => {
    const { threadId } = await makeThread();
    await svc.delete(threadId);
    expect(index.threadsForDoc('notes/rollout')).toEqual([]);
    await expect(svc.readThread(threadId)).rejects.toBeInstanceOf(ThreadNotFoundError);
  });
});

describe('CommentService — property threads', () => {
  async function makePropertyThread(key = 'tags') {
    return svc.createThread({
      docName: 'notes/rollout',
      propertyKey: key,
      author: 'principal-abc',
      body: 'these tags are stale',
    });
  }

  test('a property thread stores its key and carries NO anchor', async () => {
    const meta = await makePropertyThread();
    expect(meta.target).toEqual({ kind: 'property', key: 'tags', path: [] });
    // The absence is the point: a filler anchor would let a re-find path that
    // forgot to branch go looking for "tags" in the prose and match it.
    expect(meta.anchor).toBeNull();
    expect(meta.state).toBe('anchored');
  });

  test('a body thread still records a body target, so old threads keep working', async () => {
    const meta = await makeThread();
    expect(meta.target).toEqual({ kind: 'body' });
    expect(meta.anchor).not.toBeNull();
  });

  test('refuses a key the document does not declare', async () => {
    await expect(makePropertyThread('nonexistent')).rejects.toBeInstanceOf(PropertyNotFoundError);
  });

  test('editing the body never orphans a property thread', async () => {
    const { threadId } = await makePropertyThread();
    // The passage a body comment would have pointed at is gone; the key is not.
    bodies.set('notes/rollout', 'Entirely different prose.');
    await svc.refindDoc('notes/rollout');
    expect((await svc.readThread(threadId)).state).toBe('anchored');
  });

  test('removing the key orphans it, and restoring the key recovers it', async () => {
    const { threadId } = await makePropertyThread();
    frontmatter.set('notes/rollout', { title: 'Rollout notes' });
    await svc.refindDoc('notes/rollout');
    expect((await svc.readThread(threadId)).state).toBe('orphaned');

    frontmatter.set('notes/rollout', { title: 'Rollout notes', tags: ['infra', 'q3'] });
    await svc.refindDoc('notes/rollout');
    expect((await svc.readThread(threadId)).state).toBe('anchored');
  });

  test('unreadable frontmatter leaves the state alone rather than orphaning', async () => {
    const { threadId } = await makePropertyThread();
    frontmatter.delete('notes/rollout');
    await svc.refindDoc('notes/rollout');
    // A doc that could not be read is not evidence the key is gone — the same
    // contract the body path applies to an unreadable body.
    expect((await svc.readThread(threadId)).state).toBe('anchored');
  });

  test('dispatch names the key and sends no passage', async () => {
    const { threadId } = await makePropertyThread();
    const { payload } = await svc.prepareDispatch(threadId);
    expect(payload.property).toBe('tags');
    expect(payload.passage).toBeNull();
    expect(payload.anchorLost).toBe(false);
    // A key is unique in its frontmatter, so the which-occurrence question the
    // body path answers cannot arise.
    expect(payload.passageRepeats).toBe(false);
  });

  test('dispatch reports a removed key as lost rather than withholding it', async () => {
    const { threadId } = await makePropertyThread();
    frontmatter.set('notes/rollout', { title: 'Rollout notes' });
    const { payload } = await svc.prepareDispatch(threadId);
    expect(payload.property).toBe('tags');
    expect(payload.anchorLost).toBe(true);
  });

  test('re-placement onto a passage is refused', async () => {
    const { threadId } = await makePropertyThread();
    // Re-placement moves a comment onto fresh prose, which would silently change
    // what a property comment is about.
    await expect(svc.replaceAnchor(threadId, { quote: 'minimal downtime' })).rejects.toBeInstanceOf(
      PropertyNotFoundError,
    );
  });
});

describe('CommentService — property paths and value passages', () => {
  async function makeThreadAt(
    propertyKey: string,
    propertyPath: (string | number)[],
    quote?: string,
  ) {
    return svc.createThread({
      docName: 'notes/rollout',
      propertyKey,
      propertyPath,
      quote,
      author: 'principal-abc',
      body: 'note',
    });
  }

  test('a path addresses one list item', async () => {
    const meta = await makeThreadAt('tags', [1]);
    expect(meta.target).toEqual({ kind: 'property', key: 'tags', path: [1] });
    expect(meta.anchor).toBeNull();
  });

  test('a path addresses a nested field', async () => {
    const meta = await makeThreadAt('author', ['name']);
    expect(meta.target).toEqual({ kind: 'property', key: 'author', path: ['name'] });
  });

  test('an index past the end of the list is refused', async () => {
    await expect(makeThreadAt('tags', [9])).rejects.toBeInstanceOf(PropertyNotFoundError);
  });

  test('a list shrinking past the index orphans the thread', async () => {
    const { threadId } = await makeThreadAt('tags', [1]);
    frontmatter.set('notes/rollout', { tags: ['infra'] });
    await svc.refindDoc('notes/rollout');
    expect((await svc.readThread(threadId)).state).toBe('orphaned');
  });

  test('a quote inside a value anchors against THAT value, not the body', async () => {
    const meta = await makeThreadAt('summary', [], 'Ships in Q3');
    expect(meta.anchor?.exact).toBe('Ships in Q3');
    // Offsets index the value: 'Ships in Q3' starts at 0 of the summary, and
    // nowhere near that in the document body.
    expect(meta.anchor?.start).toBe(0);
  });

  test('editing the value elsewhere keeps the passage anchored', async () => {
    const { threadId } = await makeThreadAt('summary', [], 'Ships in Q3');
    frontmatter.set('notes/rollout', {
      summary: 'Update: Ships in Q3. Downtime should be minimal.',
    });
    await svc.refindDoc('notes/rollout');
    // The settle sweep reports state only. It deliberately does NOT re-capture
    // the position — same policy the body path documents, and for the same
    // reason: the offsets are a hint, and refreshing them on every settle would
    // mean a write per thread per keystroke burst.
    expect((await svc.readThread(threadId)).state).toBe('anchored');
  });

  test('the per-thread re-find refreshes the moved offsets', async () => {
    const { threadId } = await makeThreadAt('summary', [], 'Ships in Q3');
    frontmatter.set('notes/rollout', {
      summary: 'Update: Ships in Q3. Downtime should be minimal.',
    });
    // Where the hint IS refreshed — the path a load or a dispatch takes, so what
    // reaches an agent is never measured against stale text.
    const meta = await svc.refindOnLoad(threadId);
    expect(meta.anchor?.start).toBe('Update: '.length);
    expect(meta.anchor?.exact).toBe('Ships in Q3');
  });

  test('removing the quoted words orphans it, while the key survives', async () => {
    const { threadId } = await makeThreadAt('summary', [], 'Ships in Q3');
    frontmatter.set('notes/rollout', { summary: 'Timing to be confirmed.' });
    await svc.refindDoc('notes/rollout');
    expect((await svc.readThread(threadId)).state).toBe('orphaned');
  });

  test('a value that stops being text orphans a passage anchored in it', async () => {
    const { threadId } = await makeThreadAt('summary', [], 'Ships in Q3');
    // The field became a list. The words cannot be there, and serializing the
    // list to search it would anchor into punctuation nobody ever saw.
    frontmatter.set('notes/rollout', { summary: ['Ships in Q3'] });
    await svc.refindDoc('notes/rollout');
    expect((await svc.readThread(threadId)).state).toBe('orphaned');
  });

  test('quoting into a container is refused at create time', async () => {
    await expect(makeThreadAt('tags', [], 'infra')).rejects.toBeInstanceOf(PropertyNotFoundError);
  });

  test('dispatch names the path and carries the value passage', async () => {
    const { threadId } = await makeThreadAt('summary', [], 'Ships in Q3');
    const { payload } = await svc.prepareDispatch(threadId);
    expect(payload.property).toBe('summary');
    expect(payload.passage?.exact).toBe('Ships in Q3');
  });

  test('dispatch renders a nested path the way a human reads it', async () => {
    const { threadId } = await makeThreadAt('author', ['name']);
    const { payload } = await svc.prepareDispatch(threadId);
    expect(payload.property).toBe('author.name');
    expect(payload.passage).toBeNull();
  });

  test('dispatch renders a list index the way a human reads it', async () => {
    const { threadId } = await makeThreadAt('tags', [1]);
    const { payload } = await svc.prepareDispatch(threadId);
    expect(payload.property).toBe('tags[1]');
  });
});
