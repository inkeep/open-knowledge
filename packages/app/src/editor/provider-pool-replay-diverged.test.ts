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

const BASE_MD = '# Notes\n\nSettled paragraph.\n';
const BUFFERED_MD = '# Notes\n\nSettled paragraph.\n\nUnsynced source-mode line.\n';
const BUFFERED_MARKER = 'Unsynced source-mode line.';
const MOVED_MD = '# Notes\n\nA different paragraph, authored elsewhere.\n';
const MOVED_MARKER = 'authored elsewhere';

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

    await vi.waitFor(() => {
      expect(replaySettled()).toBe(true);
    });

    expect(ytext.toString()).toContain(MOVED_MARKER);
    expect(emittedEvents(warn)).toContain('ok-buffer-replay-diverged');
    expect(emittedEvents(warn)).not.toContain('ok-buffer-replay-content-applied');
    expect(emittedEvents(info)).toContain('ok-pool-buffer-replay-delta-applied');
  });

  it('splices the same buffer when the server content has NOT moved', async () => {
    const { ytext } = armReplay(BASE_MD);

    await vi.waitFor(() => {
      expect(emittedEvents(warn)).toContain('ok-buffer-replay-content-applied');
    });
    expect(ytext.toString()).toContain(BUFFERED_MARKER);
    expect(emittedEvents(warn)).not.toContain('ok-buffer-replay-diverged');
  });
});

describe('content-level replay of an edit the comparator cannot see', () => {
  const BLANK_RUN_MD = '# Notes\n\n\n\nSettled paragraph.\n';

  it('recovers buffered blank lines the server state lacks', async () => {
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
 * A WYSIWYG edit is a `Y.Text` splice like any other, so the client never
 * writes the fragment and it cannot serve as a witness. The acked base is
 * therefore recorded on purpose — snapshotted at each `synced`, carried on the
 * buffer and through the durable outbox — and it is what makes "has the server
 * moved past this buffer?" decidable.
 *
 * All three arms are pinned here, the refusal included: without a witness that
 * arm is undecidable rather than unnecessary, and an aged buffer would splice
 * over content the server rebuilt from disk.
 */
describe('content-level replay under the projection binding', () => {
  it('attributes to Y.Text without consulting the fragment', async () => {
    // The buffer's fragment sits at BASE and its Y.Text at BUFFERED. Only the
    // latter is read, so the edit is recovered on the strength of the Y.Text
    // comparison against the recorded base alone.
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
