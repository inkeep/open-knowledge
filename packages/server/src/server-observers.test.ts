/**
 * Unit tests for the server-authoritative observer bridge (server-observers.ts).
 *
 * Tests cover:
 *   - Settlement-based dispatch on `afterAllTransactions` (precedent #13(b))
 *   - Baseline-refresh semantics for Path A / Path B / paired-write / self-sync
 *   - Path A vs Path B dispatch
 *   - Origin-guard truth table
 *   - No infinite loop on self-origin
 *   - Agent paired-write early-exit
 *   - Paired-write short-circuit symmetry across Observer A + Observer B
 *   - Frontmatter sync (Observer B → Y.Map, Observer A reads Y.Map)
 *   - Cleanup detaches observers and the settlement handler
 *   - Observer B error-recovery branches
 *
 * Uses a synthetic Y.Doc (no Hocuspocus). Observer dispatch happens
 * synchronously after each `doc.transact()` drain via the new
 * `afterAllTransactions` settlement listener — tests assert post-transact
 * state directly with no scheduler flushing.
 */
import { describe, expect, test } from 'bun:test';
import type { LocalTransactionOrigin } from '@hocuspocus/server';
import {
  MarkdownManager,
  normalizeBridge,
  prependFrontmatter,
  readFmMap,
  sharedExtensions,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { AGENT_WRITE_ORIGIN } from './agent-sessions.ts';
import { MANAGED_RENAME_ORIGIN, ROLLBACK_ORIGIN } from './api-extension.ts';
import { composeAndWriteRawBody } from './bridge-intake.ts';
import { __resetBridgeWatchdogForTests } from './bridge-watchdog.ts';
import { FILE_WATCHER_ORIGIN } from './external-change.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import {
  OBSERVER_SYNC_ORIGIN,
  type ObserverDispatchKind,
  type SetupServerObserversOpts,
  setupServerObservers,
  shouldRethrowBridgeMergeLoss,
} from './server-observers.ts';

// ─── Test helpers ────────────────────────────────────────────

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

/**
 * Capture the settlement dispatcher's decisions for a single test.
 * Returned `dispatches` accumulates in the order the settlement handler fires.
 */
function createDispatchRecorder() {
  const dispatches: ObserverDispatchKind[] = [];
  const onDispatch = (kind: ObserverDispatchKind): void => {
    dispatches.push(kind);
  };
  return { dispatches, onDispatch };
}

/** Create a test doc with XmlFragment and Y.Text plus a dispatch recorder. */
function createTestDoc() {
  const doc = new Y.Doc();
  const xmlFragment = doc.getXmlFragment('default');
  const ytext = doc.getText('source');
  const recorder = createDispatchRecorder();
  return { doc, xmlFragment, ytext, recorder };
}

function setupOpts(
  overrides: Partial<SetupServerObserversOpts> & {
    doc: Y.Doc;
    xmlFragment: Y.XmlFragment;
    ytext: Y.Text;
    recorder: ReturnType<typeof createDispatchRecorder>;
  },
): SetupServerObserversOpts {
  const { recorder, ...rest } = overrides;
  return {
    mdManager,
    schema,
    onDispatch: recorder.onDispatch,
    ...rest,
  };
}

/** Populate XmlFragment with markdown content via updateYFragment. */
function populateFragment(doc: Y.Doc, xmlFragment: Y.XmlFragment, md: string): void {
  const json = mdManager.parse(md);
  const pmNode = schema.nodeFromJSON(json);
  const meta = { mapping: new Map(), isOMark: new Map() };
  updateYFragment(doc, xmlFragment, pmNode, meta);
}

// ─── Tests ───────────────────────────────────────────────────

