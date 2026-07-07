/**
 * Divergent rawMdxFallback source preservation.
 *
 * Contract under test: a degradation fallback whose PM content differs from
 * the Y.Text source region it stands for must NOT become authoritative for
 * that region. Concretely, at the server bridge boundary (the only path from
 * XmlFragment to Y.Text — client-side cross-CRDT write paths were deleted
 * under precedent #14):
 *
 *   1. Fragment-change drains driven by interaction inside the fallback
 *      (the RawMdxFallbackCMView forwardUpdate channel) must not destroy the
 *      region's source bytes in Y.Text — neither on a follow-up keystroke
 *      nor on a later ordinary edit elsewhere in the doc, which may
 *      come from a remote peer.
 *   2. Blur-upgrade of an empty divergent fallback (the tryParseUpgrade
 *      channel) must not strip the broken-block chrome from the fragment
 *      while Y.Text still holds the broken source.
 *   3. Bound: a divergent fallback at rest is safe — an edit elsewhere alone
 *      must merge without touching the region (green guard).
 *
 * The fragment-write surface is treated as untrusted (CRDT peers — any
 * client version can write any fragment state), so the contract is pinned
 * here, where every enumerated site of the class routes through, rather
 * than inside the client NodeView.
 *
 * Divergence is fault-injected at the parseWithFallback seam: no organic
 * markdown input produces content-level divergence at HEAD (the
 * fix narrowed producers to dependency/plugin drift), so the proxy below
 * recreates the two degraded shapes real producers emit — the unknown-mdast
 * guard's unresolvedPosition arm (content '') and the blockUnknownHandler
 * sentinel arm ('«unknown:<type>»'). Downstream of that seam the components
 * (Observer A/B, three-way merge, serializer, y-prosemirror write path) are
 * real — but Observer B's re-derive parses through the SAME proxy, so each
 * re-derive re-injects the divergence shape. That models a structural
 * (permanent) divergence faithfully; it also means fragment-side chrome
 * assertions (findFallback) are satisfied by the proxy's re-injection,
 * and the Y.Text-intactness assertions are the load-bearing ones.
 *
 * Tests run under production bridge policy (NODE_ENV=production): the
 * NODE_ENV=test watchdog gates throw at doc load on the injected divergence,
 * which would mask the silent-destruction behavior these tests pin.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { __resetBridgeWatchdogForTests } from './bridge-watchdog.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import { type ObserverDispatchKind, setupServerObservers } from './server-observers.ts';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

/** Origin distinct from every server-side origin: a y-prosemirror client. */
const CLIENT_ORIGIN = { client: 'simulated-y-prosemirror-client' };

const SOURCE = 'Para one.\n\n<Foo>broken</Bar>\n\nPara two.\n';
const BROKEN_BLOCK = '<Foo>broken</Bar>';

// ─── Production-policy env (save/restore) ────────────────────

const ENV_KEYS = ['NODE_ENV', 'OK_BRIDGE_THROW_ON_VIOLATION', 'OK_RETHROW_BRIDGE_LOSS'] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  process.env.NODE_ENV = 'production';
  delete process.env.OK_BRIDGE_THROW_ON_VIOLATION;
  delete process.env.OK_RETHROW_BRIDGE_LOSS;
  // Telemetry isolation: every doc here is unattributed (no docName), so all
  // tests share the rate-limiter's `__nodoc__` window — without a reset the
  // first test's emission would suppress every later test's.
  resetMetrics();
  __resetBridgeWatchdogForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

// ─── PM JSON helpers ─────────────────────────────────────────

interface PmJson {
  type: string;
  content?: PmJson[];
  text?: string;
  attrs?: Record<string, unknown>;
}

function findFallback(node: PmJson): PmJson | null {
  if (node.type === 'rawMdxFallback') return node;
  for (const child of node.content ?? []) {
    const hit = findFallback(child);
    if (hit) return hit;
  }
  return null;
}

