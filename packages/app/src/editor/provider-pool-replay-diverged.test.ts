/**
 * The divergence bail in the content-level replay's surface attribution.
 *
 * `replayBufferedContent` recovers a pre-recycle edit by deciding which CRDT
 * surface holds it: whichever surface still MATCHES the fresh server content is
 * the base, and the other one carries the edit. When NEITHER surface matches,
 * that inference is unavailable — the buffer was captured against a document
 * state the server has since moved past — and splicing either candidate would
 * overwrite live content with an aged snapshot. The bail refuses the splice and
 * emits `ok-buffer-replay-diverged`, leaving the caller's delta fallback (which
 * merges rather than replaces) as the terminal path.
 *
 * Every other replay test builds its replica against an EMPTY provider doc, so
 * the fragment surface always compares clean and the third arm never runs. Both
 * arms here share one buffer and vary only what the provider holds: unmoved
 * content splices, moved content bails.
 */
import { randomUUID } from 'node:crypto';
import { MarkdownManager } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { updateYFragment } from '@tiptap/y-tiptap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { sharedExtensions } from './extensions/shared.ts';
import { ProviderPool } from './provider-pool';

const DUMMY_WS = 'ws://localhost:1/collab';
const schema = getSchema(sharedExtensions);
const mdManager = new MarkdownManager({ extensions: sharedExtensions });

/** The document both surfaces of the buffer were captured against. */
const BASE_MD = '# Notes\n\nSettled paragraph.\n';
/** The un-drained source-mode edit living in the buffer's `Y.Text`. */
const BUFFERED_MD = '# Notes\n\nSettled paragraph.\n\nUnsynced source-mode line.\n';
/** A line that exists ONLY in the buffer — its arrival marks a splice. */
const BUFFERED_MARKER = 'Unsynced source-mode line.';
/**
 * What the post-restart server rebuilt from disk. Shares no body line with
 * `BASE_MD`, so the buffer's fragment surface no longer matches it either —
 * the ambiguity the bail exists for.
 */
const MOVED_MD = '# Notes\n\nA different paragraph, authored elsewhere.\n';
/** A line that exists ONLY on the server — its survival marks a refusal. */
const MOVED_MARKER = 'authored elsewhere';

/**
 * A pre-recycle replica whose two surfaces disagree: the fragment sits at
 * `baseMd` (the acked base) while `Y.Text` carries `editedMd` (the unsynced
 * source-mode edit). That is the shape the attribution is written to resolve.
 */
function buildTwoSurfaceState(
  baseMd: string,
  editedMd: string,
): { delta: Uint8Array; fullState: Uint8Array } {
  const doc = new Y.Doc();
  doc.transact(() => {
    doc.getText('source').insert(0, editedMd);
    updateYFragment(
      doc,
      doc.getXmlFragment('default'),
      schema.nodeFromJSON(mdManager.parse(baseMd)),
      {
        mapping: new Map(),
        isOMark: new Map(),
      },
    );
  });
  const fullState = Y.encodeStateAsUpdate(doc);
  const delta = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(new Y.Doc()));
  doc.destroy();
  return { delta, fullState };
}

/** Structured client events the pool emits (recovery → warn, breadcrumb → info). */
function emittedEvents(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.flatMap(([first]) => {
    if (typeof first !== 'string') return [];
    try {
      const parsed = JSON.parse(first) as { event?: unknown };
      return typeof parsed.event === 'string' ? [parsed.event] : [];
    } catch {
      return [];
    }
  });
}

let pool: ProviderPool;
let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;

/** True once the replay has reached one of its two terminal outcomes. */
function replaySettled(): boolean {
  const seen = [...emittedEvents(warn), ...emittedEvents(info)];
  return (
    seen.includes('ok-buffer-replay-content-applied') ||
    seen.includes('ok-pool-buffer-replay-delta-applied')
  );
}

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  pool?.dispose();
  vi.restoreAllMocks();
});

/**
 * Open a doc, seed the provider's live `Y.Text`, and arm the RAM replay buffer.
 *
 * `base` is the acked base recorded on the buffer. The fragment-path rows leave
 * it unset — that path attributes through the fragment and never reads it — so
 * only the projection rows pass one.
 */
function armReplay(
  serverContent: string,
  opts: { base?: string | undefined } = {},
): { docName: string; ytext: Y.Text } {
  const docName = `pp-diverged-${randomUUID()}`;
  const { delta, fullState } = buildTwoSurfaceState(BASE_MD, BUFFERED_MD);
  pool = new ProviderPool(3, DUMMY_WS);
  const entry = pool.open(docName);
  if (!entry) throw new Error('expected entry');
  entry.observerCleanup = () => {};
  const ytext = entry.provider.document.getText('source');
  ytext.insert(0, serverContent);
  pool.__test_seedBufferedUpdate(docName, delta, {
    fullState,
    durable: false,
    ...(opts.base !== undefined ? { base: opts.base } : {}),
  });
  entry.provider.emit('synced', { state: true });
  return { docName, ytext };
}