describe('Server Observer A — XmlFragment → Y.Text', () => {
  test('Observer A settles synchronously after each transact; multiple rapid edits each fire once', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    let writeCount = 0;
    doc.on('afterTransaction', (tx: Y.Transaction) => {
      if (tx.origin === OBSERVER_SYNC_ORIGIN) writeCount++;
    });

    // Each populateFragment call is its own doc.transact drain → one user
    // settle fire. The inner OBSERVER_SYNC_ORIGIN write that Observer A's
    // sync performs produces its own drain whose observers self-skip; that
    // drain's settlement dispatcher fires 'none'. Filter noise for the
    // user-visible dispatch assertion.
    populateFragment(doc, xmlFragment, '# First\n');
    populateFragment(doc, xmlFragment, '# First\n\nSecond\n');
    populateFragment(doc, xmlFragment, '# First\n\nSecond\n\nThird\n');

    const userDispatches = recorder.dispatches.filter((k) => k !== 'none');
    expect(userDispatches).toEqual(['a', 'a', 'a']);
    expect(writeCount).toBe(3);
    expect(ytext.toString()).toContain('Third');

    cleanup();
  });

  test('Path A: uses diffLines when Y.Text matches baseline', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();

    // Set up with initial content (baseline picks up the current XmlFragment
    // state during setupServerObservers initialization).
    populateFragment(doc, xmlFragment, '# Hello\n');
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    // Initial sync populated Y.Text from XmlFragment.
    expect(ytext.toString()).toContain('Hello');

    // Modify XmlFragment — Y.Text is at baseline (matches lastSyncedYTextBytes)
    populateFragment(doc, xmlFragment, '# Hello\n\nNew paragraph\n');

    expect(ytext.toString()).toContain('New paragraph');

    cleanup();
  });

  test('Path B: uses DMP three-way merge when Y.Text diverged from baseline', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();

    populateFragment(doc, xmlFragment, '# Hello\n\nOriginal\n');
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    // Diverge Y.Text under OBSERVER_SYNC_ORIGIN (simulates a prior Observer B
    // write that changed Y.Text without updating XmlFragment baseline — the
    // diverged state). OBSERVER_SYNC_ORIGIN is self-origin so observers
    // short-circuit and no settlement dispatch runs.
    doc.transact(() => {
      const text = ytext.toString();
      ytext.insert(text.length, '\nAgent addition\n');
    }, OBSERVER_SYNC_ORIGIN);

    // Now modify XmlFragment (user WYSIWYG edit) — triggers Observer A.
    // Observer A sees lastSyncedYTextBytes !== currentText (Y.Text diverged) → Path B
    populateFragment(doc, xmlFragment, '# Hello\n\nOriginal\n\nUser edit\n');

    // Path B merges: user's delta (add "User edit") applied to diverged Y.Text
    const result = ytext.toString();
    expect(result).toContain('Agent addition');
    expect(result).toContain('User edit');

    cleanup();
  });

  test('Path B emits observer-a-path-b-fired telemetry (FR-41)', () => {
    // Reset the watchdog rate-limiter — the per-doc emit gate
    // (`shouldEmitObserverAPathBFired`) shares module-level state across
    // tests. Without the reset, a prior test's emission for the same docName
    // (or the `__nodoc__` sentinel here) could suppress this one.
    __resetBridgeWatchdogForTests();
    resetMetrics();

    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const before = getMetrics().observerAPathBFires;

    populateFragment(doc, xmlFragment, '# Hello\n\nOriginal\n');
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    // Capture console.warn output for the duration of the Path B fire.
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    try {
      // Diverge Y.Text under OBSERVER_SYNC_ORIGIN (silent — observers self-skip).
      doc.transact(() => {
        ytext.insert(ytext.toString().length, '\nAgent addition\n');
      }, OBSERVER_SYNC_ORIGIN);
      // User WYSIWYG edit triggers Observer A → Path B (Y.Text diverged from baseline).
      populateFragment(doc, xmlFragment, '# Hello\n\nOriginal\n\nUser edit\n');
    } finally {
      console.warn = originalWarn;
    }

    const events = warnings
      .map((w) => {
        try {
          return JSON.parse(w);
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, unknown> => e !== null);
    const pathBEvents = events.filter((e) => e.event === 'observer-a-path-b-fired');
    expect(pathBEvents.length).toBeGreaterThanOrEqual(1);
    const pathBEvent = pathBEvents[0];
    expect(pathBEvent).toBeDefined();
    expect(pathBEvent?.xmlFragmentAdvanced).toBe(true);
    expect(pathBEvent?.ytextDiverged).toBe(true);
    expect(typeof pathBEvent?.mergeBytesChanged).toBe('number');
    // OTel-dotted convention — matches sibling persistence + watchdog event
    // payloads. Null when the doc isn't attributed (test setup omits docName).
    expect(pathBEvent?.['doc.name']).toBeNull();

    // Bounded cardinality: only allowed keys + values are bounded primitives.
    const keys = Object.keys(pathBEvent ?? {}).sort();
    expect(keys).toEqual(
      ['doc.name', 'event', 'mergeBytesChanged', 'xmlFragmentAdvanced', 'ytextDiverged'].sort(),
    );

    // Counter incremented by exactly the number of emitted Path B events.
    // `observerAPathBFires` is bumped only on emit (matching the
    // bridge-invariant-violation pattern), so the equality holds because we
    // reset the rate-limiter at the top of this test and every fire here
    // escapes the gate.
    expect(getMetrics().observerAPathBFires).toBe(before + pathBEvents.length);
    // No suppressions — the rate-limiter window is fresh.
    expect(getMetrics().observerAPathBFiresSuppressed).toBe(0);

    cleanup();
  });

  test('observer-a-path-b-fired event is rate-limited per doc; counter still tracks every fire', () => {
    // Regression guard for the missing rate-limiter.
    // Before the fix, every Path B fire emitted unconditionally, drowning
    // the log under multi-peer concurrent editing. After the fix, the
    // structured-log emission is gated per doc through
    // `shouldEmitObserverAPathBFired`; the counter still increments on
    // every fire so `actual_rate = fires + suppressed` holds.
    __resetBridgeWatchdogForTests();
    resetMetrics();

    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    populateFragment(doc, xmlFragment, '# Hello\n\nOriginal\n');
    const cleanup = setupServerObservers(
      setupOpts({ doc, xmlFragment, ytext, recorder, docName: 'rate-limit-test-doc' }),
    );

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    try {
      // Drive THREE Path B fires back-to-back. Each diverges Y.Text under
      // self-origin and then triggers Observer A via a user XmlFragment edit.
      for (let i = 0; i < 3; i++) {
        doc.transact(() => {
          ytext.insert(ytext.toString().length, `\nDivergence ${i}\n`);
        }, OBSERVER_SYNC_ORIGIN);
        populateFragment(doc, xmlFragment, `# Hello\n\nOriginal\n\nUser edit ${i}\n`);
      }
    } finally {
      console.warn = originalWarn;
    }

    const events = warnings
      .map((w) => {
        try {
          return JSON.parse(w);
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, unknown> => e !== null);
    const pathBEvents = events.filter((e) => e.event === 'observer-a-path-b-fired');

    // Rate-limiter: many Path B fires within the default 60s window all
    // collapse to a single emitted structured-log event; subsequent fires
    // increment the suppressed counter. Exact fire count depends on inner
    // observer dispatch (each user edit can drive multiple settlement
    // dispatches via baseline refresh + paired-write merge writeback);
    // the load-bearing assertions are:
    //   (1) at most ONE event escapes the gate (proves rate-limiting works);
    //   (2) the emit counter equals exactly that one event (matching the
    //       bridge-invariant-violation pattern: increments only on emit);
    //   (3) the suppressed counter accounts for the rest;
    //   (4) the documented identity `fires + suppressed = total` holds.
    expect(pathBEvents.length).toBe(1);
    expect(getMetrics().observerAPathBFires).toBe(1);
    expect(getMetrics().observerAPathBFiresSuppressed).toBeGreaterThanOrEqual(2);
    // Documented identity: actual_rate = fires + suppressed. After the fix,
    // exactly one fire emitted and every subsequent fire incremented
    // suppressed, so `fires + suppressed` equals the true Path-B fire total.
    const totalFires =
      getMetrics().observerAPathBFires + getMetrics().observerAPathBFiresSuppressed;
    expect(totalFires).toBeGreaterThanOrEqual(3);

    cleanup();
  });

  test('Path A does NOT emit observer-a-path-b-fired (only Path B emits)', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const before = getMetrics().observerAPathBFires;

    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    try {
      // Pure XmlFragment edit with Y.Text in sync (Path A — diffLines path).
      populateFragment(doc, xmlFragment, '# Hello\n');
    } finally {
      console.warn = originalWarn;
    }

    const events = warnings
      .map((w) => {
        try {
          return JSON.parse(w);
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, unknown> => e !== null);
    expect(events.filter((e) => e.event === 'observer-a-path-b-fired')).toHaveLength(0);
    expect(getMetrics().observerAPathBFires).toBe(before);

    cleanup();
  });

  test('already-in-sync gate: when Y.Text matches XmlFragment, no observer write', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    // Write both sides to the same content in one transact — observers fire
    // (non-paired origin) and settlement dispatches; Observer A's sync reads
    // XmlFragment serialization (equals Y.Text after normalization) and
    // early-exits via the normalize gate without writing.
    const content = '# Paired\n\nContent\n';
    doc.transact(() => {
      populateFragment(doc, xmlFragment, content);
      ytext.delete(0, ytext.length);
      ytext.insert(0, content);
    });

    let writeCount = 0;
    doc.on('afterTransaction', (tx: Y.Transaction) => {
      if (tx.origin === OBSERVER_SYNC_ORIGIN) writeCount++;
    });

    // Redundant XmlFragment mutation to the same content → already-in-sync
    // gate fires; no new Y.Text write.
    populateFragment(doc, xmlFragment, content);
    expect(writeCount).toBe(0);

    cleanup();
  });
});

describe('Server Observer B — Y.Text → XmlFragment', () => {
  test('each Y.Text transact fires Observer B once, producing expected XmlFragment content', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    let writeCount = 0;
    doc.on('afterTransaction', (tx: Y.Transaction) => {
      if (tx.origin === OBSERVER_SYNC_ORIGIN) writeCount++;
    });

    // Simulate three Y.Text edits in separate transacts — each fires one
    // user settlement dispatch with 'b'. Observer B's XmlFragment write
    // under OBSERVER_SYNC_ORIGIN produces an inner drain whose observers
    // self-skip; that drain dispatches 'none'. Filter the noise.
    doc.transact(() => {
      ytext.insert(0, '# Title\n');
    });
    doc.transact(() => {
      ytext.insert(ytext.length, '\nParagraph\n');
    });
    doc.transact(() => {
      ytext.insert(ytext.length, '\nMore\n');
    });

    const userDispatches = recorder.dispatches.filter((k) => k !== 'none');
    expect(userDispatches).toEqual(['b', 'b', 'b']);
    expect(writeCount).toBe(3);

    // Verify coalesced state: XmlFragment contains all three pieces.
    const json = yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON();
    const body = mdManager.serialize(json);
    expect(body).toContain('Title');
    expect(body).toContain('Paragraph');
    expect(body).toContain('More');

    cleanup();
  });

  test('frontmatter: Observer B leaves the YAML region of Y.Text intact (Y.Text IS the FM source — D8)', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    // Input avoids the blank line between FM and body — that pattern would
    // trip the bridge-invariant watchdog because mdast can't represent
    // "blank line at start of body" so `parse(body) → serialize(...)` drops
    // it. Y.Text holds the user's intended source-form bytes either way
    // (the contract); FM region is detected and preserved either way (the
    // test's actual focus).
    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, '---\ntitle: My Page\n---\n# Hello\n\nWorld\n');
    });

    // FM region in Y.Text round-trips verbatim; the parsed map matches what
    // was written.
    expect(stripFrontmatter(ytext.toString()).frontmatter).toBe('---\ntitle: My Page\n---\n');
    expect(readFmMap(ytext.toString())).toEqual({ title: 'My Page' });

    cleanup();
  });

  test('frontmatter: post-load Y.Text carries FM + body verbatim (D8 — Y.Text IS the FM source)', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();

    // Production load flow (persistence.onLoadDocument): both XmlFragment
    // (body) and Y.Text (full file: FM + body) populate during the load
    // transaction. Mirror that here.
    populateFragment(doc, xmlFragment, '# Hello\n\nContent\n');
    doc.transact(() => {
      ytext.insert(0, '---\ntitle: Test\n---\n# Hello\n\nContent\n');
    });

    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    // Y.Text carries the FM region as the source of truth.
    expect(ytext.toString()).toContain('---\ntitle: Test\n---\n');
    expect(ytext.toString()).toContain('Hello');

    cleanup();
  });

  test('early-exit: XmlFragment unchanged when Y.Text body already matches', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();

    populateFragment(doc, xmlFragment, '# Hello\n');
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    // After initial sync, Y.Text has the XmlFragment content.
    const serializedBody = mdManager.serialize(
      yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON(),
    );

    // Trigger Observer B with a no-op Y.Text mutation (insert + delete same char).
    doc.transact(() => {
      ytext.insert(ytext.length, ' ');
      ytext.delete(ytext.length - 1, 1);
    });

    // Observer B's normalize-gate early-exit keeps XmlFragment unchanged.
    expect(
      mdManager.serialize(yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON()),
    ).toBe(serializedBody);

    cleanup();
  });

  test('canonicalization preserves literal bracket text in Y.Text', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    doc.transact(() => {
      ytext.insert(0, '[[Page\n');
    });

    expect(ytext.toString()).not.toContain('\\[');
    expect(normalizeBridge(ytext.toString())).toBe('[[Page');
    expect(
      normalizeBridge(
        mdManager.serialize(yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON()),
      ),
    ).toBe('[[Page');

    cleanup();
  });

  test('canonicalization preserves empty-label inline links in Y.Text', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    doc.transact(() => {
      ytext.insert(0, 'see []() and [](x)\n');
    });

    expect(ytext.toString()).toBe('see []() and [](x)\n');
    expect(
      normalizeBridge(
        mdManager.serialize(yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON()),
      ),
    ).toBe('see []() and [](x)');

    cleanup();
  });

  test('canonicalization preserves trailing backslash text in Y.Text', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));
    const triple = '\\'.repeat(3);

    doc.transact(() => {
      ytext.insert(0, `text ${triple}\n`);
    });

    expect(ytext.toString()).toBe(`text ${triple}\n`);
    expect(
      normalizeBridge(
        mdManager.serialize(yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON()),
      ),
    ).toBe(`text ${triple}`);

    cleanup();
  });
});