function fragmentJson(xmlFragment: Y.XmlFragment): PmJson {
  return yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON() as PmJson;
}

function writeFragment(doc: Y.Doc, xmlFragment: Y.XmlFragment, json: PmJson): void {
  const pmNode = schema.nodeFromJSON(json);
  doc.transact(() => {
    const meta = { mapping: new Map(), isOMark: new Map() };
    updateYFragment(doc, xmlFragment, pmNode, meta);
  }, CLIENT_ORIGIN);
}

// ─── Divergence producer (fault injection at the parseWithFallback seam) ───

type DivergenceShape = (fallback: PmJson) => void;

/** Guard unresolvedPosition arm: degraded fallback with empty content. */
const guardEmptyShape: DivergenceShape = (fallback) => {
  fallback.content = [];
};

/** blockUnknownHandler sentinel arm: fabricated placeholder content. */
const sentinelShape: DivergenceShape = (fallback) => {
  fallback.content = [{ type: 'text', text: '«unknown:someFutureType»' }];
};

/**
 * Counted fault controller for the `serialize` seam. `arm(n)` makes the next
 * n `mdManager.serialize(...)` calls throw a synthetic non-bridge error, then
 * disarm — modeling a serializer that fails mid-drain (e.g. dependency/plugin
 * drift) without module mocking. Observer A serializes the fragment at the
 * top of its sync work; an armed throw there lands in the error-recovery
 * catch before the settlement check, while Y.Text still holds the source
 * bytes — the exact precondition for the false-witness hazard. `arm(2)` also
 * fails the catch's recovery serialize, exercising the last-resort path.
 */
function makeSerializeFault() {
  let armed = 0;
  let fired = false;
  return {
    arm(times = 1) {
      armed = times;
    },
    get fired() {
      return fired;
    },
    maybeThrow() {
      if (armed > 0) {
        armed -= 1;
        fired = true;
        throw new Error('injected serialize failure');
      }
    },
  };
}
type SerializeFault = ReturnType<typeof makeSerializeFault>;