describe('content-level replay against content the server has moved past', () => {
  it('refuses the splice and reports the divergence', async () => {
    const { ytext } = armReplay(MOVED_MD);

    // Settle on the replay's terminal event, whichever it is — waiting on the
    // refusal itself would make every assertion below unreachable in the world
    // where the bail is gone, which is the world they exist to fail in.
    await vi.waitFor(() => {
      expect(replaySettled()).toBe(true);
    });

    // The refusal is the point: the live server content is still there. A
    // splice would have deleted it and written the aged buffer over the top.
    expect(ytext.toString()).toContain(MOVED_MARKER);
    expect(emittedEvents(warn)).toContain('ok-buffer-replay-diverged');
    // ...and the aged edit was never spliced in as content.
    expect(emittedEvents(warn)).not.toContain('ok-buffer-replay-content-applied');
    // The replay ran all the way to the terminal fallback rather than stopping
    // early — without this, "no splice" would also be satisfied by a replay
    // that never reached the attribution at all.
    expect(emittedEvents(info)).toContain('ok-pool-buffer-replay-delta-applied');
  });

  it('splices the same buffer when the server content has NOT moved', async () => {
    // Same buffer, same code path, one variable changed: the provider still
    // holds the base the fragment was captured at, so the attribution resolves
    // and the unsynced edit is recovered. This is what the arm above refuses.
    const { ytext } = armReplay(BASE_MD);

    await vi.waitFor(() => {
      expect(emittedEvents(warn)).toContain('ok-buffer-replay-content-applied');
    });
    expect(ytext.toString()).toContain(BUFFERED_MARKER);
    expect(emittedEvents(warn)).not.toContain('ok-buffer-replay-diverged');
  });
});

describe('content-level replay of an edit the comparator cannot see', () => {
  /** The buffered edit is blank lines and nothing else. */
  const BLANK_RUN_MD = '# Notes\n\n\n\nSettled paragraph.\n';

  it('recovers buffered blank lines the server state lacks', async () => {
    // The surface comparison collapses blank runs on both sides, so this edit
    // reads as "already there" and the recycle would drop it with no event and
    // no checkpoint. It is only visible to the direction check.
    const docName = `pp-blank-${randomUUID()}`;
    const { delta, fullState } = buildTwoSurfaceState(BASE_MD, BLANK_RUN_MD);
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    const ytext = entry.provider.document.getText('source');
    ytext.insert(0, BASE_MD);
    pool.__test_seedBufferedUpdate(docName, delta, { fullState, durable: false });
    entry.provider.emit('synced', { state: true });

    await vi.waitFor(() => {
      expect(emittedEvents(warn)).toContain('ok-buffer-replay-content-applied');
    });
    expect(ytext.toString()).toContain('# Notes\n\n\n\nSettled paragraph.');
    expect(emittedEvents(warn)).not.toContain('ok-buffer-replay-diverged');
  });
});

/**
 * The same attribution under the projection binding, where there is only one
 * CRDT surface to attribute to.
 *
 * A WYSIWYG edit under the flag is a `Y.Text` splice like any other, so the
 * fragment is no longer written by the client and stops being available as a
 * witness. What it was actually supplying was not a second opinion about the
 * edit — it was a standing record of the ACKED BASE, because only the server's
 * Observer B ever wrote it. That is what made "the server has moved past this
 * buffer" decidable.
 *
 * So the base is recorded deliberately instead: snapshotted at each `synced`
 * and carried on the buffer (and through the durable outbox). All three arms
 * survive the change of witness, which is what these rows pin — including the
 * refusal, which would otherwise have become undecidable rather than
 * unnecessary, and let an aged buffer splice over content the server rebuilt
 * from disk.
 */
describe('content-level replay under the projection binding', () => {
  // This suite runs without a DOM, so the flag comes from the env channel
  // rather than the `window.__okProjectionBinding` one.
  beforeEach(() => {
    vi.stubEnv('VITE_OK_PROJECTION_BINDING', '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('attributes to Y.Text without consulting the fragment', async () => {
    // The buffer's fragment sits at BASE and its Y.Text at BUFFERED. Under the
    // flag only the latter is read, so the edit is recovered on the strength of
    // the Y.Text comparison against the recorded base alone.
    const { ytext } = armReplay(BASE_MD, { base: BASE_MD });

    await vi.waitFor(() => {
      expect(emittedEvents(warn)).toContain('ok-buffer-replay-content-applied');
    });
    expect(ytext.toString()).toContain(BUFFERED_MARKER);
    expect(emittedEvents(warn)).not.toContain('ok-buffer-replay-diverged');
  });

  it('refuses the splice when the server has moved past the recorded base', async () => {
    // The row the base witness exists for. Identical to the fragment path's
    // refusal: the server was rebuilt from a disk state authored elsewhere, so
    // the buffer's base no longer describes it and the edit cannot be placed.
    const { ytext } = armReplay(MOVED_MD, { base: BASE_MD });

    await vi.waitFor(() => {
      expect(replaySettled()).toBe(true);
    });

    expect(emittedEvents(warn)).toContain('ok-buffer-replay-diverged');
    expect(emittedEvents(warn)).not.toContain('ok-buffer-replay-content-applied');
    // The live content survives — this is the whole point of the arm.
    expect(ytext.toString()).toContain(MOVED_MARKER);
    expect(emittedEvents(info)).toContain('ok-pool-buffer-replay-delta-applied');
  });

  it('refuses rather than splicing blind when no base was recorded', async () => {
    // A buffer captured before the doc ever reached `synced`, or read back from
    // an outbox record written before the base field existed. "No witness" must
    // decline, not fall through to an unconditional splice — the delta fallback
    // merges, where this would replace.
    armReplay(BASE_MD, { base: undefined });

    await vi.waitFor(() => {
      expect(replaySettled()).toBe(true);
    });

    expect(emittedEvents(warn)).toContain('ok-buffer-replay-diverged');
    expect(emittedEvents(warn)).not.toContain('ok-buffer-replay-content-applied');
    // Declining is not the same as losing the edit: the caller falls through to
    // the delta apply, which MERGES rather than replaces. That is the whole
    // reason declining is safe — assert the fallback ran, not that nothing
    // landed.
    expect(emittedEvents(info)).toContain('ok-pool-buffer-replay-delta-applied');
  });
});