describe('Origin-guard truth table (§7d)', () => {
  test('OBSERVER_SYNC_ORIGIN self-write does NOT produce a second observer fire', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    let syncOriginCount = 0;
    doc.on('afterTransaction', (tx: Y.Transaction) => {
      if (tx.origin === OBSERVER_SYNC_ORIGIN) syncOriginCount++;
    });

    populateFragment(doc, xmlFragment, '# Test\n');

    // Observer A writes Y.Text under OBSERVER_SYNC_ORIGIN; Observer B's callback
    // self-skips, no recursion. The user's mutation itself is NOT OBSERVER_SYNC_ORIGIN.
    // Exactly one OBSERVER_SYNC_ORIGIN transaction (A's write); no recursive fires.
    expect(syncOriginCount).toBe(1);

    cleanup();
  });

  test('AGENT_WRITE_ORIGIN paired write: Observer A produces no additional write', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    let syncWriteCount = 0;
    doc.on('afterTransaction', (tx: Y.Transaction) => {
      if (tx.origin === OBSERVER_SYNC_ORIGIN) syncWriteCount++;
    });

    // Simulate applyAgentMarkdownWrite: write both XmlFragment + Y.Text atomically.
    const rawContent = '# Agent\n\nAgent wrote this.\n';
    const json = mdManager.parse(rawContent);
    const pmNode = schema.nodeFromJSON(json);
    const normalizedContent = mdManager.serialize(json);
    const dispatchesBefore = recorder.dispatches.length;
    doc.transact(() => {
      const meta = { mapping: new Map(), isOMark: new Map() };
      updateYFragment(doc, xmlFragment, pmNode, meta);
      ytext.delete(0, ytext.length);
      ytext.insert(0, normalizedContent);
    }, AGENT_WRITE_ORIGIN);

    // Paired-write short-circuit: both observers refreshed baseline in-callback
    // and declined to set dirty flags. Settlement dispatcher saw no dirty work
    // and fired 'none'. No OBSERVER_SYNC_ORIGIN write.
    expect(syncWriteCount).toBe(0);
    expect(recorder.dispatches.slice(dispatchesBefore)).toEqual(['none']);

    cleanup();
  });

  test('FILE_WATCHER_ORIGIN paired write: Observer A produces no additional write', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    let syncWriteCount = 0;
    doc.on('afterTransaction', (tx: Y.Transaction) => {
      if (tx.origin === OBSERVER_SYNC_ORIGIN) syncWriteCount++;
    });

    const rawContent = '# External\n\nFrom disk.\n';
    const json = mdManager.parse(rawContent);
    const pmNode = schema.nodeFromJSON(json);
    const normalizedContent = mdManager.serialize(json);
    const dispatchesBefore = recorder.dispatches.length;
    doc.transact(() => {
      const meta = { mapping: new Map(), isOMark: new Map() };
      updateYFragment(doc, xmlFragment, pmNode, meta);
      ytext.delete(0, ytext.length);
      ytext.insert(0, normalizedContent);
    }, FILE_WATCHER_ORIGIN);

    expect(syncWriteCount).toBe(0);
    expect(recorder.dispatches.slice(dispatchesBefore)).toEqual(['none']);

    cleanup();
  });

  test('paired-write race: concurrent Y.Text mutation (historical seed 1776325179241 shape) does not duplicate content', () => {
    // Regression for the fuzz seed characterization.
    //
    // Scenario: an AGENT_WRITE_ORIGIN transaction atomically writes both
    // XmlFragment and Y.Text. Before the paired-write branch landed on
    // Observer A, a concurrent Y.Text mutation landing in the debounce window
    // would cause the next runObserverASync firing to see a stale baseline
    // (lastSyncedYTextBytes frozen at pre-agent-write state) and take Path B —
    // duplicating the agent's just-written content.
    //
    // Under the settlement dispatcher, there is no debounce window — but the
    // paired-write short-circuit still matters for (a) typed structural
    // hygiene, (b) avoiding redundant re-serialization work on every paired
    // transact, and (c) future-proofing against async extensions of the
    // settlement model. The convergence assertion catches a whole class
    // of regressions; the broader validation happens in the fuzz
    // harness (`bridge-convergence.fuzz.test.ts`).
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    // Seed with initial content.
    const seedContent = 'seed paragraph\n';
    const seedJson = mdManager.parse(seedContent);
    const seedNode = schema.nodeFromJSON(seedJson);
    doc.transact(() => {
      const meta = { mapping: new Map(), isOMark: new Map() };
      updateYFragment(doc, xmlFragment, seedNode, meta);
      ytext.delete(0, ytext.length);
      ytext.insert(0, mdManager.serialize(seedJson));
    }, AGENT_WRITE_ORIGIN);

    // Step 1: paired-write appending "M0-alpha echo".
    const afterOp0 = 'seed paragraph\n\nM0-alpha echo\n';
    const op0Json = mdManager.parse(afterOp0);
    const op0Node = schema.nodeFromJSON(op0Json);
    const op0Canonical = mdManager.serialize(op0Json);
    doc.transact(() => {
      const meta = { mapping: new Map(), isOMark: new Map() };
      updateYFragment(doc, xmlFragment, op0Node, meta);
      ytext.delete(0, ytext.length);
      ytext.insert(0, op0Canonical);
    }, AGENT_WRITE_ORIGIN);

    // Step 2: client source-type Y.Text mutation (paused client delivering a
    // queued append via CRDT merge — origin: undefined / local=false
    // equivalent).
    doc.transact(() => {
      ytext.insert(ytext.length, '\n\nM1-golf hotel\n');
    });

    // Zero-tolerance oracle: "M0-alpha echo" must appear exactly ONCE in the
    // final Y.Text state. Duplication would be e.g.
    // "seed paragraph\n\nM0-alpha echo\nM0-alpha echo\n\nM1-golf hotel\n".
    const finalText = ytext.toString();
    const occurrences = finalText.split('M0-alpha echo').length - 1;
    expect(occurrences).toBe(1);
    // And M1-golf hotel must be present — Observer B should have propagated the source-type edit.
    expect(finalText).toContain('M1-golf hotel');

    cleanup();
  });

  // ── paired-write regression tests ──
  //
  // T8/T9/T10 exercise the paired-write observer-layer contract for each
  // paired origin: paired transactions produce a 'none' settlement dispatch
  // (observer callbacks refreshed baseline synchronously, neither dirty flag
  // was set).
  // removing either Observer A's OR Observer B's paired-write branch — fires
  // 'a' or 'b' dispatches here and breaks these assertions. The broader
  // race-class detection lives in `bridge-convergence.fuzz.test.ts` (fuzz
  // harness samples the continuous interleaving space that unit tests
  // cannot enumerate per precedent #13(d)).

  function runPairedWriteShortCircuitTest(origin: LocalTransactionOrigin, marker: string): void {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    // Seed doc with baseline content under AGENT_WRITE_ORIGIN — also a
    // paired-write origin, so it fires 'none' too.
    const seedContent = 'seed paragraph\n';
    const seedJson = mdManager.parse(seedContent);
    const seedNode = schema.nodeFromJSON(seedJson);
    doc.transact(() => {
      const meta = { mapping: new Map(), isOMark: new Map() };
      updateYFragment(doc, xmlFragment, seedNode, meta);
      ytext.delete(0, ytext.length);
      ytext.insert(0, mdManager.serialize(seedJson));
    }, AGENT_WRITE_ORIGIN);

    // Paired write under the target origin — atomically writes BOTH
    // XmlFragment and Y.Text in a single transact (mirrors the production
    // call sites: applyExternalChange, rollback, managed-rename).
    const afterPaired = `seed paragraph\n\n${marker}\n`;
    const pairedJson = mdManager.parse(afterPaired);
    const pairedNode = schema.nodeFromJSON(pairedJson);
    const pairedCanonical = mdManager.serialize(pairedJson);
    const dispatchesBefore = recorder.dispatches.length;
    doc.transact(() => {
      const meta = { mapping: new Map(), isOMark: new Map() };
      updateYFragment(doc, xmlFragment, pairedNode, meta);
      ytext.delete(0, ytext.length);
      ytext.insert(0, pairedCanonical);
    }, origin);

    // Paired-write short-circuit: the ONLY dispatch produced by the paired
    // transact is 'none'. (revert either paired-write branch)
    // produces 'a', 'b', or both instead.
    expect(recorder.dispatches.slice(dispatchesBefore)).toEqual(['none']);

    // Now simulate a concurrent non-paired XmlFragment mutation arriving in
    // the same tick — mimics a remote WYSIWYG keystroke landing right after
    // the paired write. Under the settlement dispatcher, this is its own
    // drain that fires 'a'.
    doc.transact(() => {
      const cur = ytext.toString();
      const nextContent = `${cur}\nconcurrent-edit\n`;
      const nextJson = mdManager.parse(nextContent);
      const nextNode = schema.nodeFromJSON(nextJson);
      const meta = { mapping: new Map(), isOMark: new Map() };
      updateYFragment(doc, xmlFragment, nextNode, meta);
    });

    const finalText = ytext.toString();
    // Paired-write marker must appear exactly once — no duplication from a
    // stale-baseline Path B merge.
    expect(finalText.split(marker).length - 1).toBe(1);
    // Concurrent WYSIWYG edit must survive — Observer A propagated it to Y.Text.
    expect(finalText).toContain('concurrent-edit');

    cleanup();
  }

  test('T8 — FILE_WATCHER paired-write: paired drain dispatches none (both observer branches short-circuit)', () => {
    runPairedWriteShortCircuitTest(FILE_WATCHER_ORIGIN, 'T8-file-watcher marker');
  });

  test('T9 — ROLLBACK paired-write: paired drain dispatches none', () => {
    runPairedWriteShortCircuitTest(ROLLBACK_ORIGIN, 'T9-rollback marker');
  });

  test('T10 — MANAGED_RENAME paired-write: paired drain dispatches none', () => {
    runPairedWriteShortCircuitTest(MANAGED_RENAME_ORIGIN, 'T10-managed-rename marker');
  });

  test('remote-arrived (no origin, local=false equivalent) triggers Observer A sync', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    // Simulate a remote client edit arriving (no origin)
    populateFragment(doc, xmlFragment, '# Remote edit\n');

    expect(ytext.toString()).toContain('Remote edit');

    cleanup();
  });
});

