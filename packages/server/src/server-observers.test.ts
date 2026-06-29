/**
 * Unit tests for the server-authoritative observer bridge (server-observers.ts).
 *
 * Tests cover:
 *   - Settlement-based dispatch on `afterAllTransactions` (precedent #13(b))
 *   - Baseline-refresh semantics for Path A / Path B / paired-write / self-sync
 *   - Path A vs Path B dispatch (FR-3(c))
 *   - Origin-guard truth table (FR-5 — §7d)
 *   - No infinite loop on self-origin
 *   - Agent paired-write early-exit
 *   - Paired-write short-circuit symmetry across Observer A + Observer B
 *     (bridge-correctness SPEC §6 R0c)
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

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

function createDispatchRecorder() {
  const dispatches: ObserverDispatchKind[] = [];
  const onDispatch = (kind: ObserverDispatchKind): void => {
    dispatches.push(kind);
  };
  return { dispatches, onDispatch };
}

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

function populateFragment(doc: Y.Doc, xmlFragment: Y.XmlFragment, md: string): void {
  const json = mdManager.parse(md);
  const pmNode = schema.nodeFromJSON(json);
  const meta = { mapping: new Map(), isOMark: new Map() };
  updateYFragment(doc, xmlFragment, pmNode, meta);
}

describe('Server Observer A — XmlFragment → Y.Text', () => {
  test('Observer A settles synchronously after each transact; multiple rapid edits each fire once', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    let writeCount = 0;
    doc.on('afterTransaction', (tx: Y.Transaction) => {
      if (tx.origin === OBSERVER_SYNC_ORIGIN) writeCount++;
    });

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

    populateFragment(doc, xmlFragment, '# Hello\n');
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    expect(ytext.toString()).toContain('Hello');

    populateFragment(doc, xmlFragment, '# Hello\n\nNew paragraph\n');

    expect(ytext.toString()).toContain('New paragraph');

    cleanup();
  });

  test('Path B: uses DMP three-way merge when Y.Text diverged from baseline', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();

    populateFragment(doc, xmlFragment, '# Hello\n\nOriginal\n');
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    doc.transact(() => {
      const text = ytext.toString();
      ytext.insert(text.length, '\nAgent addition\n');
    }, OBSERVER_SYNC_ORIGIN);

    populateFragment(doc, xmlFragment, '# Hello\n\nOriginal\n\nUser edit\n');

    const result = ytext.toString();
    expect(result).toContain('Agent addition');
    expect(result).toContain('User edit');

    cleanup();
  });

  test('Path B emits observer-a-path-b-fired telemetry (FR-41)', () => {
    __resetBridgeWatchdogForTests();
    resetMetrics();

    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const before = getMetrics().observerAPathBFires;

    populateFragment(doc, xmlFragment, '# Hello\n\nOriginal\n');
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    try {
      doc.transact(() => {
        ytext.insert(ytext.toString().length, '\nAgent addition\n');
      }, OBSERVER_SYNC_ORIGIN);
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
    expect(pathBEvent?.['doc.name']).toBeNull();

    const keys = Object.keys(pathBEvent ?? {}).sort();
    expect(keys).toEqual(
      ['doc.name', 'event', 'mergeBytesChanged', 'xmlFragmentAdvanced', 'ytextDiverged'].sort(),
    );

    expect(getMetrics().observerAPathBFires).toBe(before + pathBEvents.length);
    expect(getMetrics().observerAPathBFiresSuppressed).toBe(0);

    cleanup();
  });

  test('observer-a-path-b-fired event is rate-limited per doc; counter still tracks every fire', () => {
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

    expect(pathBEvents.length).toBe(1);
    expect(getMetrics().observerAPathBFires).toBe(1);
    expect(getMetrics().observerAPathBFiresSuppressed).toBeGreaterThanOrEqual(2);
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

    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, '---\ntitle: My Page\n---\n# Hello\n\nWorld\n');
    });

    expect(stripFrontmatter(ytext.toString()).frontmatter).toBe('---\ntitle: My Page\n---\n');
    expect(readFmMap(ytext.toString())).toEqual({ title: 'My Page' });

    cleanup();
  });

  test('frontmatter: post-load Y.Text carries FM + body verbatim (D8 — Y.Text IS the FM source)', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();

    populateFragment(doc, xmlFragment, '# Hello\n\nContent\n');
    doc.transact(() => {
      ytext.insert(0, '---\ntitle: Test\n---\n# Hello\n\nContent\n');
    });

    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    expect(ytext.toString()).toContain('---\ntitle: Test\n---\n');
    expect(ytext.toString()).toContain('Hello');

    cleanup();
  });

  test('early-exit: XmlFragment unchanged when Y.Text body already matches', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();

    populateFragment(doc, xmlFragment, '# Hello\n');
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    const serializedBody = mdManager.serialize(
      yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON(),
    );

    doc.transact(() => {
      ytext.insert(ytext.length, ' ');
      ytext.delete(ytext.length - 1, 1);
    });

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
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    const seedContent = 'seed paragraph\n';
    const seedJson = mdManager.parse(seedContent);
    const seedNode = schema.nodeFromJSON(seedJson);
    doc.transact(() => {
      const meta = { mapping: new Map(), isOMark: new Map() };
      updateYFragment(doc, xmlFragment, seedNode, meta);
      ytext.delete(0, ytext.length);
      ytext.insert(0, mdManager.serialize(seedJson));
    }, AGENT_WRITE_ORIGIN);

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

    doc.transact(() => {
      ytext.insert(ytext.length, '\n\nM1-golf hotel\n');
    });

    const finalText = ytext.toString();
    const occurrences = finalText.split('M0-alpha echo').length - 1;
    expect(occurrences).toBe(1);
    expect(finalText).toContain('M1-golf hotel');

    cleanup();
  });

  function runPairedWriteShortCircuitTest(origin: LocalTransactionOrigin, marker: string): void {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    const seedContent = 'seed paragraph\n';
    const seedJson = mdManager.parse(seedContent);
    const seedNode = schema.nodeFromJSON(seedJson);
    doc.transact(() => {
      const meta = { mapping: new Map(), isOMark: new Map() };
      updateYFragment(doc, xmlFragment, seedNode, meta);
      ytext.delete(0, ytext.length);
      ytext.insert(0, mdManager.serialize(seedJson));
    }, AGENT_WRITE_ORIGIN);

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

    expect(recorder.dispatches.slice(dispatchesBefore)).toEqual(['none']);

    doc.transact(() => {
      const cur = ytext.toString();
      const nextContent = `${cur}\nconcurrent-edit\n`;
      const nextJson = mdManager.parse(nextContent);
      const nextNode = schema.nodeFromJSON(nextJson);
      const meta = { mapping: new Map(), isOMark: new Map() };
      updateYFragment(doc, xmlFragment, nextNode, meta);
    });

    const finalText = ytext.toString();
    expect(finalText.split(marker).length - 1).toBe(1);
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

    populateFragment(doc, xmlFragment, '# Remote edit\n');

    expect(ytext.toString()).toContain('Remote edit');

    cleanup();
  });
});

describe('shouldRethrowBridgeMergeLoss (D3-LOCKED polarity)', () => {
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

    populateFragment(doc, xmlFragment, '# Pre-cleanup\n');
    expect(ytext.toString()).toContain('Pre-cleanup');
    const dispatchesBefore = recorder.dispatches.length;

    cleanup();

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

    populateFragment(doc, xmlFragment, '# Pre-existing\n\nContent here.\n');
    expect(ytext.toString()).toBe('');

    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

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

    expect(writeCount).toBe(0);
    expect(ytext.toString()).toBe('');

    cleanup();
  });
});

describe('Server Observer B — error recovery paths', () => {
  /** Wrap mdManager so parse/serialize can be toggled to throw.
   *
   * Under FR-22/G9, Observer B calls `parseWithFallback` — the real impl
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

    populateFragment(doc, xmlFragment, '# Seed\n\nBody.\n');
    const cleanup = setupServerObservers(
      setupOpts({ doc, xmlFragment, ytext, recorder, mdManager: stub.mdManager }),
    );

    const errorsBefore = getMetrics().serverObserverErrorsB;

    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, '# Still here\n\n<Foo>broken text</Bar>\n');
    });

    expect(getMetrics().serverObserverErrorsB).toBe(errorsBefore);
    const postBody = mdManager.serialize(
      yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON(),
    );
    expect(postBody).toContain('Still here');
    expect(postBody).toContain('<Foo>broken text</Bar>');

    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, '# Recovered\n');
    });

    const finalBody = mdManager.serialize(
      yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON(),
    );
    expect(finalBody).toContain('Recovered');
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

    const originalConsoleError = console.error;
    console.error = () => {};
    stub.setParseThrow(new Error('unexpected parse failure'));

    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, '# Anything\n');
    });

    stub.setParseThrow(null);
    console.error = originalConsoleError;

    expect(getMetrics().serverObserverErrorsB).toBe(errorsBefore + 1);

    const postBody = mdManager.serialize(
      yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON(),
    );
    expect(postBody).toContain('Seed');

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

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

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

    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, '# Seed\n\n## After\n');
    });

    stub.mdManager.serialize = originalSerialize;
    console.warn = originalWarn;

    expect(warnings.some((w) => w.includes('Post-sync re-serialization failed'))).toBe(true);

    expect(getMetrics().serverObserverErrorsB).toBe(errorsBefore);

    expect(
      mdManager.serialize(yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON()),
    ).toContain('After');

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

    const originalConsoleError = console.error;
    console.error = () => {};
    stub.setParseThrow(new Error('unexpected parse failure'));
    doc.transact(() => {
      ytext.insert(ytext.length, '\nUnabsorbed line.\n');
    });
    stub.setParseThrow(null);
    console.error = originalConsoleError;

    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, ngRaw);
    }, OBSERVER_SYNC_ORIGIN);
    expect(ytext.toString()).toBe(ngRaw);

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

describe('Server Observer B — Y.Text-is-truth contract (FR-31)', () => {
  test('Y.Text bytes preserved verbatim across Observer B (no canonicalize-write-back)', () => {
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

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

    doc.transact(() => {
      ytext.insert(0, '# H\n\nP\n');
    });

    expect(syncOriginWrites).toBe(1);

    cleanup();
  });

  test('watchdog tolerates FM-body boundary blank-line divergence (block-separator-collapse class)', () => {
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
    const { doc, xmlFragment, ytext, recorder } = createTestDoc();
    const cleanup = setupServerObservers(setupOpts({ doc, xmlFragment, ytext, recorder }));

    let observerInducedYTextChange = 0;
    ytext.observe((_event: Y.YTextEvent, tx: Y.Transaction) => {
      if (tx.origin === OBSERVER_SYNC_ORIGIN) observerInducedYTextChange++;
    });

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

describe('Observer A routing — Path B fires iff Y.Text holds unabsorbed changes (FR-3)', () => {
  const RESIDUAL_RAW = '---\ntitle: Routing fixture\n---\n\n# Hello   \n\nBody text stays.\n';

  function canonicalOf(raw: string): string {
    const { frontmatter, body } = stripFrontmatter(raw);
    return prependFrontmatter(frontmatter, mdManager.serialize(mdManager.parseWithFallback(body)));
  }

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

    expect(canonicalOf(RESIDUAL_RAW)).not.toBe(RESIDUAL_RAW);
    expect(normalizeBridge(canonicalOf(RESIDUAL_RAW))).toBe(normalizeBridge(RESIDUAL_RAW));

    const { doc, xmlFragment, ytext, cleanup } = seedThenAttach(
      RESIDUAL_RAW,
      'routing-residual-first-edit',
    );
    expect(ytext.toString()).toBe(RESIDUAL_RAW);

    const firesBefore = totalPathBFires();
    const events = capturePathBEvents(() => {
      populateFragment(
        doc,
        xmlFragment,
        `${serializeFragmentBody(xmlFragment)}\nUser WYSIWYG edit.\n`,
      );
    });

    expect(events).toHaveLength(0);
    expect(totalPathBFires()).toBe(firesBefore);

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

    expect(events).toHaveLength(0);
    expect(totalPathBFires()).toBe(firesBefore);

    const finalText = ytext.toString();
    expect(finalText).toContain('Added via source');
    expect(finalText).toContain('Wysiwyg paragraph.');
    expect(finalText).toContain('Body text stays.');

    cleanup();
  });

  test('control: parse-invisible source edit is real unabsorbed divergence — next fragment change MUST fire Path B', () => {
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

    const finalText = ytext.toString();
    expect(finalText).toContain('# Hello \n');
    expect(finalText).toContain('Another wysiwyg edit.');

    cleanup();
  });

  test('gate 1: serialization-neutral fragment event on a residual doc settles with zero observer writes', () => {
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
      doc.transact(() => {
        const replacement = new Y.XmlElement('paragraph');
        const text = new Y.XmlText();
        text.insert(0, 'Body text stays.');
        replacement.insert(0, [text]);
        xmlFragment.insert(xmlFragment.length, [replacement]);
        xmlFragment.delete(xmlFragment.length - 2, 1);
      });
    });

    expect(recorder.dispatches).toContain('a');
    expect(serializeFragmentBody(xmlFragment)).toBe(bodyBefore);

    expect(observerWrites).toBe(0);
    expect(events).toHaveLength(0);
    expect(totalPathBFires()).toBe(firesBefore);
    expect(ytext.toString()).toBe(RESIDUAL_RAW);

    cleanup();
  });

  test('gate 1: stale canonical witness after a paired-write reset does NOT short-circuit a fragment edit that re-matches it (CB-CONTRACT-10 regression)', () => {
    __resetBridgeWatchdogForTests();
    resetMetrics();

    const IMG = '<img src="x.png" alt="x" />\n';
    const { doc, xmlFragment, ytext, cleanup } = seedThenAttach(IMG, 'gate1-stale-canonical');

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

    populateFragment(doc, xmlFragment, IMG);

    expect(ytext.toString()).toContain('<img');
    expect(ytext.toString()).toContain('src="x.png"');

    cleanup();
  });

  test('control: round-trip-stable doc seeded production-order — first fragment change does not fire Path B', () => {
    __resetBridgeWatchdogForTests();
    resetMetrics();

    const canon = canonicalOf(RESIDUAL_RAW);
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

  const NG_RAW =
    '---\ntitle: NG routing fixture\n---\n\n# Hello\n\n> Lazy quote\nstays lazy.\n\nBody text stays.\n';

  test('in-sync doc with beyond-tolerance residual: fragment change preserves NG bytes without a Path B fire', () => {
    __resetBridgeWatchdogForTests();
    resetMetrics();

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

    expect(events).toHaveLength(0);
    expect(totalPathBFires()).toBe(firesBefore);
    expect(getMetrics().observerAResidualMergeRuns).toBe(1);

    const finalText = ytext.toString();
    expect(finalText).toContain('User WYSIWYG edit.');
    expect(finalText).toContain('> Lazy quote\nstays lazy.');
    expect(finalText).not.toContain('> stays lazy.');
    expect(finalText).toContain('Body text stays.');

    cleanup();
  });

  test('control: real divergence on a beyond-tolerance doc fires Path B — divergence beats the residual merge', () => {
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

    const finalText = ytext.toString();
    expect(finalText).toContain('# Hello \n');
    expect(finalText).toContain('Another wysiwyg edit.');

    cleanup();
  });

  test('consecutive in-sync fragment edits on a beyond-tolerance doc each run the residual merge: the post-merge settlement restores coherence', () => {
    __resetBridgeWatchdogForTests();
    resetMetrics();

    expect(normalizeBridge(canonicalOf(NG_RAW))).not.toBe(normalizeBridge(NG_RAW));

    const { doc, xmlFragment, ytext, cleanup } = seedThenAttach(NG_RAW, 'routing-ng-consecutive');
    expect(ytext.toString()).toBe(NG_RAW);

    const firesBefore = totalPathBFires();

    const events1 = capturePathBEvents(() => {
      populateFragment(doc, xmlFragment, `${serializeFragmentBody(xmlFragment)}\nFirst edit.\n`);
    });
    expect(events1).toHaveLength(0);
    expect(getMetrics().observerAResidualMergeRuns).toBe(1);
    expect(ytext.toString()).toContain('> Lazy quote\nstays lazy.');
    expect(ytext.toString()).not.toContain('> stays lazy.');

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
    __resetBridgeWatchdogForTests();
    resetMetrics();

    const { doc, xmlFragment, ytext, recorder, cleanup } = seedThenAttach(
      NG_RAW,
      'routing-ng-paired-clears-coherence',
    );
    expect(ytext.toString()).toBe(NG_RAW);

    const pairedRaw =
      '---\ntitle: NG routing fixture\n---\n\n# Hello\n\n> Lazy quote\nstays lazy.\n\nPaired body.\n';
    expect(normalizeBridge(canonicalOf(pairedRaw))).not.toBe(normalizeBridge(pairedRaw));
    const pairedJson = mdManager.parse(stripFrontmatter(pairedRaw).body);
    const pairedNode = schema.nodeFromJSON(pairedJson);
    doc.transact(() => {
      const meta = { mapping: new Map(), isOMark: new Map() };
      updateYFragment(doc, xmlFragment, pairedNode, meta);
      ytext.delete(0, ytext.length);
      ytext.insert(0, pairedRaw);
    }, AGENT_WRITE_ORIGIN);
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

    expect(getMetrics().observerAResidualMergeRuns).toBe(0);
    expect(events).toHaveLength(0);
    expect(totalPathBFires()).toBe(firesBefore);
    expect(ytext.toString()).toContain('Post-paired edit.');

    cleanup();
  });

  test('diverged attach: next fragment change routes Path B against the fragment-canonical base and Y.Text-only content survives exactly once', () => {
    __resetBridgeWatchdogForTests();
    resetMetrics();

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

    expect(totalPathBFires()).toBeGreaterThan(firesBefore);
    expect(events.length).toBeGreaterThanOrEqual(1);

    const finalText = ytext.toString();
    expect(finalText.split('Ytext-only line.').length).toBe(2);
    expect(finalText).toContain('User WYSIWYG edit.');
    expect(finalText).toContain('Fragment body.');

    cleanup();
  });
});
