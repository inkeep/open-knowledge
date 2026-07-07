/**
 * Unit tests for the server-side bridge invariant watchdog.
 *
 * Tests the watchdog's mechanics in isolation from Observer B:
 *   - `assertBridgeInvariant` no-op when normalizeBridge-equivalent
 *   - `assertBridgeInvariant` throws under NODE_ENV=test and OK_BRIDGE_THROW_ON_VIOLATION=1
 *   - Rate-limiter suppresses repeated emissions per (site, doc) tuple per
 *     debounce window (configurable via OK_BRIDGE_VIOLATION_DEBOUNCE_S)
 *   - `shouldThrowOnBridgeInvariantViolation` polarity (affirmative gate;
 *     mirrors `shouldRethrowBridgeMergeLoss` rationale)
 *
 * The Observer-B-end-to-end watchdog tests live in
 * `server-observers.test.ts` "Server Observer B — Y.Text-is-truth contract"
 * — those exercise the dispatch-driven path where Phase 1 → watchdog runs
 * inside `afterAllTransactions`. These unit tests cover the watchdog's
 * core mechanics without a Y.Doc.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  BridgeInvariantViolationError,
  MarkdownManager,
  normalizeBridge,
  setToleranceTelemetryHook,
  sharedExtensions,
  type ToleranceFireRecord,
} from '@inkeep/open-knowledge-core';
import {
  __getSplitBrainRateTupleCountForTests,
  __getViolationRateTupleCountForTests,
  __resetBridgeWatchdogForTests,
  assertBridgeInvariant,
  emitBridgeSplitBrainRederive,
  emitObserverAPathBFired,
  shouldEmitBridgeInvariantViolation,
  shouldEmitBridgeSplitBrainRederive,
  shouldEmitBridgeToleranceApplied,
  shouldEmitObserverAPathBFired,
  shouldThrowOnBridgeInvariantViolation,
} from './bridge-watchdog.ts';
import { getMetrics, resetMetrics } from './metrics.ts';

beforeEach(() => {
  __resetBridgeWatchdogForTests();
  resetMetrics();
});

afterEach(() => {
  delete process.env.OK_BRIDGE_THROW_ON_VIOLATION;
  delete process.env.OK_BRIDGE_VIOLATION_DEBOUNCE_S;
});

describe('shouldThrowOnBridgeInvariantViolation (affirmative gate polarity)', () => {
  // Mirrors the rationale documented on `shouldRethrowBridgeMergeLoss` — Bun
  // leaves NODE_ENV undefined for `bun run` and `open-knowledge start`, so
  // an inverted gate (`!== 'production'`) re-throws in production at the
  // exact moment the watchdog detects a real bug. Affirmative gate flips
  // the default so production stays in the soft-recovery path.

  test('undefined NODE_ENV does not throw (Bun production default)', () => {
    expect(shouldThrowOnBridgeInvariantViolation({} as NodeJS.ProcessEnv)).toBe(false);
  });

  test('NODE_ENV=production does not throw', () => {
    expect(
      shouldThrowOnBridgeInvariantViolation({ NODE_ENV: 'production' } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  test('NODE_ENV=development does not throw', () => {
    expect(
      shouldThrowOnBridgeInvariantViolation({ NODE_ENV: 'development' } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  test('NODE_ENV=test throws (bun test default)', () => {
    expect(shouldThrowOnBridgeInvariantViolation({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(
      true,
    );
  });

  test('OK_BRIDGE_THROW_ON_VIOLATION=1 throws regardless of NODE_ENV', () => {
    expect(
      shouldThrowOnBridgeInvariantViolation({
        NODE_ENV: 'production',
        OK_BRIDGE_THROW_ON_VIOLATION: '1',
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  test('OK_BRIDGE_THROW_ON_VIOLATION=0 does not throw', () => {
    expect(
      shouldThrowOnBridgeInvariantViolation({
        OK_BRIDGE_THROW_ON_VIOLATION: '0',
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});

describe('assertBridgeInvariant — no-op for tolerance-equivalent inputs', () => {
  test('byte-equal inputs pass without throwing', () => {
    expect(() => {
      assertBridgeInvariant('# Hello\n', '# Hello\n', { site: 'observer-b' });
    }).not.toThrow();
    expect(getMetrics().bridgeInvariantViolations).toBe(0);
  });

  test('CRLF vs LF tolerated (normalize.ts step 2)', () => {
    expect(() => {
      assertBridgeInvariant('# Hello\r\n', '# Hello\n', { site: 'observer-b' });
    }).not.toThrow();
    expect(getMetrics().bridgeInvariantViolations).toBe(0);
  });

  test('BOM vs no-BOM tolerated (normalize.ts step 1)', () => {
    expect(() => {
      assertBridgeInvariant('﻿# Hello\n', '# Hello\n', { site: 'observer-b' });
    }).not.toThrow();
    expect(getMetrics().bridgeInvariantViolations).toBe(0);
  });

  test('per-line trailing whitespace tolerated (normalize.ts step 4)', () => {
    expect(() => {
      assertBridgeInvariant('# Hello   \nbody\n', '# Hello\nbody\n', { site: 'observer-b' });
    }).not.toThrow();
    expect(getMetrics().bridgeInvariantViolations).toBe(0);
  });

  test('3+ newline collapse tolerated (NG1 architectural floor)', () => {
    expect(() => {
      assertBridgeInvariant('# H\n\n\n\n# H2\n', '# H\n\n# H2\n', { site: 'observer-b' });
    }).not.toThrow();
    expect(getMetrics().bridgeInvariantViolations).toBe(0);
  });

  test('table-row trailing-pipe divergence tolerated (row-no-trailing-pipe)', () => {
    expect(() => {
      assertBridgeInvariant('| a | b\n| - | -\n| 1 | 2\n', '| a | b|\n| - | -|\n| 1 | 2|\n', {
        site: 'observer-b',
      });
    }).not.toThrow();
    expect(getMetrics().bridgeInvariantViolations).toBe(0);
  });

  test('touched-cell table divergence is NOT absorbed by the trailing-pipe tolerance', () => {
    expect(() => {
      assertBridgeInvariant(
        '| a | b |\n| - | - |\n| 1 | 2 |\n',
        '| a | b |\n| - | - |\n| 1 | 99 |\n',
        { site: 'observer-b' },
      );
    }).toThrow(BridgeInvariantViolationError);
  });
});

describe('assertBridgeInvariant — throws under NODE_ENV=test (default for bun test)', () => {
  test('byte-divergence outside tolerance throws', () => {
    expect(() => {
      assertBridgeInvariant('# Foo\n', '# Bar\n', { site: 'observer-b' });
    }).toThrow(BridgeInvariantViolationError);
  });

  test('thrown error carries violation shape (site, snapshots, diff)', () => {
    try {
      assertBridgeInvariant('# Foo\n', '# Bar\n', {
        site: 'observer-b',
        docName: 'test/doc.md',
        origin: { context: { origin: 'TEST_ORIGIN' } },
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeInvariantViolationError);
      const tyErr = err as BridgeInvariantViolationError;
      expect(tyErr.violation.site).toBe('observer-b');
      expect(tyErr.violation.docName).toBe('test/doc.md');
      expect(tyErr.violation.ytextSnapshot).toBe('# Foo\n');
      expect(tyErr.violation.fragmentMdSnapshot).toBe('# Bar\n');
      expect(tyErr.violation.unifiedDiff).toContain('# Foo');
      expect(tyErr.violation.unifiedDiff).toContain('# Bar');
    }
  });

  test('throw bypasses telemetry counter (no double-counted event)', () => {
    expect(() => {
      assertBridgeInvariant('# A\n', '# B\n', { site: 'observer-b' });
    }).toThrow();
    // Counter does NOT increment in throw path — telemetry records only
    // production paths; the throw IS the test/dev signal.
    expect(getMetrics().bridgeInvariantViolations).toBe(0);
    expect(getMetrics().bridgeInvariantViolationsSuppressed).toBe(0);
  });

  test('suppressDevThrow:true emits + increments instead of throwing (persistence policy)', () => {
    // Persistence is downstream — mandates "log telemetry + write
    // Y.Text bytes anyway + queue fragment-reconciliation". Throwing would
    // block the disk write during recovery paths (provider-pool reconnect,
    // mid-rescue persistence fires) where transient divergence is expected
    // and resolves on the next settlement. The opt-out routes the call
    // through the production emit path even under NODE_ENV=test.
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    try {
      expect(() => {
        assertBridgeInvariant('# A\n', '# B\n', {
          site: 'persistence',
          docName: 'doc-1',
          suppressDevThrow: true,
        });
      }).not.toThrow();
    } finally {
      console.warn = originalWarn;
    }

    expect(getMetrics().bridgeInvariantViolations).toBe(1);
    expect(warnings).toHaveLength(1);
    const event = JSON.parse(warnings[0] ?? '{}');
    expect(event.event).toBe('bridge-invariant-violation');
    expect(event.site).toBe('persistence');
    expect(event['doc.name']).toBe('doc-1');
  });

  test('suppressDevThrow:false still throws (default behavior, Observer B contract)', () => {
    // Observer B keeps its dev-throw discipline by default — the contract's
    // primary enforcer fails loud on regression.
    expect(() => {
      assertBridgeInvariant('# A\n', '# B\n', {
        site: 'observer-b',
        suppressDevThrow: false,
      });
    }).toThrow(BridgeInvariantViolationError);
    expect(getMetrics().bridgeInvariantViolations).toBe(0);
  });
});

describe('assertBridgeInvariant — production emit path (rate-limited)', () => {
  // Force production behaviour by setting NODE_ENV to a non-test value via
  // direct process.env mutation. Bun preserves the current value across
  // tests; cleanup in afterEach restores it.
  let originalNodeEnv: string | undefined;
  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
  });
  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  test('first violation in window emits + increments counter', () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    try {
      assertBridgeInvariant('# A\n', '# B\n', {
        site: 'observer-b',
        docName: 'doc-1',
        nowMs: 1000,
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(getMetrics().bridgeInvariantViolations).toBe(1);
    expect(getMetrics().bridgeInvariantViolationsSuppressed).toBe(0);
    expect(warnings).toHaveLength(1);
    const event = JSON.parse(warnings[0] ?? '{}');
    expect(event.event).toBe('bridge-invariant-violation');
    expect(event.site).toBe('observer-b');
    // OTel-dotted convention — matches sibling persistence + api-extension
    // event payloads + the safe pre-normalized span attrs.
    expect(event['doc.name']).toBe('doc-1');
  });

  test('repeat violations within debounce window suppressed (counter increments suppressed)', () => {
    const originalWarn = console.warn;
    console.warn = () => {};

    try {
      // Default debounce = 60s. Three rapid violations within 1ms.
      assertBridgeInvariant('# A\n', '# B\n', {
        site: 'observer-b',
        docName: 'doc-1',
        nowMs: 1000,
      });
      assertBridgeInvariant('# A\n', '# C\n', {
        site: 'observer-b',
        docName: 'doc-1',
        nowMs: 1001,
      });
      assertBridgeInvariant('# A\n', '# D\n', {
        site: 'observer-b',
        docName: 'doc-1',
        nowMs: 1002,
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(getMetrics().bridgeInvariantViolations).toBe(1);
    expect(getMetrics().bridgeInvariantViolationsSuppressed).toBe(2);
  });

  test('different (site, doc) tuples have independent debounce windows', () => {
    const originalWarn = console.warn;
    console.warn = () => {};

    try {
      // Three violations across 3 distinct keys all emit (no debounce shared).
      assertBridgeInvariant('# A\n', '# B\n', {
        site: 'observer-b',
        docName: 'doc-1',
        nowMs: 1000,
      });
      assertBridgeInvariant('# A\n', '# B\n', {
        site: 'observer-b',
        docName: 'doc-2',
        nowMs: 1000,
      });
      assertBridgeInvariant('# A\n', '# B\n', {
        site: 'persistence',
        docName: 'doc-1',
        nowMs: 1000,
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(getMetrics().bridgeInvariantViolations).toBe(3);
    expect(getMetrics().bridgeInvariantViolationsSuppressed).toBe(0);
  });

  test('emission past debounce window resets counter for the tuple', () => {
    const originalWarn = console.warn;
    console.warn = () => {};

    try {
      // Default debounce = 60s = 60000ms. Two emissions 70s apart should
      // both fire.
      assertBridgeInvariant('# A\n', '# B\n', {
        site: 'observer-b',
        docName: 'doc-1',
        nowMs: 1000,
      });
      assertBridgeInvariant('# A\n', '# C\n', {
        site: 'observer-b',
        docName: 'doc-1',
        nowMs: 1000 + 70_000,
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(getMetrics().bridgeInvariantViolations).toBe(2);
    expect(getMetrics().bridgeInvariantViolationsSuppressed).toBe(0);
  });

  test('OK_BRIDGE_VIOLATION_DEBOUNCE_S env var configures the debounce', () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    process.env.OK_BRIDGE_VIOLATION_DEBOUNCE_S = '5';

    try {
      // 5s debounce → 5000ms. Emit at t=0, suppress at t=2000, emit again
      // at t=6000 (> 5000 elapsed).
      assertBridgeInvariant('# A\n', '# B\n', {
        site: 'observer-b',
        docName: 'doc-1',
        nowMs: 0,
      });
      assertBridgeInvariant('# A\n', '# C\n', {
        site: 'observer-b',
        docName: 'doc-1',
        nowMs: 2_000,
      });
      assertBridgeInvariant('# A\n', '# D\n', {
        site: 'observer-b',
        docName: 'doc-1',
        nowMs: 6_000,
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(getMetrics().bridgeInvariantViolations).toBe(2);
    expect(getMetrics().bridgeInvariantViolationsSuppressed).toBe(1);
  });
});

describe('shouldEmitBridgeInvariantViolation — gate semantics', () => {
  test('first call returns true', () => {
    expect(shouldEmitBridgeInvariantViolation('observer-b', 'doc-1', 1000)).toBe(true);
  });

  test('repeat call inside window returns false', () => {
    shouldEmitBridgeInvariantViolation('observer-b', 'doc-1', 1000);
    expect(shouldEmitBridgeInvariantViolation('observer-b', 'doc-1', 1500)).toBe(false);
  });

  test('call after debounce expires returns true', () => {
    shouldEmitBridgeInvariantViolation('observer-b', 'doc-1', 1000);
    expect(shouldEmitBridgeInvariantViolation('observer-b', 'doc-1', 70_000)).toBe(true);
  });

  test('docName=undefined uses sentinel slot (separate from any named doc)', () => {
    expect(shouldEmitBridgeInvariantViolation('observer-b', undefined, 1000)).toBe(true);
    expect(shouldEmitBridgeInvariantViolation('observer-b', 'doc-1', 1000)).toBe(true);
    expect(shouldEmitBridgeInvariantViolation('observer-b', undefined, 1500)).toBe(false);
    expect(shouldEmitBridgeInvariantViolation('observer-b', 'doc-1', 1500)).toBe(false);
  });
});

describe('shouldEmitObserverAPathBFired — per-doc rate-limiter', () => {
  // Mirrors `shouldEmitBridgeToleranceApplied` shape — keys per doc so
  // a chatty doc cannot suppress quieter docs' signal. Without this gate,
  // multi-peer concurrent editing produces a `console.warn` flood at the
  // exact frequency operators need rate-limited.

  test('first call for a doc returns true', () => {
    expect(shouldEmitObserverAPathBFired('doc-1', 1000)).toBe(true);
  });

  test('repeat call inside window returns false', () => {
    shouldEmitObserverAPathBFired('doc-1', 1000);
    expect(shouldEmitObserverAPathBFired('doc-1', 1500)).toBe(false);
  });

  test('call after debounce expires returns true', () => {
    shouldEmitObserverAPathBFired('doc-1', 1000);
    expect(shouldEmitObserverAPathBFired('doc-1', 70_000)).toBe(true);
  });

  test('different docs have independent windows', () => {
    expect(shouldEmitObserverAPathBFired('doc-1', 1000)).toBe(true);
    expect(shouldEmitObserverAPathBFired('doc-2', 1000)).toBe(true);
    expect(shouldEmitObserverAPathBFired('doc-1', 1500)).toBe(false);
    expect(shouldEmitObserverAPathBFired('doc-2', 1500)).toBe(false);
  });

  test('docName=undefined uses __nodoc__ sentinel (distinct from any named doc)', () => {
    expect(shouldEmitObserverAPathBFired(undefined, 1000)).toBe(true);
    expect(shouldEmitObserverAPathBFired('doc-1', 1000)).toBe(true);
    // Both should be rate-limited independently.
    expect(shouldEmitObserverAPathBFired(undefined, 1500)).toBe(false);
    expect(shouldEmitObserverAPathBFired('doc-1', 1500)).toBe(false);
  });

  test('emitObserverAPathBFired increments suppressed counter when rate-limited', () => {
    expect(emitObserverAPathBFired('doc-1', 1000)).toBe(true);
    expect(getMetrics().observerAPathBFiresSuppressed).toBe(0);
    expect(emitObserverAPathBFired('doc-1', 1500)).toBe(false);
    expect(getMetrics().observerAPathBFiresSuppressed).toBe(1);
    expect(emitObserverAPathBFired('doc-1', 2000)).toBe(false);
    expect(getMetrics().observerAPathBFiresSuppressed).toBe(2);
  });

  test('emitObserverAPathBFired returns true after window resets', () => {
    expect(emitObserverAPathBFired('doc-1', 1000)).toBe(true);
    expect(emitObserverAPathBFired('doc-1', 70_000)).toBe(true);
    expect(getMetrics().observerAPathBFiresSuppressed).toBe(0);
  });
});

describe('shouldEmitBridgeSplitBrainRederive — per-(site, doc) rate-limiter', () => {
  // Mirrors `shouldEmitObserverAPathBFired` shape. On an irreducibly-
  // divergent doc the split-brain settlement check fires on every Observer
  // A drain (every WYSIWYG keystroke), so the gate keeps the drift signal
  // from drowning itself.

  test('first call for a (site, doc) tuple returns true', () => {
    expect(shouldEmitBridgeSplitBrainRederive('post-merge', 'doc-1', 1000)).toBe(true);
  });

  test('repeat call inside window returns false', () => {
    shouldEmitBridgeSplitBrainRederive('post-merge', 'doc-1', 1000);
    expect(shouldEmitBridgeSplitBrainRederive('post-merge', 'doc-1', 1500)).toBe(false);
  });

  test('call after debounce expires returns true', () => {
    shouldEmitBridgeSplitBrainRederive('post-merge', 'doc-1', 1000);
    expect(shouldEmitBridgeSplitBrainRederive('post-merge', 'doc-1', 70_000)).toBe(true);
  });

  test('sites have independent windows for the same doc', () => {
    expect(shouldEmitBridgeSplitBrainRederive('identity-gate', 'doc-1', 1000)).toBe(true);
    expect(shouldEmitBridgeSplitBrainRederive('post-merge', 'doc-1', 1000)).toBe(true);
    expect(shouldEmitBridgeSplitBrainRederive('identity-gate', 'doc-1', 1500)).toBe(false);
    expect(shouldEmitBridgeSplitBrainRederive('post-merge', 'doc-1', 1500)).toBe(false);
  });

  test('different docs have independent windows', () => {
    expect(shouldEmitBridgeSplitBrainRederive('post-merge', 'doc-1', 1000)).toBe(true);
    expect(shouldEmitBridgeSplitBrainRederive('post-merge', 'doc-2', 1000)).toBe(true);
    expect(shouldEmitBridgeSplitBrainRederive('post-merge', 'doc-1', 1500)).toBe(false);
  });

  test('docName=undefined uses __nodoc__ sentinel (distinct from any named doc)', () => {
    expect(shouldEmitBridgeSplitBrainRederive('post-merge', undefined, 1000)).toBe(true);
    expect(shouldEmitBridgeSplitBrainRederive('post-merge', 'doc-1', 1000)).toBe(true);
    expect(shouldEmitBridgeSplitBrainRederive('post-merge', undefined, 1500)).toBe(false);
  });

  test('emitBridgeSplitBrainRederive increments suppressed counter when rate-limited', () => {
    expect(emitBridgeSplitBrainRederive('post-merge', 'doc-1', 1000)).toBe(true);
    expect(getMetrics().bridgeSplitBrainRederivesSuppressed).toBe(0);
    expect(emitBridgeSplitBrainRederive('post-merge', 'doc-1', 1500)).toBe(false);
    expect(getMetrics().bridgeSplitBrainRederivesSuppressed).toBe(1);
    expect(emitBridgeSplitBrainRederive('post-merge', 'doc-1', 2000)).toBe(false);
    expect(getMetrics().bridgeSplitBrainRederivesSuppressed).toBe(2);
  });

  test('emitBridgeSplitBrainRederive returns true after window resets', () => {
    expect(emitBridgeSplitBrainRederive('post-merge', 'doc-1', 1000)).toBe(true);
    expect(emitBridgeSplitBrainRederive('post-merge', 'doc-1', 70_000)).toBe(true);
    expect(getMetrics().bridgeSplitBrainRederivesSuppressed).toBe(0);
  });
});

describe('bridge-invariant-violation payload redaction (OK_TELEMETRY_VERBOSE opt-in)', () => {
  // The structured-log payload must NOT carry raw user content by default.
  // Mirrors the sibling `bridge-merge-content-loss` event's redaction posture
  // (`merge-three-way.ts:202-217`). Operators running single-tenant local
  // deployments can opt in via `OK_TELEMETRY_VERBOSE=1`.
  let originalNodeEnv: string | undefined;
  let originalVerbose: string | undefined;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    originalVerbose = process.env.OK_TELEMETRY_VERBOSE;
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalVerbose === undefined) delete process.env.OK_TELEMETRY_VERBOSE;
    else process.env.OK_TELEMETRY_VERBOSE = originalVerbose;
  });

  function emitOnce(ytextSnapshot: string, fragmentSnapshot: string): Record<string, unknown> {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      assertBridgeInvariant(ytextSnapshot, fragmentSnapshot, {
        site: 'observer-b',
        docName: 'doc-1',
        nowMs: 1000,
      });
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toHaveLength(1);
    return JSON.parse(warnings[0] ?? '{}') as Record<string, unknown>;
  }

  test('default emit redacts raw diff; payload carries length + FNV hash only', () => {
    const event = emitOnce('# user-typed body\n', '# canonical fragment body\n');
    expect(event.event).toBe('bridge-invariant-violation');
    expect(event.redacted).toBe(true);
    // Raw `diff` field is omitted by default — the load-bearing claim of the
    // PII-leak finding.
    expect('diff' in event).toBe(false);
    // Hashes + lengths give operators correlation across recurring violations
    // without leaking raw bytes.
    expect(typeof event.ytextHash).toBe('string');
    expect(typeof event.fragmentHash).toBe('string');
    expect(event.ytextLen).toBe('# user-typed body\n'.length);
    expect(event.fragmentLen).toBe('# canonical fragment body\n'.length);
    // Raw user bytes must not bleed into other fields either.
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('user-typed body');
    expect(serialized).not.toContain('canonical fragment body');
  });

  test('OK_TELEMETRY_VERBOSE=1 includes the truncated diff (opt-in posture)', () => {
    process.env.OK_TELEMETRY_VERBOSE = '1';
    const event = emitOnce('# user-typed body\n', '# canonical fragment body\n');
    expect(event.redacted).toBe(false);
    expect(typeof event.diff).toBe('string');
    // The truncated unifiedDiff carries normalized bytes from both sides.
    expect(String(event.diff)).toContain('user-typed body');
    expect(String(event.diff)).toContain('canonical fragment body');
    // Hashes are still present alongside the diff for cross-event correlation.
    expect(typeof event.ytextHash).toBe('string');
  });

  test('OK_TELEMETRY_VERBOSE=0 stays redacted (only "1" enables verbose)', () => {
    process.env.OK_TELEMETRY_VERBOSE = '0';
    const event = emitOnce('# user-typed body\n', '# canonical fragment body\n');
    expect(event.redacted).toBe(true);
    expect('diff' in event).toBe(false);
  });

  test('FNV-1a hash is stable for the same input across calls', () => {
    const a = emitOnce('# stable A\n', '# stable B\n');
    __resetBridgeWatchdogForTests();
    const b = emitOnce('# stable A\n', '# stable B\n');
    expect(a.ytextHash).toBe(b.ytextHash);
    expect(a.fragmentHash).toBe(b.fragmentHash);
  });

  test('different inputs produce different hashes (collision probability is 1/2^32)', () => {
    const a = emitOnce('# alpha\n', '# beta\n');
    __resetBridgeWatchdogForTests();
    const b = emitOnce('# gamma\n', '# delta\n');
    expect(a.ytextHash).not.toBe(b.ytextHash);
    expect(a.fragmentHash).not.toBe(b.fragmentHash);
  });
});

describe('bridge-tolerance-applied event (FR-41)', () => {
  // Test pattern: capture console.warn output, call assertBridgeInvariant
  // with byte-different but normalize-equal inputs, verify the emit shape
  // and bounded-cardinality attrs.

  function captureWarn(fn: () => void): string[] {
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
    return warnings;
  }

  test('CRLF tolerance fires bridge-tolerance-applied with class=crlf', () => {
    const warnings = captureWarn(() => {
      assertBridgeInvariant('# Hello\r\n', '# Hello\n', { site: 'observer-b' });
    });
    const events = warnings.map((w) => JSON.parse(w));
    const toleranceEvents = events.filter((e) => e.event === 'bridge-tolerance-applied');
    expect(toleranceEvents.length).toBeGreaterThanOrEqual(1);
    expect(toleranceEvents.some((e) => e.class === 'crlf')).toBe(true);
    expect(getMetrics().bridgeToleranceApplied.crlf).toBeGreaterThanOrEqual(1);
  });

  test('BOM tolerance fires class=bom', () => {
    const warnings = captureWarn(() => {
      assertBridgeInvariant('﻿# Hello\n', '# Hello\n', { site: 'observer-b' });
    });
    const events = warnings.map((w) => JSON.parse(w));
    const toleranceEvents = events.filter((e) => e.event === 'bridge-tolerance-applied');
    expect(toleranceEvents.some((e) => e.class === 'bom')).toBe(true);
    expect(getMetrics().bridgeToleranceApplied.bom).toBeGreaterThanOrEqual(1);
  });

  test('byte-equal inputs do NOT emit any tolerance event', () => {
    const warnings = captureWarn(() => {
      assertBridgeInvariant('# Hello\n', '# Hello\n', { site: 'observer-b' });
    });
    expect(warnings).toHaveLength(0);
    expect(getMetrics().bridgeToleranceApplied).toEqual({});
  });

  test('multiple tolerance classes in one input emit one event per class', () => {
    const warnings = captureWarn(() => {
      // Differs by BOM + CRLF + trailing-whitespace.
      assertBridgeInvariant('﻿# Hello   \r\n', '# Hello\n', { site: 'observer-b' });
    });
    const events = warnings.map((w) => JSON.parse(w));
    const toleranceEvents = events.filter((e) => e.event === 'bridge-tolerance-applied');
    const classes = new Set(toleranceEvents.map((e) => e.class));
    expect(classes.has('bom')).toBe(true);
    expect(classes.has('crlf')).toBe(true);
    expect(classes.has('trailing-whitespace')).toBe(true);
  });

  test('event payload is bounded-cardinality: only event + class + site fields', () => {
    const warnings = captureWarn(() => {
      assertBridgeInvariant('# Hello\r\n', '# Hello\n', { site: 'observer-b' });
    });
    const events = warnings.map((w) => JSON.parse(w));
    const toleranceEvents = events.filter((e) => e.event === 'bridge-tolerance-applied');
    for (const event of toleranceEvents) {
      // Bounded cardinality: only allowed keys. Adding `site` lets ops
      // separate observer-b vs persistence vs test-harness tolerance
      // reliance at zero cardinality cost (7 classes × 3 sites = 21 series).
      const keys = Object.keys(event).sort();
      expect(keys).toEqual(['class', 'event', 'site']);
      // No raw content / paths / free-form strings.
      expect(typeof event.class).toBe('string');
      expect(typeof event.site).toBe('string');
      expect(event.event).toBe('bridge-tolerance-applied');
    }
  });

  test('rate-limiter suppresses repeat emissions per class within window', () => {
    // First call should emit.
    captureWarn(() => {
      assertBridgeInvariant('# A\r\n', '# A\n', {
        site: 'observer-b',
        nowMs: 1000,
      });
    });
    // Second call with the same class within the debounce window should NOT
    // emit a second event but the comparison still passes (no-op).
    const warnings = captureWarn(() => {
      assertBridgeInvariant('# B\r\n', '# B\n', {
        site: 'observer-b',
        nowMs: 1500,
      });
    });
    const events = warnings.map((w) => JSON.parse(w));
    const crlfEvents = events.filter(
      (e) => e.event === 'bridge-tolerance-applied' && e.class === 'crlf',
    );
    expect(crlfEvents).toHaveLength(0);
  });

  test('rate-limiter resets after debounce window expires', () => {
    captureWarn(() => {
      assertBridgeInvariant('# A\r\n', '# A\n', {
        site: 'observer-b',
        nowMs: 1000,
      });
    });
    // Past 60s default debounce.
    const warnings = captureWarn(() => {
      assertBridgeInvariant('# B\r\n', '# B\n', {
        site: 'observer-b',
        nowMs: 70_000,
      });
    });
    const events = warnings.map((w) => JSON.parse(w));
    expect(events.some((e) => e.event === 'bridge-tolerance-applied' && e.class === 'crlf')).toBe(
      true,
    );
  });

  test('different classes have independent debounce windows', () => {
    // BOM + CRLF in one call; emits both.
    const warnings = captureWarn(() => {
      assertBridgeInvariant('﻿# A\r\n', '# A\n', {
        site: 'observer-b',
        nowMs: 1000,
      });
    });
    const events = warnings.map((w) => JSON.parse(w));
    const classes = new Set(
      events.filter((e) => e.event === 'bridge-tolerance-applied').map((e) => e.class),
    );
    expect(classes.has('bom')).toBe(true);
    expect(classes.has('crlf')).toBe(true);
  });
});

describe('tolerance-telemetry file hook receives the full un-rate-limited list', () => {
  // The JSONL diagnostic sink is evidence collection bounded by the
  // RotatingAppender's disk cap — it needs fire-frequency completeness, so it
  // gets every fire even when the console/metric path is rate-limited. Two
  // CRLF-only fires inside the same debounce window: the hook must fire on
  // BOTH; the metric counter + console.warn must fire only ONCE.
  let fires: ToleranceFireRecord[] = [];

  beforeEach(() => {
    fires = [];
    setToleranceTelemetryHook((record) => {
      fires.push(record);
    });
  });

  afterEach(() => {
    setToleranceTelemetryHook(null);
  });

  test('hook fires on both calls while console/metric emit once', () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    try {
      assertBridgeInvariant('# Hello\r\n', '# Hello\n', {
        site: 'observer-b',
        docName: 'doc-1',
        nowMs: 1000,
      });
      assertBridgeInvariant('# Hello\r\n', '# Hello\n', {
        site: 'observer-b',
        docName: 'doc-1',
        nowMs: 1500,
      });
    } finally {
      console.warn = originalWarn;
    }

    // File hook: full list — fired on both calls (un-rate-limited).
    expect(fires.filter((f) => f.className === 'crlf')).toHaveLength(2);

    // Console + metric: rate-limited subset — emitted only on the first call.
    const crlfWarnings = warnings
      .map((w) => JSON.parse(w))
      .filter((e) => e.event === 'bridge-tolerance-applied' && e.class === 'crlf');
    expect(crlfWarnings).toHaveLength(1);
    expect(getMetrics().bridgeToleranceApplied.crlf).toBe(1);
  });
});

describe('shouldEmitBridgeToleranceApplied — gate semantics', () => {
  test('first call per (site, class) returns true', () => {
    expect(shouldEmitBridgeToleranceApplied('observer-b', 'crlf', 1000)).toBe(true);
  });

  test('repeat call inside window returns false', () => {
    shouldEmitBridgeToleranceApplied('observer-b', 'crlf', 1000);
    expect(shouldEmitBridgeToleranceApplied('observer-b', 'crlf', 1500)).toBe(false);
  });

  test('different classes have independent windows', () => {
    expect(shouldEmitBridgeToleranceApplied('observer-b', 'crlf', 1000)).toBe(true);
    expect(shouldEmitBridgeToleranceApplied('observer-b', 'bom', 1000)).toBe(true);
    expect(shouldEmitBridgeToleranceApplied('observer-b', 'crlf', 1500)).toBe(false);
    expect(shouldEmitBridgeToleranceApplied('observer-b', 'bom', 1500)).toBe(false);
  });

  test('different sites for the same class have independent windows', () => {
    // Observer-b CRLF reliance and persistence-site CRLF reliance surface
    // separately in dashboards. persistence's first CRLF event
    // would be silently suppressed if observer-b had emitted within the
    // 60s window — operators would underreport persistence's tolerance
    // usage by exactly the overlapping rate.
    expect(shouldEmitBridgeToleranceApplied('observer-b', 'crlf', 1000)).toBe(true);
    expect(shouldEmitBridgeToleranceApplied('persistence', 'crlf', 1500)).toBe(true);
    expect(shouldEmitBridgeToleranceApplied('observer-b', 'crlf', 1700)).toBe(false);
    expect(shouldEmitBridgeToleranceApplied('persistence', 'crlf', 1900)).toBe(false);
  });

  test('post-debounce-expiry call returns true', () => {
    shouldEmitBridgeToleranceApplied('observer-b', 'crlf', 1000);
    expect(shouldEmitBridgeToleranceApplied('observer-b', 'crlf', 70_000)).toBe(true);
  });
});

describe('shouldEmitBridgeInvariantViolation — lazy prune of past-window entries', () => {
  // Pruning is the watchdog's only memory-bounding mechanism for the
  // rate-limiter cache. It fires opportunistically when the map exceeds
  // MAX_VIOLATION_RATE_TUPLES (1024) — the next emission walks past-window
  // entries (older than `debounceMs`) and deletes them. Without these
  // tests, an off-by-one on the threshold check (`>` vs `>=`), a reorder
  // of prune-then-set, or accidental deletion of in-window entries would
  // not regress any test — the gate's emit/suppress decisions are
  // identical pre- and post-prune at the public-API level. These tests
  // assert memory-boundedness via the test-only count seam.

  test('grows linearly below the prune threshold', () => {
    for (let i = 0; i < 1023; i++) {
      shouldEmitBridgeInvariantViolation('observer-b', `doc-${i}`, 0);
    }
    expect(__getViolationRateTupleCountForTests()).toBe(1023);
  });

  test('past-window entries reclaim when threshold is exceeded', () => {
    // Fill exactly to the threshold at t=0 (default debounce = 60s = 60_000ms).
    for (let i = 0; i < 1024; i++) {
      shouldEmitBridgeInvariantViolation('observer-b', `doc-${i}`, 0);
    }
    expect(__getViolationRateTupleCountForTests()).toBe(1024);

    // Trigger the prune branch: next emit at t=70_000 finds size >= 1024,
    // walks the map, and deletes every entry whose last-emit is past the
    // debounce window. All 1024 t=0 entries qualify (70_000 - 0 > 60_000).
    // The new key is then inserted, leaving size = 1.
    shouldEmitBridgeInvariantViolation('observer-b', 'doc-new', 70_000);
    expect(__getViolationRateTupleCountForTests()).toBe(1);
  });

  test('in-window entries are preserved during prune (mixed window state)', () => {
    // 1023 entries at t=0 (will be past-window at t=70_000) + 1 entry at
    // t=30_000 (still in-window at t=70_000 because 70_000 - 30_000 < 60_000).
    for (let i = 0; i < 1023; i++) {
      shouldEmitBridgeInvariantViolation('observer-b', `doc-old-${i}`, 0);
    }
    shouldEmitBridgeInvariantViolation('observer-b', 'doc-fresh', 30_000);
    expect(__getViolationRateTupleCountForTests()).toBe(1024);

    // Trigger prune. Only past-window entries should reclaim.
    shouldEmitBridgeInvariantViolation('observer-b', 'doc-new', 70_000);
    // Surviving entries: 'doc-fresh' (in-window) + 'doc-new' (just inserted).
    expect(__getViolationRateTupleCountForTests()).toBe(2);
    // doc-fresh's debounce gate is still active — repeat emit suppressed.
    expect(shouldEmitBridgeInvariantViolation('observer-b', 'doc-fresh', 71_000)).toBe(false);
  });

  test('threshold boundary: exactly 1023 entries does not trigger prune', () => {
    for (let i = 0; i < 1023; i++) {
      shouldEmitBridgeInvariantViolation('observer-b', `doc-${i}`, 0);
    }
    // Even with all entries past-window, no prune walks because size < 1024.
    shouldEmitBridgeInvariantViolation('observer-b', 'doc-1024th', 70_000);
    expect(__getViolationRateTupleCountForTests()).toBe(1024);
  });

  test('all-in-window: prune walks but reclaims nothing (documents conditional bound)', () => {
    // Fill 1024 entries within the same window.
    for (let i = 0; i < 1024; i++) {
      shouldEmitBridgeInvariantViolation('observer-b', `doc-${i}`, 1_000);
    }
    expect(__getViolationRateTupleCountForTests()).toBe(1024);

    // Next emit at t=2_000 (still inside the 60s debounce window for all
    // existing entries). Prune walks all 1024 entries; none qualify
    // (2_000 - 1_000 = 1_000 < 60_000). Map keeps growing — this is the
    // conditional-bound caveat documented on MAX_VIOLATION_RATE_TUPLES.
    shouldEmitBridgeInvariantViolation('observer-b', 'doc-new', 2_000);
    expect(__getViolationRateTupleCountForTests()).toBe(1025);
  });
});

describe('shouldEmitBridgeSplitBrainRederive — lazy prune of past-window entries', () => {
  // Mirrors the bridge-invariant prune suite. The split-brain
  // rate-limiter (`lastSplitBrainEmitMs`) shares the same lazy-prune design
  // and the same MAX_VIOLATION_RATE_TUPLES (1024) bound, so it has the same
  // silent-regression surface: an off-by-one on the threshold check
  // (`>` vs `>=`), a reorder of prune-then-set, or accidental deletion of
  // in-window entries would leave the gate's emit/suppress decisions
  // identical at the public-API level. These tests assert memory-boundedness
  // via the test-only count seam. The key tuple is (site, doc) where site is
  // a BridgeSplitBrainSite ('identity-gate' | 'post-merge').

  test('grows linearly below the prune threshold', () => {
    for (let i = 0; i < 1023; i++) {
      shouldEmitBridgeSplitBrainRederive('post-merge', `doc-${i}`, 0);
    }
    expect(__getSplitBrainRateTupleCountForTests()).toBe(1023);
  });

  test('past-window entries reclaim when threshold is exceeded', () => {
    // Fill exactly to the threshold at t=0 (default debounce = 60s = 60_000ms).
    for (let i = 0; i < 1024; i++) {
      shouldEmitBridgeSplitBrainRederive('post-merge', `doc-${i}`, 0);
    }
    expect(__getSplitBrainRateTupleCountForTests()).toBe(1024);

    // Trigger the prune branch: next emit at t=70_000 finds size >= 1024,
    // walks the map, and deletes every entry whose last-emit is past the
    // debounce window. All 1024 t=0 entries qualify (70_000 - 0 > 60_000).
    // The new key is then inserted, leaving size = 1.
    shouldEmitBridgeSplitBrainRederive('post-merge', 'doc-new', 70_000);
    expect(__getSplitBrainRateTupleCountForTests()).toBe(1);
  });

  test('in-window entries are preserved during prune (mixed window state)', () => {
    // 1023 entries at t=0 (will be past-window at t=70_000) + 1 entry at
    // t=30_000 (still in-window at t=70_000 because 70_000 - 30_000 < 60_000).
    for (let i = 0; i < 1023; i++) {
      shouldEmitBridgeSplitBrainRederive('post-merge', `doc-old-${i}`, 0);
    }
    shouldEmitBridgeSplitBrainRederive('post-merge', 'doc-fresh', 30_000);
    expect(__getSplitBrainRateTupleCountForTests()).toBe(1024);

    // Trigger prune. Only past-window entries should reclaim.
    shouldEmitBridgeSplitBrainRederive('post-merge', 'doc-new', 70_000);
    // Surviving entries: 'doc-fresh' (in-window) + 'doc-new' (just inserted).
    expect(__getSplitBrainRateTupleCountForTests()).toBe(2);
    // doc-fresh's debounce gate is still active — repeat emit suppressed.
    expect(shouldEmitBridgeSplitBrainRederive('post-merge', 'doc-fresh', 71_000)).toBe(false);
  });

  test('threshold boundary: exactly 1023 entries does not trigger prune', () => {
    for (let i = 0; i < 1023; i++) {
      shouldEmitBridgeSplitBrainRederive('post-merge', `doc-${i}`, 0);
    }
    // Even with all entries past-window, no prune walks because size < 1024.
    shouldEmitBridgeSplitBrainRederive('post-merge', 'doc-1024th', 70_000);
    expect(__getSplitBrainRateTupleCountForTests()).toBe(1024);
  });

  test('all-in-window: prune walks but reclaims nothing (documents conditional bound)', () => {
    // Fill 1024 entries within the same window.
    for (let i = 0; i < 1024; i++) {
      shouldEmitBridgeSplitBrainRederive('post-merge', `doc-${i}`, 1_000);
    }
    expect(__getSplitBrainRateTupleCountForTests()).toBe(1024);

    // Next emit at t=2_000 (still inside the 60s debounce window for all
    // existing entries). Prune walks all 1024 entries; none qualify
    // (2_000 - 1_000 = 1_000 < 60_000). Map keeps growing — this is the
    // conditional-bound caveat documented on MAX_VIOLATION_RATE_TUPLES.
    shouldEmitBridgeSplitBrainRederive('post-merge', 'doc-new', 2_000);
    expect(__getSplitBrainRateTupleCountForTests()).toBe(1025);
  });

  test('all three sites for the same doc occupy distinct keys (each counted)', () => {
    // The key tuple is (site, doc) — the three detection sites surface
    // independently, so the same doc under all sites occupies three entries.
    // A regression that normalized one site name onto another in the key
    // construction would silently share their rate-limit windows.
    shouldEmitBridgeSplitBrainRederive('post-merge', 'doc-1', 0);
    shouldEmitBridgeSplitBrainRederive('identity-gate', 'doc-1', 0);
    shouldEmitBridgeSplitBrainRederive('error-recovery', 'doc-1', 0);
    expect(__getSplitBrainRateTupleCountForTests()).toBe(3);
  });
});

describe('assertBridgeInvariant — return value reflects normalize-equality', () => {
  // The return value lets callers (e.g., persistence) drop a redundant
  // `normalizeBridge` recomputation when gating follow-up work on the
  // same comparison the watchdog already performed. Pinning these
  // values prevents accidental divergence between watchdog comparison
  // and caller gate.

  test('byte-equal inputs return true', () => {
    expect(assertBridgeInvariant('# Hello\n', '# Hello\n', { site: 'observer-b' })).toBe(true);
  });

  test('tolerance-equivalent inputs return true (CRLF case)', () => {
    expect(assertBridgeInvariant('# Hello\r\n', '# Hello\n', { site: 'observer-b' })).toBe(true);
  });

  test('tolerance-equivalent inputs return true (BOM case)', () => {
    expect(assertBridgeInvariant('﻿# Hello\n', '# Hello\n', { site: 'observer-b' })).toBe(true);
  });

  test('non-equivalent inputs with suppressDevThrow return false (no throw)', () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const result = assertBridgeInvariant('# Foo\n', '# Bar\n', {
        site: 'persistence',
        docName: 'doc-x',
        suppressDevThrow: true,
      });
      expect(result).toBe(false);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('rate-limited (suppressed) emission still returns false', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      // First call: emits. Second call same window: suppressed.
      const r1 = assertBridgeInvariant('# A\n', '# B\n', {
        site: 'observer-b',
        docName: 'doc-1',
        nowMs: 1000,
      });
      const r2 = assertBridgeInvariant('# A\n', '# C\n', {
        site: 'observer-b',
        docName: 'doc-1',
        nowMs: 1500,
      });
      expect(r1).toBe(false);
      expect(r2).toBe(false);
    } finally {
      console.warn = originalWarn;
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });
});

describe('assertBridgeInvariant — parse-equivalence fallback (canonicalizeBody opt)', () => {
  // CommonMark lazy continuations serialize non-identically beyond the
  // normalizeBridge tolerance set (step 7f keeps them divergent for the
  // router's byte-preserving residual merge), yet parse identically — the
  // fragment IS parse(ytext), so the health check must not fire. The
  // `canonicalizeBody` opt lets a call site holding a MarkdownManager
  // supply the authoritative equivalence: canonicalize(left body) equals
  // the (already-canonical) right body ⇒ tolerated, not a violation.
  const mgr = new MarkdownManager({ extensions: sharedExtensions });
  const canonicalizeBody = (body: string): string => mgr.serialize(mgr.parseWithFallback(body));

  const LAZY_RAW = '- item one continues here,\nlazily on the next line.\n';

  test('normalize-divergent but parse-equivalent inputs are tolerated (returns true, no throw)', () => {
    const canonical = canonicalizeBody(LAZY_RAW);
    // Class trigger: byte-divergent AND beyond normalizeBridge tolerance.
    expect(canonical).not.toBe(LAZY_RAW);
    expect(normalizeBridge(canonical)).not.toBe(normalizeBridge(LAZY_RAW));

    const result = assertBridgeInvariant(LAZY_RAW, canonical, {
      site: 'persistence',
      docName: 'lazy-doc',
      canonicalizeBody,
    });
    expect(result).toBe(true);
    expect(getMetrics().bridgeInvariantViolations).toBe(0);
    expect(getMetrics().bridgeInvariantViolationsSuppressed).toBe(0);
  });

  test('tolerated parse-equivalent pair emits bridge-tolerance-applied with the parse-equivalence class', () => {
    const canonical = canonicalizeBody(LAZY_RAW);
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      assertBridgeInvariant(LAZY_RAW, canonical, {
        site: 'persistence',
        docName: 'lazy-doc',
        canonicalizeBody,
      });
    } finally {
      console.warn = originalWarn;
    }
    const toleranceEvents = warnings
      .map((w) => {
        try {
          return JSON.parse(w) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, unknown> => e?.event === 'bridge-tolerance-applied');
    expect(toleranceEvents.map((e) => e.class)).toContain('parse-equivalence');
  });

  test('genuinely divergent inputs still throw with canonicalizeBody provided', () => {
    // Right side lacks content the left carries — canonicalizing the left
    // cannot bridge that gap, so the loud-fail contract must hold.
    expect(() => {
      assertBridgeInvariant(LAZY_RAW, '# Completely different fragment\n', {
        site: 'observer-b',
        docName: 'diverged-doc',
        canonicalizeBody,
      });
    }).toThrow(BridgeInvariantViolationError);
  });

  test('frontmatter divergence is not bridged by body parse-equivalence', () => {
    const left = `---\ntitle: A\n---\n\n${LAZY_RAW}`;
    const right = `---\ntitle: B\n---\n\n${canonicalizeBody(LAZY_RAW)}`;
    expect(() => {
      assertBridgeInvariant(left, right, {
        site: 'observer-b',
        docName: 'fm-diverged-doc',
        canonicalizeBody,
      });
    }).toThrow(BridgeInvariantViolationError);
  });

  test('without canonicalizeBody the strict normalize-only behavior is preserved', () => {
    const canonical = canonicalizeBody(LAZY_RAW);
    expect(() => {
      assertBridgeInvariant(LAZY_RAW, canonical, {
        site: 'observer-b',
        docName: 'lazy-doc-strict',
      });
    }).toThrow(BridgeInvariantViolationError);
  });
});