describe('shouldRethrowBridgeMergeLoss (D3-LOCKED polarity)', () => {
  // Regression guard for bridge-correctness. The gate
  // used to be `process.env.NODE_ENV !== 'production'`, which inverted
  // under Bun because `bun run` / `open-knowledge start` leave
  // NODE_ENV undefined — production users would have seen the loud-throw
  // path at the exact moment a merge dropped content. These tests pin the
  // affirmative contract: only `NODE_ENV=test` or the explicit
  // `OK_RETHROW_BRIDGE_LOSS=1` opt-in trigger a rethrow.
  test('undefined NODE_ENV falls through to silent-checkpoint path (Bun prod default)', () => {
    expect(shouldRethrowBridgeMergeLoss({} as NodeJS.ProcessEnv)).toBe(false);
  });

  test('NODE_ENV=production falls through to silent-checkpoint path', () => {
    expect(shouldRethrowBridgeMergeLoss({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(
      false,
    );
  });

  test('NODE_ENV=development falls through to silent-checkpoint path', () => {
    expect(shouldRethrowBridgeMergeLoss({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(
      false,
    );
  });

  test('NODE_ENV=test triggers rethrow (bun test default)', () => {
    expect(shouldRethrowBridgeMergeLoss({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(true);
  });

  test('OK_RETHROW_BRIDGE_LOSS=1 triggers rethrow regardless of NODE_ENV', () => {
    expect(
      shouldRethrowBridgeMergeLoss({
        NODE_ENV: 'production',
        OK_RETHROW_BRIDGE_LOSS: '1',
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  test('OK_RETHROW_BRIDGE_LOSS=0 does not trigger rethrow', () => {
    expect(shouldRethrowBridgeMergeLoss({ OK_RETHROW_BRIDGE_LOSS: '0' } as NodeJS.ProcessEnv)).toBe(
      false,
    );
  });
});

describe('Cleanup', () => {
  test('cleanup detaches observers and the settlement handler', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    // Pre-cleanup mutation settles normally.
    populateFragment(doc, xmlFragment, '# Pre-cleanup\n');
    expect(ytext.toString()).toContain('Pre-cleanup');
    const dispatchesBefore = recorder.dispatches.length;

    cleanup();

    // Post-cleanup mutation must not fire the settlement handler.
    let writeCount = 0;
    doc.on('afterTransaction', (tx: Y.Transaction) => {
      if (tx.origin === OBSERVER_SYNC_ORIGIN) writeCount++;
    });

    populateFragment(doc, xmlFragment, '# After cleanup\n');
    expect(writeCount).toBe(0);
    expect(recorder.dispatches.length).toBe(dispatchesBefore);
  });
});

describe('Initial sync', () => {
  test('populates Y.Text from XmlFragment when Y.Text is empty', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();

    // Populate XmlFragment before attaching observers
    populateFragment(doc, xmlFragment, '# Pre-existing\n\nContent here.\n');
    expect(ytext.toString()).toBe('');

    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    // Initial sync should have populated Y.Text synchronously
    expect(ytext.toString()).toContain('Pre-existing');
    expect(ytext.toString()).toContain('Content here');

    cleanup();
  });

  test('does not populate Y.Text when both are empty', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();

    let writeCount = 0;
    doc.on('afterTransaction', (tx: Y.Transaction) => {
      if (tx.origin === OBSERVER_SYNC_ORIGIN) writeCount++;
    });

    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    // No initial sync needed when both are empty
    expect(writeCount).toBe(0);
    expect(ytext.toString()).toBe('');

    cleanup();
  });
});

describe('Server Observer B — error recovery paths', () => {
  // These tests exercise the outer-catch and inner-catch recovery branches
  // added to Observer B's sync work. Both paths are load-bearing: they reset
  // the baseline so the next Observer A cycle computes a correct delta
  // instead of re-applying a failed diff.
  //
  // mdManager.parse() is very tolerant (raw HTML/JSX that fails mdx-js is
  // not rejected by our agnostic-mode pipeline), so we drive the error
  // branches deterministically by wrapping mdManager with a stub that
  // throws on demand.

  /** Wrap mdManager so parse/serialize can be toggled to throw.
   *
   * Observer B calls `parseWithFallback` — the real impl
   * catches parse() errors and produces rawMdxFallback nodes. Tests still
   * need to exercise the outer catch path for unexpected errors escaping
   * parseWithFallback itself (internal RangeError, PM-construction failure,
   * etc.), so the stub's parseWithFallback honours `parseThrow` directly.
   * Serialize errors remain a valid test surface in the post-sync
   * re-serialization block. */
  function createMdManagerStub() {
    let parseThrow: Error | null = null;
    let serializeThrow: Error | null = null;
    const stub: SetupServerObserversOpts['mdManager'] = {
      parse(md: string) {
        if (parseThrow) throw parseThrow;
        return mdManager.parse(md);
      },
      parseWithFallback(md: string) {
        if (parseThrow) throw parseThrow;
        return mdManager.parseWithFallback(md);
      },
      serialize(json: unknown) {
        if (serializeThrow) throw serializeThrow;
        // biome-ignore lint/suspicious/noExplicitAny: delegate to real manager
        return mdManager.serialize(json as any);
      },
    } as unknown as SetupServerObserversOpts['mdManager'];
    return {
      mdManager: stub,
      setParseThrow: (e: Error | null) => {
        parseThrow = e;
      },
      setSerializeThrow: (e: Error | null) => {
        serializeThrow = e;
      },
    };
  }

  test('parse-error on Y.Text change: baseline resets to Y.Text, Observer A does not re-apply', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const stub = createMdManagerStub();

    // Seed with valid content
    populateFragment(doc, xmlFragment, '# Seed\n\nBody.\n');
    const cleanup = setupServerObservers(
      setupOpts({ doc, xmlFragment, ytext, recorder, mdManager: stub.mdManager }),
    );

    const errorsBefore = getMetrics().serverObserverErrorsB;

    // Write end-tag-mismatched MDX — this path froze XmlFragment
    // because the parser threw VFileMessage. `parseWithFallback`
    // produces a rawMdxFallback node for the unparseable span.
    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, '# Still here\n\n<Foo>broken text</Bar>\n');
    });

    // XmlFragment now reflects Y.Text — no freeze, no error counter increment.
    // Post Precedent #14 (server-authoritative observer) + `parseWithFallback`,
    // Observer B ALWAYS writes the XmlFragment — malformed MDX surfaces as
    // `rawMdxFallback` nodes instead of freezing the fragment on last-valid
    // state. This supersedes the pre-#14 "retain last state" assertion. API
    // call updated (`yXmlFragmentToProseMirrorRootNode`
    // replaces deprecated `yXmlFragmentToProsemirrorJSON`).
    expect(getMetrics().serverObserverErrorsB).toBe(errorsBefore);
    const postBody = mdManager.serialize(
      yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON(),
    );
    expect(postBody).toContain('Still here');
    expect(postBody).toContain('<Foo>broken text</Bar>');

    // Recovery: valid MDX written next propagates normally.
    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, '# Recovered\n');
    });

    const finalBody = mdManager.serialize(
      yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON(),
    );
    expect(finalBody).toContain('Recovered');
    // full-recovery assertion: the malformed span is gone, not just
    // appended-past. Rules out a class of bugs where the bridge accumulates
    // content across writes instead of replacing.
    expect(finalBody).not.toContain('<Foo>');

    cleanup();
  });

  test('unknown parse error (non-SyntaxError) increments error counter and resets baseline to XmlFragment', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const stub = createMdManagerStub();

    populateFragment(doc, xmlFragment, '# Seed\n\nBody.\n');
    const cleanup = setupServerObservers(
      setupOpts({ doc, xmlFragment, ytext, recorder, mdManager: stub.mdManager }),
    );

    const errorsBefore = getMetrics().serverObserverErrorsB;

    // Throw a plain Error (NOT SyntaxError/VFileMessage/Invalid-content
    // RangeError) — falls through to outer catch. Suppress the expected
    // console.error so it doesn't pollute test output.
    const originalConsoleError = console.error;
    console.error = () => {};
    stub.setParseThrow(new Error('unexpected parse failure'));

    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, '# Anything\n');
    });

    stub.setParseThrow(null);
    console.error = originalConsoleError;

    // Outer catch: error counter bumped by exactly 1, and baseline was
    // reset to the current XmlFragment state (so Observer A on its next
    // fire computes a fresh, non-stale diff).
    expect(getMetrics().serverObserverErrorsB).toBe(errorsBefore + 1);

    // Prior XmlFragment content remains intact (rollback semantics).
    const postBody = mdManager.serialize(
      yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON(),
    );
    expect(postBody).toContain('Seed');

    // A subsequent valid Y.Text edit converges (baseline recovered).
    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, '# Seed\n\nBody.\n\n## Next\n');
    });
    expect(
      mdManager.serialize(yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON()),
    ).toContain('Next');

    cleanup();
  });

  test('post-sync serialize-error: falls back to input body as Observer A baseline', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const stub = createMdManagerStub();

    populateFragment(doc, xmlFragment, '# Seed\n');
    const cleanup = setupServerObservers(
      setupOpts({ doc, xmlFragment, ytext, recorder, mdManager: stub.mdManager }),
    );

    const errorsBefore = getMetrics().serverObserverErrorsB;

    // Capture the originals — we'll restore after the throw fires so the
    // post-sync serialize path exercises the fallback branch without
    // breaking subsequent reads.
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    // Arm: serialize() will throw exactly once during the post-sync watchdog
    // setup inside runObserverBSync. Under contract, the post-sync
    // step computes `mdManager.serialize(parsedJson)` to derive the canonical
    // fragment view that the watchdog compares against ytext bytes — no
    // longer used to canonicalize-write-back ytext, but still the same
    // serialize call site. That is the call we arm to throw; the soft
    // fallback (set baseline from input body) keeps Observer A's next delta
    // computation coherent.
    let serializeCallCount = 0;
    const originalSerialize = stub.mdManager.serialize;
    stub.mdManager.serialize = ((json: unknown) => {
      serializeCallCount++;
      if (serializeCallCount === 1) {
        throw new Error('simulated serialize failure post-update');
      }
      // biome-ignore lint/suspicious/noExplicitAny: delegate
      return mdManager.serialize(json as any);
    }) as typeof stub.mdManager.serialize;

    // Drive Observer B with a valid Y.Text change so parse succeeds and
    // updateYFragment lands — only the follow-up serialize throws.
    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, '# Seed\n\n## After\n');
    });

    // Restore before any subsequent assertions that serialize.
    stub.mdManager.serialize = originalSerialize;
    console.warn = originalWarn;

    // The warn-branch (post-sync re-serialization failed) fired.
    expect(warnings.some((w) => w.includes('Post-sync re-serialization failed'))).toBe(true);

    // The inner catch does NOT count as a full Observer B error (the main
    // sync succeeded; only the baseline-maintenance re-serialize failed).
    expect(getMetrics().serverObserverErrorsB).toBe(errorsBefore);

    // XmlFragment reflects the new content.
    expect(
      mdManager.serialize(yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON()),
    ).toContain('After');

    // Observer A's baseline was set from the input body (fallback), not
    // the post-update serialize. Verify by making a further edit — if the
    // fallback set a reasonable baseline, subsequent writes converge.
    doc.transact(() => {
      ytext.insert(ytext.length, '\nExtra\n');
    });
    expect(
      mdManager.serialize(yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON()),
    ).toContain('Extra');

    cleanup();
  });

  test('outer-catch recovery on a beyond-tolerance doc clears witness coherence: next in-sync fragment edit does not run a cross-generation residual merge', () => {
    __resetBridgeWatchdogForTests();
    resetMetrics();

    // Beyond-tolerance fixture (a lazy blockquote continuation canonicalizes
    // to a `> `-prefixed line), so a coherent witness pair WOULD qualify for
    // the in-sync residual merge.
    const ngRaw =
      '---\ntitle: NG recovery fixture\n---\n\n# Hello\n\n> Lazy quote\nstays lazy.\n\nBody text stays.\n';
    const doc = new Y.Doc();
    const xmlFragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');
    doc.transact(() => {
      composeAndWriteRawBody(doc, ngRaw, 'file-watcher');
    }, FILE_WATCHER_ORIGIN);

    const stub = createMdManagerStub();
    const recorder = createDispatchRecorder();
    const cleanup = setupServerObservers(
      setupOpts({
        doc,
        xmlFragment,
        ytext,
        recorder,
        mdManager: stub.mdManager,
        docName: 'recovery-ng-coherence',
      }),
    );
    expect(ytext.toString()).toBe(ngRaw);

    // Observer B outer catch: the canonical witness resets from the fragment
    // while the raw witness stays at the seed settlement — the witnesses now
    // span two settlement generations.
    const originalConsoleError = console.error;
    console.error = () => {};
    stub.setParseThrow(new Error('unexpected parse failure'));
    doc.transact(() => {
      ytext.insert(ytext.length, '\nUnabsorbed line.\n');
    });
    stub.setParseThrow(null);
    console.error = originalConsoleError;

    // Y.Text returns byte-exactly to the settled raw witness without an
    // intervening settlement (self-origin write: observers skip it).
    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, ngRaw);
    }, OBSERVER_SYNC_ORIGIN);
    expect(ytext.toString()).toBe(ngRaw);

    // In-sync fragment edit. The cross-generation pair must NOT be treated
    // as coherent: the router falls back to Path A (the pre-split behavior
    // for unusable witness state) — no residual merge, no divergence fire.
    const body = mdManager.serialize(
      yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON(),
    );
    populateFragment(doc, xmlFragment, `${body}\nPost-recovery edit.\n`);

    expect(getMetrics().observerAResidualMergeRuns).toBe(0);
    expect(getMetrics().observerAPathBFires + getMetrics().observerAPathBFiresSuppressed).toBe(0);
    const finalText = ytext.toString();
    expect(finalText).toContain('Post-recovery edit.');
    expect(finalText).not.toContain('Unabsorbed line.');

    cleanup();
  });
});