function makeDegradedManager(diverge: DivergenceShape, fault?: SerializeFault): MarkdownManager {
  return new Proxy(mdManager, {
    get(target, prop, receiver) {
      if (prop === 'parseWithFallback') {
        return (markdown: string, opts?: Parameters<MarkdownManager['parseWithFallback']>[1]) => {
          const json = target.parseWithFallback(markdown, opts) as PmJson;
          const fallback = findFallback(json);
          if (fallback) diverge(fallback);
          return json;
        };
      }
      if (prop === 'serialize' && fault) {
        return (json: Parameters<MarkdownManager['serialize']>[0]) => {
          fault.maybeThrow();
          return target.serialize(json);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

// ─── Scenario plumbing ───────────────────────────────────────

function loadDivergentDoc(
  diverge: DivergenceShape,
  onDispatch?: (kind: ObserverDispatchKind) => void,
  fault?: SerializeFault,
) {
  const doc = new Y.Doc();
  const xmlFragment = doc.getXmlFragment('default');
  const ytext = doc.getText('source');
  const cleanup = setupServerObservers({
    doc,
    xmlFragment,
    ytext,
    mdManager: makeDegradedManager(diverge, fault),
    schema,
    onDispatch,
  });
  doc.transact(() => {
    ytext.insert(0, SOURCE);
  }, CLIENT_ORIGIN);
  return { doc, xmlFragment, ytext, cleanup };
}

/**
 * Wait until the bridge stops mutating doc state (two consecutive identical
 * samples), so a fix that schedules settlement work asynchronously gets room
 * to run. The current synchronous dispatch passes on the first sample.
 */
async function quiesce(xmlFragment: Y.XmlFragment, ytext: Y.Text): Promise<void> {
  const snapshot = () => `${JSON.stringify(fragmentJson(xmlFragment))}\n${ytext.toString()}`;
  let prev = snapshot();
  const deadline = Date.now() + 250;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const current = snapshot();
    if (current === prev) return;
    prev = current;
  }
}

/**
 * Simulate the forwardUpdate channel: after a keystroke, the fallback
 * NodeView's CodeMirror pushes its full text back into the PM node. Append
 * semantics — the user types at the end of whatever the editor currently
 * shows — so the simulation stays faithful to user intent regardless of what
 * the fallback's content is at dispatch time.
 */
function typeIntoFallback(doc: Y.Doc, xmlFragment: Y.XmlFragment, char: string): void {
  const json = fragmentJson(xmlFragment);
  const fallback = findFallback(json);
  if (!fallback) throw new Error('expected a rawMdxFallback node in the fragment');
  const current = (fallback.content ?? []).map((child) => child.text ?? '').join('');
  fallback.content = [{ type: 'text', text: current + char }];
  writeFragment(doc, xmlFragment, json);
}

/** Simulate an ordinary WYSIWYG edit in the trailing paragraph (same or remote peer). */
function appendToLastParagraph(doc: Y.Doc, xmlFragment: Y.XmlFragment, suffix: string): void {
  const json = fragmentJson(xmlFragment);
  const last = json.content?.[json.content.length - 1];
  const textNode = last?.content?.[0];
  if (!textNode?.text) throw new Error('expected trailing paragraph text');
  textNode.text += suffix;
  writeFragment(doc, xmlFragment, json);
}

// ─── Tests ───────────────────────────────────────────────────

describe('divergent rawMdxFallback must not become authoritative source', () => {
  test('S4: typing twice into a divergent fallback preserves the source bytes it stands for', async () => {
    const { doc, xmlFragment, ytext, cleanup } = loadDivergentDoc(guardEmptyShape);

    typeIntoFallback(doc, xmlFragment, 'x');
    await quiesce(xmlFragment, ytext);
    typeIntoFallback(doc, xmlFragment, 'y');
    await quiesce(xmlFragment, ytext);

    const after = ytext.toString();
    expect(after).toContain(BROKEN_BLOCK);
    // Once-only: surviving is not enough — a baseline-poisoning regression
    // could ALSO duplicate the region on re-merge (the documented Path-B
    // failure mode when baseline witnesses content already in Y.Text).
    expect(after.split(BROKEN_BLOCK).length - 1).toBe(1);
    expect(after).toContain('Para one.');
    expect(after).toContain('Para two.');

    cleanup();
  });

  test('protective re-derive dispatches a-then-b within the same drain', () => {
    const dispatches: ObserverDispatchKind[] = [];
    const { doc, xmlFragment, ytext, cleanup } = loadDivergentDoc(guardEmptyShape, (kind) =>
      dispatches.push(kind),
    );

    dispatches.length = 0;
    // Fresh counters + rate window so the assertion below pins THIS
    // keystroke's drain exactly — doc load may already have fired a
    // rederive, and its emission would both pre-count and suppress ours.
    resetMetrics();
    __resetBridgeWatchdogForTests();
    typeIntoFallback(doc, xmlFragment, 'x');

    // No quiesce() between the keystroke and the assertions: dispatch is
    // synchronous, so the protective re-derive must have landed before
    // transact returned. A refactor that deferred the re-derive to a
    // separate (async) drain would fail here — and would widen the
    // split-brain window remote peers can observe from zero to the gap
    // between drains. Inner OBSERVER_SYNC_ORIGIN drains report 'none'.
    const userDispatches = dispatches.filter((kind) => kind !== 'none');
    expect(userDispatches).toEqual(['a', 'b']);
    expect(ytext.toString()).toContain(BROKEN_BLOCK);
    // The settlement check that enqueued the re-derive is operator-visible,
    // and exactly one emission belongs to this drain — a regression that
    // re-routes the increment to a different drain (e.g. doc load) fails.
    expect(getMetrics().bridgeSplitBrainRederives).toBe(1);

    cleanup();
  });

  test('S4 sentinel producer: «unknown:type»-shaped divergence is equally protected', async () => {
    const { doc, xmlFragment, ytext, cleanup } = loadDivergentDoc(sentinelShape);

    typeIntoFallback(doc, xmlFragment, 'x');
    await quiesce(xmlFragment, ytext);
    typeIntoFallback(doc, xmlFragment, 'y');
    await quiesce(xmlFragment, ytext);

    const after = ytext.toString();
    expect(after).toContain(BROKEN_BLOCK);
    // The sentinel placeholder is UI chrome, not source — leaking it into
    // the persisted bytes would be user-visible corruption.
    expect(after).not.toContain('«unknown:someFutureType»');

    cleanup();
  });

  test('S6: one fallback keystroke then an ordinary edit elsewhere preserves the source bytes', async () => {
    const { doc, xmlFragment, ytext, cleanup } = loadDivergentDoc(guardEmptyShape);

    typeIntoFallback(doc, xmlFragment, 'x');
    await quiesce(xmlFragment, ytext);
    appendToLastParagraph(doc, xmlFragment, ' EDITED');
    await quiesce(xmlFragment, ytext);

    const after = ytext.toString();
    expect(after).toContain(BROKEN_BLOCK);
    expect(after.split(BROKEN_BLOCK).length - 1).toBe(1);
    expect(after).toContain('EDITED');

    cleanup();
  });

  test('S5: blur-upgrade on an empty divergent fallback keeps Y.Text intact and keeps the broken-block chrome', async () => {
    const { doc, xmlFragment, ytext, cleanup } = loadDivergentDoc(guardEmptyShape);

    // tryParseUpgrade parses the CodeMirror text ('' for the degraded
    // fallback) and replaces the fallback node with the parsed blocks — an
    // empty paragraph.
    const upgraded = mdManager.parseWithFallback('') as PmJson;
    const json = fragmentJson(xmlFragment);
    const fallback = findFallback(json);
    if (!fallback) throw new Error('expected a rawMdxFallback node in the fragment');
    const index = json.content?.indexOf(fallback) ?? -1;
    if (index < 0 || !json.content || !upgraded.content) {
      throw new Error('expected top-level fallback and upgrade content');
    }
    json.content.splice(index, 1, ...upgraded.content);
    writeFragment(doc, xmlFragment, json);
    await quiesce(xmlFragment, ytext);

    // Y.Text must be byte-identical — blur-upgrade writes only the fragment,
    // so any Y.Text movement at all (duplication, paragraph loss) is a
    // regression in the identity-gate path.
    expect(ytext.toString()).toBe(SOURCE);
    // ...so the fragment must still expose the broken block to the user —
    // the error chrome is the only handle on the unrenderable region.
    expect(findFallback(fragmentJson(xmlFragment))).not.toBeNull();

    cleanup();
  });

  test('S3 bound: a divergent fallback at rest is safe — an edit elsewhere alone merges cleanly', async () => {
    const { doc, xmlFragment, ytext, cleanup } = loadDivergentDoc(guardEmptyShape);

    appendToLastParagraph(doc, xmlFragment, ' EDITED');
    await quiesce(xmlFragment, ytext);

    // At rest (no fallback interaction), the merge must be byte-exact: the
    // edit lands and NOTHING else about the source moves.
    expect(ytext.toString()).toBe(SOURCE.replace('Para two.', 'Para two. EDITED'));

    cleanup();
  });

  test('error-recovery: a serialize throw during a fallback drain must not let the baseline reset destroy the source bytes', async () => {
    const fault = makeSerializeFault();
    const { doc, xmlFragment, ytext, cleanup } = loadDivergentDoc(
      guardEmptyShape,
      undefined,
      fault,
    );

    // A keystroke into the divergent fallback drives an Observer A drain. The
    // armed fault makes the fragment serialize throw at the top of that drain
    // — before the settlement check, while Y.Text still holds the source
    // bytes. The throw lands in the error-recovery catch. The unguarded reset
    // (`lastSyncedXmlMd = ytext.toString()`) would witness the divergent
    // Y.Text as a known-good baseline; the next ordinary drain's Path A gate
    // would then match and rewrite Y.Text toward the fallback-derived
    // serialization, destroying the source bytes.
    fault.arm();
    typeIntoFallback(doc, xmlFragment, 'x');
    await quiesce(xmlFragment, ytext);
    // Pin that the fault actually fired — otherwise the assertion below would
    // pass trivially without ever exercising the recovery path.
    expect(fault.fired).toBe(true);

    // A subsequent ordinary edit elsewhere is the drain that, with a poisoned
    // baseline, performs the destructive Path A rewrite.
    appendToLastParagraph(doc, xmlFragment, ' EDITED');
    await quiesce(xmlFragment, ytext);

    const after = ytext.toString();
    expect(after).toContain(BROKEN_BLOCK);
    expect(after.split(BROKEN_BLOCK).length - 1).toBe(1);
    expect(after).toContain('Para one.');
    expect(after).toContain('EDITED');

    cleanup();
  });

  test('error-recovery double failure: when the recovery serialize also throws, the next drain still preserves the source bytes', async () => {
    const fault = makeSerializeFault();
    const { doc, xmlFragment, ytext, cleanup } = loadDivergentDoc(
      guardEmptyShape,
      undefined,
      fault,
    );

    // Both the drain's serialize AND the catch's recovery serialize throw —
    // the last-resort path. No canonical form is computable, so the baseline
    // falls back to the unknown sentinel; the next ordinary drain must route
    // Path B (merge-protective) rather than treating any stale witness as a
    // license for a wholesale Path A rewrite.
    fault.arm(2);
    typeIntoFallback(doc, xmlFragment, 'x');
    await quiesce(xmlFragment, ytext);
    expect(fault.fired).toBe(true);

    appendToLastParagraph(doc, xmlFragment, ' EDITED');
    await quiesce(xmlFragment, ytext);

    const after = ytext.toString();
    expect(after).toContain(BROKEN_BLOCK);
    expect(after.split(BROKEN_BLOCK).length - 1).toBe(1);
    expect(after).toContain('Para one.');
    expect(after).toContain('EDITED');

    cleanup();
  });

  test('identity-gate dispatch pin: blur-upgrade fires a same-drain a-then-b re-derive with one counted emission', async () => {
    const dispatches: ObserverDispatchKind[] = [];
    const { doc, xmlFragment, ytext, cleanup } = loadDivergentDoc(guardEmptyShape, (kind) =>
      dispatches.push(kind),
    );

    const upgraded = mdManager.parseWithFallback('') as PmJson;
    const json = fragmentJson(xmlFragment);
    const fallback = findFallback(json);
    if (!fallback) throw new Error('expected a rawMdxFallback node in the fragment');
    const index = json.content?.indexOf(fallback) ?? -1;
    if (index < 0 || !json.content || !upgraded.content) {
      throw new Error('expected top-level fallback and upgrade content');
    }
    json.content.splice(index, 1, ...upgraded.content);

    dispatches.length = 0;
    resetMetrics();
    __resetBridgeWatchdogForTests();
    writeFragment(doc, xmlFragment, json);

    // The blur-upgrade drain's serialization is unchanged, so detection runs
    // at the identity-gate exit — it must enqueue the re-derive into the SAME
    // drain (synchronous; no quiesce before these assertions) and count
    // exactly one emission for this drain.
    const userDispatches = dispatches.filter((kind) => kind !== 'none');
    expect(userDispatches).toEqual(['a', 'b']);
    expect(getMetrics().bridgeSplitBrainRederives).toBe(1);
    expect(findFallback(fragmentJson(xmlFragment))).not.toBeNull();
    expect(ytext.toString()).toBe(SOURCE);

    cleanup();
  });
});