// ─────────────────────────────────────────────────────────────
// Y.Text-is-truth contract: Observer B is watchdog-only
// ─────────────────────────────────────────────────────────────

describe('Server Observer B — Y.Text-is-truth contract (FR-31)', () => {
  // Under the contract, Observer B Phase 2 (canonicalize-write-back) is
  // deleted. Phase 1 (parse(ytext) → updateYFragment) is preserved. The
  // post-Phase-1 step is now a watchdog assertion that does NOT mutate
  // Y.Text. These tests pin the inversion's contract:
  //   1. Y.Text bytes are preserved verbatim across an Observer B fire
  //      (no canonical-write-back of ytext).
  //   2. The watchdog throws under NODE_ENV=test (asserted via the run
  //      that sees a real divergence pattern — FM-body boundary blank
  //      line). Production swallows + emits rate-limited telemetry.
  //   3. The OBSERVER_SYNC_ORIGIN inner write count is exactly 1 per
  //      Observer B fire (Phase 1's updateYFragment), down from 2 (Phase 1
  //      + Phase 2) before the inversion.

  test('Y.Text bytes preserved verbatim across Observer B (no canonicalize-write-back)', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    // Each input is byte-equal across `parse → serialize` for the relevant
    // PM constructs (no fidelity gap to flag). Watchdog stays quiet.
    const inputs = [
      '# Title\n',
      '__strong via underscores__\n',
      '_emphasis via underscore_\n',
      '`inline` code\n',
      '## H ##\n',
      'A list:\n\n- one\n- two\n',
    ];

    for (const md of inputs) {
      doc.transact(() => {
        ytext.delete(0, ytext.length);
        ytext.insert(0, md);
      });
      // ytext bytes preserved verbatim — no canonicalization fired.
      expect(ytext.toString()).toBe(md);
    }

    cleanup();
  });

  test('OBSERVER_SYNC_ORIGIN write count is exactly 1 per Observer B fire (Phase 1 only)', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    let syncOriginWrites = 0;
    doc.on('afterTransaction', (tx: Y.Transaction) => {
      if (tx.origin === OBSERVER_SYNC_ORIGIN) syncOriginWrites++;
    });

    // One user transact with a fresh Y.Text body. Pre-inversion: Phase 1's
    // updateYFragment (1 write) + Phase 2's applyFastDiff back to ytext
    // (1 write) = 2 writes. Post-inversion: just Phase 1.
    doc.transact(() => {
      ytext.insert(0, '# H\n\nP\n');
    });

    expect(syncOriginWrites).toBe(1);

    cleanup();
  });

  test('watchdog tolerates FM-body boundary blank-line divergence (block-separator-collapse class)', () => {
    // mdast cannot represent the blank line between an FM closer (`---\n`)
    // and the next block construct: `parse(body) → serialize(...)` emits
    // `# Body\n` (no blank); ytext keeps the user's `\n\n# Body\n`. This is
    // the same shape as paragraph→heading boundary divergence, captured by
    // the `block-separator-collapse` equivalence class — `\n[block-marker]`
    // ≡ `\n\n[block-marker]` under `normalizeBridge`. The watchdog must NOT
    // fire on this class.
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    expect(() => {
      doc.transact(() => {
        ytext.delete(0, ytext.length);
        ytext.insert(0, '---\ntitle: foo\n---\n\n# Body\n');
      });
    }).not.toThrow();

    cleanup();
  });

  test('source-mode-style typing produces no mid-burst ytext byte rewrites from Observer B', () => {
    // Pre-inversion: Phase 2's canonicalize-write-back fired on every
    // Observer B drain, replacing ytext bytes with `serialize(parse(body))`.
    // Under contract, Observer B is watchdog-only — no ytext mutation.
    // Five rapid edits should produce zero non-self ytext mutations beyond
    // the user's own inserts.
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    let observerInducedYTextChange = 0;
    ytext.observe((_event: Y.YTextEvent, tx: Y.Transaction) => {
      if (tx.origin === OBSERVER_SYNC_ORIGIN) observerInducedYTextChange++;
    });

    // User typing pattern — one paragraph appended at a time.
    const buffer: string[] = [];
    for (const piece of ['# H\n', '\nA', 'B', 'C\n', '\nD\n']) {
      buffer.push(piece);
      doc.transact(() => {
        ytext.delete(0, ytext.length);
        ytext.insert(0, buffer.join(''));
      });
    }

    expect(observerInducedYTextChange).toBe(0);
    expect(ytext.toString()).toBe(buffer.join(''));

    cleanup();
  });

  test('Y.Text-is-truth: literal `[[Page` survives without backslash-escape (regression: pre-contract Phase 2 dropped these)', () => {
    // Pre-contract behavior was: insert `[[Page` → Phase 2 serializes →
    // gets `\\[\\[Page` (defensive escape) → write that back to ytext →
    // user sees corrupted text in source mode. Contract preserves user
    // bytes verbatim; the backslash-defense was added to `parseWithFallback`
    // years before the contract landed.
    //
    // This regression continues to hold under contract — both for the byte
    // preservation (the contract guarantee) and for the fragment-derive
    // path (parseWithFallback handles unparseable wiki-link-shaped text
    // via rawMdxFallback or literal node, neither of which produces
    // backslash-escaped output).
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    doc.transact(() => {
      ytext.insert(0, '[[Page\n');
    });

    expect(ytext.toString()).toBe('[[Page\n');
    expect(ytext.toString()).not.toContain('\\[');

    cleanup();
  });
});

// ─────────────────────────────────────────────────────────────
// Observer A routing — Path B fires iff Y.Text holds unabsorbed
// changes (divergence semantics)
// ─────────────────────────────────────────────────────────────

describe('Observer A routing — Path B fires iff Y.Text holds unabsorbed changes (FR-3)', () => {
  // These tests seed docs through the PRODUCTION load order: paired-write
  // intake (`composeAndWriteRawBody`) first, observer attach second —
  // persistence seeds in `onLoadDocument`, observers attach in
  // `afterLoadDocument`, so the baseline init inside `setupServerObservers`
  // is the only baseline writer for the seed. The earlier dispatch
  // tests seed exclusively round-trip-byte-stable fixtures, which cannot
  // distinguish the baseline's recorded surface from Y.Text's actual bytes;
  // these fixtures can.
  //
  // Assertions are mechanism-agnostic: they pin WHETHER Path B fired
  // (telemetry event + the fires/suppressed counters, whose sum counts
  // every fire regardless of rate-limiting) plus convergence/no-content-
  // loss. They deliberately do NOT pin the post-sync byte form of residual
  // lines in Y.Text (canonical-vs-raw after a Path A route is an
  // intended-behavior decision owned by the fix design).

  // Residual-bearing fixture: raw bytes are NOT round-trip-byte-stable —
  // canonical serialization strips the trailing spaces on the heading line
  // — but ARE within normalizeBridge tolerance (trailing-whitespace class).
  // (The original FM-join blank-line fixture was retired when doc-boundary
  // capture made that shape round-trip byte-stable.)
  const RESIDUAL_RAW = '---\ntitle: Routing fixture\n---\n\n# Hello   \n\nBody text stays.\n';

  function canonicalOf(raw: string): string {
    const { frontmatter, body } = stripFrontmatter(raw);
    return prependFrontmatter(frontmatter, mdManager.serialize(mdManager.parseWithFallback(body)));
  }

  /** Seed a doc production-order: paired-write intake first, attach second. */
  function seedThenAttach(raw: string, docName: string) {
    const doc = new Y.Doc();
    const xmlFragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');
    doc.transact(() => {
      composeAndWriteRawBody(doc, raw, 'file-watcher');
    }, FILE_WATCHER_ORIGIN);
    const recorder = createDispatchRecorder();
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder, docName }));
    return { doc, xmlFragment, ytext, recorder, cleanup };
  }

  function serializeFragmentBody(xmlFragment: Y.XmlFragment): string {
    return mdManager.serialize(yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON());
  }

  /** Run `fn` capturing emitted observer-a-path-b-fired structured events. */
  function capturePathBEvents(fn: () => void): Record<string, unknown>[] {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      fn();
    } finally {
      console.warn = originalWarn;
    }
    return warnings
      .map((w) => {
        try {
          return JSON.parse(w);
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, unknown> => e !== null)
      .filter((e) => e.event === 'observer-a-path-b-fired');
  }

  /** Total Path B fires — emit-gated counter + suppressed counter covers
   *  every fire even when the per-doc rate-limiter closes. */
  const totalPathBFires = (): number =>
    getMetrics().observerAPathBFires + getMetrics().observerAPathBFiresSuppressed;

  test('residual-bearing doc seeded production-order: first fragment change does not fire Path B and converges', () => {
    __resetBridgeWatchdogForTests();
    resetMetrics();

    // Fixture preconditions — the scenario's trigger shape.
    expect(canonicalOf(RESIDUAL_RAW)).not.toBe(RESIDUAL_RAW);
    expect(normalizeBridge(canonicalOf(RESIDUAL_RAW))).toBe(normalizeBridge(RESIDUAL_RAW));

    const { doc, xmlFragment, ytext, cleanup } = seedThenAttach(
      RESIDUAL_RAW,
      'routing-residual-first-edit',
    );
    // Intake preserved raw bytes verbatim (Y.Text-is-truth) and no Y.Text
    // edit has happened since the paired seed: nothing is unabsorbed.
    expect(ytext.toString()).toBe(RESIDUAL_RAW);

    const firesBefore = totalPathBFires();
    const events = capturePathBEvents(() => {
      populateFragment(
        doc,
        xmlFragment,
        `${serializeFragmentBody(xmlFragment)}\nUser WYSIWYG edit.\n`,
      );
    });

    // Path B fires iff Y.Text holds unabsorbed changes. It holds none.
    expect(events).toHaveLength(0);
    expect(totalPathBFires()).toBe(firesBefore);

    // Convergence + no content loss.
    const finalText = ytext.toString();
    expect(finalText).toContain('User WYSIWYG edit.');
    expect(finalText).toContain('Body text stays.');
    expect(finalText).toContain('# Hello');
    expect(finalText).toContain('title: Routing fixture');

    cleanup();
  });

  test('after Observer B fully absorbs a raw-form source edit, the next fragment change does not fire Path B', () => {
    __resetBridgeWatchdogForTests();
    resetMetrics();

    const canon = canonicalOf(RESIDUAL_RAW);
    const { doc, xmlFragment, ytext, cleanup } = seedThenAttach(canon, 'routing-post-absorb');

    // W2 source-mode edit in raw (non-canonical) form: a heading appended
    // without the canonical blank separator line (`\n##` ≡ `\n\n##` under
    // the block-separator-collapse tolerance class). Parse-VISIBLE: the new
    // heading lands in the fragment, so Observer B full-fires and absorbs it.
    doc.transact(() => {
      ytext.insert(ytext.length, '## Added via source\n');
    });
    expect(serializeFragmentBody(xmlFragment)).toContain('Added via source');

    const firesBefore = totalPathBFires();
    const events = capturePathBEvents(() => {
      populateFragment(
        doc,
        xmlFragment,
        `${serializeFragmentBody(xmlFragment)}\nWysiwyg paragraph.\n`,
      );
    });

    // Y.Text has not changed since Observer B's sync — nothing is
    // unabsorbed, so the fragment change must not fire Path B.
    expect(events).toHaveLength(0);
    expect(totalPathBFires()).toBe(firesBefore);

    const finalText = ytext.toString();
    expect(finalText).toContain('Added via source');
    expect(finalText).toContain('Wysiwyg paragraph.');
    expect(finalText).toContain('Body text stays.');

    cleanup();
  });

  test('control: parse-invisible source edit is real unabsorbed divergence — next fragment change MUST fire Path B', () => {
    // Negative control (must pass before AND after the routing fix —
    // guards against over-fixing): a trailing space inside a body line is
    // within normalizeBridge tolerance, so Observer B early-exits WITHOUT
    // absorbing it — Y.Text genuinely holds an unabsorbed byte change, and
    // the byte-preserving Path B merge is the correct route for the next
    // fragment change.
    __resetBridgeWatchdogForTests();
    resetMetrics();

    const canon = canonicalOf(RESIDUAL_RAW);
    const { doc, xmlFragment, ytext, cleanup } = seedThenAttach(canon, 'routing-real-divergence');

    const spaceAt = canon.indexOf('# Hello') + '# Hello'.length;
    doc.transact(() => {
      ytext.insert(spaceAt, ' ');
    });
    expect(ytext.toString()).toContain('# Hello \n');

    const firesBefore = totalPathBFires();
    const events = capturePathBEvents(() => {
      populateFragment(
        doc,
        xmlFragment,
        `${serializeFragmentBody(xmlFragment)}\nAnother wysiwyg edit.\n`,
      );
    });

    expect(totalPathBFires()).toBeGreaterThan(firesBefore);
    expect(events.length).toBeGreaterThanOrEqual(1);

    // Path B preserved the user's unabsorbed source-mode byte alongside the
    // fragment edit — the user-visible reason real divergence must route B.
    const finalText = ytext.toString();
    expect(finalText).toContain('# Hello \n');
    expect(finalText).toContain('Another wysiwyg edit.');

    cleanup();
  });

  test('gate 1: serialization-neutral fragment event on a residual doc settles with zero observer writes', () => {
    // The riskiest interplay of the two-witness split: on a residual doc the
    // canonical and raw surfaces differ, so if gate 1 compared the RAW
    // witness it would fail to short-circuit a fragment event whose
    // canonical serialization is unchanged — the router would then find
    // Y.Text at baseline and Path-A-rewrite it toward canonical with no
    // user edit at all (a spurious canonicalization pass).
    __resetBridgeWatchdogForTests();
    resetMetrics();

    const { doc, xmlFragment, ytext, recorder, cleanup } = seedThenAttach(
      RESIDUAL_RAW,
      'routing-gate1-neutral',
    );
    expect(ytext.toString()).toBe(RESIDUAL_RAW);
    const bodyBefore = serializeFragmentBody(xmlFragment);

    let observerWrites = 0;
    doc.on('afterTransaction', (tx: Y.Transaction) => {
      if (tx.origin === OBSERVER_SYNC_ORIGIN) observerWrites++;
    });

    const firesBefore = totalPathBFires();
    const events = capturePathBEvents(() => {
      // Serialization-neutral fragment change: replace the trailing
      // paragraph with a structurally new but textually equal one in a
      // single transact. Real Items change (observeDeep fires; settlement
      // dispatches 'a'), but serialize(fragment) is byte-identical.
      doc.transact(() => {
        const replacement = new Y.XmlElement('paragraph');
        const text = new Y.XmlText();
        text.insert(0, 'Body text stays.');
        replacement.insert(0, [text]);
        xmlFragment.insert(xmlFragment.length, [replacement]);
        xmlFragment.delete(xmlFragment.length - 2, 1);
      });
    });

    // Non-vacuity: the settlement handler really dispatched Observer A.
    expect(recorder.dispatches).toContain('a');
    // Serialization-neutrality held (guards fixture rot).
    expect(serializeFragmentBody(xmlFragment)).toBe(bodyBefore);

    // Gate 1 short-circuited via the canonical witness: no observer write,
    // no Path B fire, and Y.Text's residual bytes are untouched.
    expect(observerWrites).toBe(0);
    expect(events).toHaveLength(0);
    expect(totalPathBFires()).toBe(firesBefore);
    expect(ytext.toString()).toBe(RESIDUAL_RAW);

    cleanup();
  });

  test('gate 1: stale canonical witness after a paired-write reset does NOT short-circuit a fragment edit that re-matches it (CB-CONTRACT-10 regression)', () => {
    // Regression for the paste round-trip: copy an img,
    // reset the doc to empty via a paired write, then paste the img back.
    // The paired-write reset refreshes ONLY the raw witness (perf — no O(N)
    // serialize on the hot path) and clears coherence, leaving the canonical
    // witness STALE at the pre-reset content's canonical form. When the
    // fragment is then repopulated to that same content, its serialization
    // coincidentally equals the stale canonical witness — so a gate 1 that
    // trusts the canonical witness unconditionally falsely concludes
    // "fragment unchanged, nothing to do" and skips propagating to Y.Text,
    // which is still empty. Gate 1 must respect coherence (the router already
    // does), falling through to the raw-witness router (Path A here) so the
    // content reaches Y.Text.
    __resetBridgeWatchdogForTests();
    resetMetrics();

    const IMG = '<img src="x.png" alt="x" />\n';
    const { doc, xmlFragment, ytext, cleanup } = seedThenAttach(IMG, 'gate1-stale-canonical');

    // Paired-write reset to empty: mirrors agent-write-md { markdown: '\n',
    // position: 'replace' } — writes both surfaces, refreshes the raw witness
    // only, clears coherence, leaves the canonical witness at canonicalOf(IMG).
    const emptyRaw = '\n';
    const emptyJson = mdManager.parse(emptyRaw);
    const emptyNode = schema.nodeFromJSON(emptyJson);
    doc.transact(() => {
      const meta = { mapping: new Map(), isOMark: new Map() };
      updateYFragment(doc, xmlFragment, emptyNode, meta);
      ytext.delete(0, ytext.length);
      ytext.insert(0, mdManager.serialize(emptyJson));
    }, AGENT_WRITE_ORIGIN);
    expect(ytext.toString().includes('<img')).toBe(false);

    // Repopulate the fragment to the IMG content (the "paste"): a non-paired
    // fragment edit whose serialization equals the stale canonical witness.
    populateFragment(doc, xmlFragment, IMG);

    // The img must reach Y.Text — gate 1 must not have falsely short-circuited.
    expect(ytext.toString()).toContain('<img');
    expect(ytext.toString()).toContain('src="x.png"');

    cleanup();
  });

  test('control: round-trip-stable doc seeded production-order — first fragment change does not fire Path B', () => {
    // Already-passing control pinning the common case so the routing fix
    // cannot regress it.
    __resetBridgeWatchdogForTests();
    resetMetrics();

    const canon = canonicalOf(RESIDUAL_RAW);
    // Fixture precondition: canonical form is round-trip-byte-stable.
    expect(canonicalOf(canon)).toBe(canon);

    const { doc, xmlFragment, ytext, cleanup } = seedThenAttach(canon, 'routing-stable-control');
    expect(ytext.toString()).toBe(canon);

    const firesBefore = totalPathBFires();
    const events = capturePathBEvents(() => {
      populateFragment(
        doc,
        xmlFragment,
        `${serializeFragmentBody(xmlFragment)}\nPlain wysiwyg edit.\n`,
      );
    });

    expect(events).toHaveLength(0);
    expect(totalPathBFires()).toBe(firesBefore);

    const finalText = ytext.toString();
    expect(finalText).toContain('Plain wysiwyg edit.');
    expect(finalText).toContain('Body text stays.');

    cleanup();
  });

  // Beyond-tolerance fixture: the lazy blockquote continuation
  // canonicalizes to a `> `-prefixed continuation line — a byte divergence
  // normalizeBridge does NOT tolerate. Storage never sanitizes: these bytes must survive in-sync
  // fragment settlements. (The original inline-math `$a + b$` fixture was
  // retired when the engine grew byte-faithful for single-`$` math.)
  const NG_RAW =
    '---\ntitle: NG routing fixture\n---\n\n# Hello\n\n> Lazy quote\nstays lazy.\n\nBody text stays.\n';

  test('in-sync doc with beyond-tolerance residual: fragment change preserves NG bytes without a Path B fire', () => {
    __resetBridgeWatchdogForTests();
    resetMetrics();

    // Fixture preconditions — non-byte-stable AND beyond normalizeBridge
    // tolerance (the discriminator vs the RESIDUAL_RAW tests).
    expect(canonicalOf(NG_RAW)).not.toBe(NG_RAW);
    expect(normalizeBridge(canonicalOf(NG_RAW))).not.toBe(normalizeBridge(NG_RAW));

    const { doc, xmlFragment, ytext, cleanup } = seedThenAttach(NG_RAW, 'routing-ng-in-sync');
    expect(ytext.toString()).toBe(NG_RAW);

    const firesBefore = totalPathBFires();
    const events = capturePathBEvents(() => {
      populateFragment(
        doc,
        xmlFragment,
        `${serializeFragmentBody(xmlFragment)}\nUser WYSIWYG edit.\n`,
      );
    });

    // Y.Text holds nothing unabsorbed — the in-sync canonical-base merge is
    // NOT a divergence fire: no event, counters flat.
    expect(events).toHaveLength(0);
    expect(totalPathBFires()).toBe(firesBefore);
    // The merge machinery DID run — operator-visible via the dedicated
    // residual-merge counter, not the divergence-scoped Path B pair.
    expect(getMetrics().observerAResidualMergeRuns).toBe(1);

    // The fragment's delta landed AND the untouched NG construct kept its
    // raw byte form (no wholesale canonical rewrite of Y.Text).
    const finalText = ytext.toString();
    expect(finalText).toContain('User WYSIWYG edit.');
    expect(finalText).toContain('> Lazy quote\nstays lazy.');
    expect(finalText).not.toContain('> stays lazy.');
    expect(finalText).toContain('Body text stays.');

    cleanup();
  });

  test('control: real divergence on a beyond-tolerance doc fires Path B — divergence beats the residual merge', () => {
    // Pins the predicate ordering: `!ytextInSync` is checked before residual
    // classification, so a parse-invisible unabsorbed Y.Text byte routes
    // Path B even on a doc whose residual would otherwise qualify for the
    // in-sync canonical-base merge.
    __resetBridgeWatchdogForTests();
    resetMetrics();

    const { doc, xmlFragment, ytext, cleanup } = seedThenAttach(NG_RAW, 'routing-ng-divergence');

    const spaceAt = NG_RAW.indexOf('# Hello') + '# Hello'.length;
    doc.transact(() => {
      ytext.insert(spaceAt, ' ');
    });
    expect(ytext.toString()).toContain('# Hello \n');

    const firesBefore = totalPathBFires();
    const events = capturePathBEvents(() => {
      populateFragment(
        doc,
        xmlFragment,
        `${serializeFragmentBody(xmlFragment)}\nAnother wysiwyg edit.\n`,
      );
    });

    expect(totalPathBFires()).toBeGreaterThan(firesBefore);
    expect(events.length).toBeGreaterThanOrEqual(1);

    // The user's unabsorbed source-mode byte survived the divergence merge.
    const finalText = ytext.toString();
    expect(finalText).toContain('# Hello \n');
    expect(finalText).toContain('Another wysiwyg edit.');

    cleanup();
  });

  test('consecutive in-sync fragment edits on a beyond-tolerance doc each run the residual merge: the post-merge settlement restores coherence', () => {
    // The settlement primitive (`recordSettledBaselines(md)`) at the end of a
    // residual merge re-records BOTH witnesses and re-sets coherence, so the
    // raw witness still carries the NG construct (beyond tolerance of the
    // canonical witness). A SECOND fragment edit must therefore take the
    // residual merge again — NG bytes survive across every WYSIWYG edit, not
    // just the first.
    __resetBridgeWatchdogForTests();
    resetMetrics();

    expect(normalizeBridge(canonicalOf(NG_RAW))).not.toBe(normalizeBridge(NG_RAW));

    const { doc, xmlFragment, ytext, cleanup } = seedThenAttach(NG_RAW, 'routing-ng-consecutive');
    expect(ytext.toString()).toBe(NG_RAW);

    const firesBefore = totalPathBFires();

    // First in-sync fragment edit → residual merge.
    const events1 = capturePathBEvents(() => {
      populateFragment(doc, xmlFragment, `${serializeFragmentBody(xmlFragment)}\nFirst edit.\n`);
    });
    expect(events1).toHaveLength(0);
    expect(getMetrics().observerAResidualMergeRuns).toBe(1);
    expect(ytext.toString()).toContain('> Lazy quote\nstays lazy.');
    expect(ytext.toString()).not.toContain('> stays lazy.');

    // Second in-sync fragment edit: the post-merge settlement kept the
    // witnesses coherent and beyond tolerance, so this must dispatch the
    // residual merge again (not collapse to a wholesale canonical rewrite).
    const events2 = capturePathBEvents(() => {
      populateFragment(doc, xmlFragment, `${serializeFragmentBody(xmlFragment)}\nSecond edit.\n`);
    });
    expect(events2).toHaveLength(0);
    expect(getMetrics().observerAResidualMergeRuns).toBe(2);
    expect(totalPathBFires()).toBe(firesBefore);

    const finalText = ytext.toString();
    expect(finalText).toContain('First edit.');
    expect(finalText).toContain('Second edit.');
    expect(finalText).toContain('> Lazy quote\nstays lazy.');
    expect(finalText).not.toContain('> stays lazy.');

    cleanup();
  });

  test('paired write on a beyond-tolerance doc clears coherence: the next in-sync fragment edit takes the Path-A fallback, not the residual merge', () => {
    // A paired-write short-circuit refreshes only the raw witness and clears
    // coherence (the witnesses now span two settlement generations). Even
    // though Y.Text stays in sync with the fragment, the next fragment edit
    // must NOT run the cross-generation residual merge — it falls back to
    // Path A, the pre-split behavior for unusable witness state.
    __resetBridgeWatchdogForTests();
    resetMetrics();

    const { doc, xmlFragment, ytext, recorder, cleanup } = seedThenAttach(
      NG_RAW,
      'routing-ng-paired-clears-coherence',
    );
    expect(ytext.toString()).toBe(NG_RAW);

    // Paired write that REPLACES both surfaces with a different (still
    // beyond-tolerance, still in-sync) NG state. It must actually mutate the
    // fragment so Observer A's paired-write branch fires and clears coherence;
    // a no-op updateYFragment would never trigger the short-circuit. Mirrors
    // an agent write under a paired origin.
    const pairedRaw =
      '---\ntitle: NG routing fixture\n---\n\n# Hello\n\n> Lazy quote\nstays lazy.\n\nPaired body.\n';
    // Fixture precondition: pairedRaw is also beyond-tolerance, so the
    // coherence flag (not residualInTolerance) is what gates the residual
    // merge after the paired write.
    expect(normalizeBridge(canonicalOf(pairedRaw))).not.toBe(normalizeBridge(pairedRaw));
    const pairedJson = mdManager.parse(stripFrontmatter(pairedRaw).body);
    const pairedNode = schema.nodeFromJSON(pairedJson);
    doc.transact(() => {
      const meta = { mapping: new Map(), isOMark: new Map() };
      updateYFragment(doc, xmlFragment, pairedNode, meta);
      ytext.delete(0, ytext.length);
      ytext.insert(0, pairedRaw);
    }, AGENT_WRITE_ORIGIN);
    // The paired transact produced only a 'none' dispatch (both observer
    // branches short-circuited): no settlement work, coherence cleared.
    expect(recorder.dispatches.filter((k) => k !== 'none')).toHaveLength(0);
    expect(ytext.toString()).toBe(pairedRaw);

    const firesBefore = totalPathBFires();
    const events = capturePathBEvents(() => {
      populateFragment(
        doc,
        xmlFragment,
        `${serializeFragmentBody(xmlFragment)}\nPost-paired edit.\n`,
      );
    });

    // Path-A fallback: no residual merge (coherence is false) and no
    // divergence fire (Y.Text was in sync).
    expect(getMetrics().observerAResidualMergeRuns).toBe(0);
    expect(events).toHaveLength(0);
    expect(totalPathBFires()).toBe(firesBefore);
    expect(ytext.toString()).toContain('Post-paired edit.');

    cleanup();
  });

  test('diverged attach: next fragment change routes Path B against the fragment-canonical base and Y.Text-only content survives exactly once', () => {
    __resetBridgeWatchdogForTests();
    resetMetrics();

    // Diverged seed — deliberately NOT the paired-write intake: fragment and
    // Y.Text are populated independently so observers attach over
    // fragment !== parse(ytext), the shape a partially-failed paired write
    // leaves behind.
    const doc = new Y.Doc();
    const xmlFragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');
    populateFragment(doc, xmlFragment, '# Hello\n\nFragment body.\n');
    doc.transact(() => {
      ytext.insert(0, '# Hello\n\nYtext-only line.\n\nFragment body.\n');
    });
    const recorder = createDispatchRecorder();
    const cleanup = setupServerObservers(
      setupOpts({ doc, xmlFragment, ytext, recorder, docName: 'routing-diverged-attach' }),
    );

    const firesBefore = totalPathBFires();
    const events = capturePathBEvents(() => {
      populateFragment(
        doc,
        xmlFragment,
        `${serializeFragmentBody(xmlFragment)}\nUser WYSIWYG edit.\n`,
      );
    });

    // Path B fired: Y.Text holds content the fragment never absorbed.
    expect(totalPathBFires()).toBeGreaterThan(firesBefore);
    expect(events.length).toBeGreaterThanOrEqual(1);

    // Merged against the fragment-canonical base: the Y.Text-only line
    // survives exactly once (an empty or stale base would re-insert the
    // whole doc or duplicate it) and the fragment edit landed.
    const finalText = ytext.toString();
    expect(finalText.split('Ytext-only line.').length).toBe(2);
    expect(finalText).toContain('User WYSIWYG edit.');
    expect(finalText).toContain('Fragment body.');

    cleanup();
  });
});
