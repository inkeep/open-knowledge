import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  BridgeInvariantViolationError,
  setToleranceTelemetryHook,
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
    expect(getMetrics().bridgeInvariantViolations).toBe(0);
    expect(getMetrics().bridgeInvariantViolationsSuppressed).toBe(0);
  });

  test('suppressDevThrow:true emits + increments instead of throwing (persistence policy)', () => {
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
    expect(event['doc.name']).toBe('doc-1');
  });

  test('repeat violations within debounce window suppressed (counter increments suppressed)', () => {
    const originalWarn = console.warn;
    console.warn = () => {};

    try {
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
    expect('diff' in event).toBe(false);
    expect(typeof event.ytextHash).toBe('string');
    expect(typeof event.fragmentHash).toBe('string');
    expect(event.ytextLen).toBe('# user-typed body\n'.length);
    expect(event.fragmentLen).toBe('# canonical fragment body\n'.length);
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('user-typed body');
    expect(serialized).not.toContain('canonical fragment body');
  });

  test('OK_TELEMETRY_VERBOSE=1 includes the truncated diff (opt-in posture)', () => {
    process.env.OK_TELEMETRY_VERBOSE = '1';
    const event = emitOnce('# user-typed body\n', '# canonical fragment body\n');
    expect(event.redacted).toBe(false);
    expect(typeof event.diff).toBe('string');
    expect(String(event.diff)).toContain('user-typed body');
    expect(String(event.diff)).toContain('canonical fragment body');
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
      const keys = Object.keys(event).sort();
      expect(keys).toEqual(['class', 'event', 'site']);
      expect(typeof event.class).toBe('string');
      expect(typeof event.site).toBe('string');
      expect(event.event).toBe('bridge-tolerance-applied');
    }
  });

  test('rate-limiter suppresses repeat emissions per class within window', () => {
    captureWarn(() => {
      assertBridgeInvariant('# A\r\n', '# A\n', {
        site: 'observer-b',
        nowMs: 1000,
      });
    });
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

    expect(fires.filter((f) => f.className === 'crlf')).toHaveLength(2);

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
  test('grows linearly below the prune threshold', () => {
    for (let i = 0; i < 1023; i++) {
      shouldEmitBridgeInvariantViolation('observer-b', `doc-${i}`, 0);
    }
    expect(__getViolationRateTupleCountForTests()).toBe(1023);
  });

  test('past-window entries reclaim when threshold is exceeded', () => {
    for (let i = 0; i < 1024; i++) {
      shouldEmitBridgeInvariantViolation('observer-b', `doc-${i}`, 0);
    }
    expect(__getViolationRateTupleCountForTests()).toBe(1024);

    shouldEmitBridgeInvariantViolation('observer-b', 'doc-new', 70_000);
    expect(__getViolationRateTupleCountForTests()).toBe(1);
  });

  test('in-window entries are preserved during prune (mixed window state)', () => {
    for (let i = 0; i < 1023; i++) {
      shouldEmitBridgeInvariantViolation('observer-b', `doc-old-${i}`, 0);
    }
    shouldEmitBridgeInvariantViolation('observer-b', 'doc-fresh', 30_000);
    expect(__getViolationRateTupleCountForTests()).toBe(1024);

    shouldEmitBridgeInvariantViolation('observer-b', 'doc-new', 70_000);
    expect(__getViolationRateTupleCountForTests()).toBe(2);
    expect(shouldEmitBridgeInvariantViolation('observer-b', 'doc-fresh', 71_000)).toBe(false);
  });

  test('threshold boundary: exactly 1023 entries does not trigger prune', () => {
    for (let i = 0; i < 1023; i++) {
      shouldEmitBridgeInvariantViolation('observer-b', `doc-${i}`, 0);
    }
    shouldEmitBridgeInvariantViolation('observer-b', 'doc-1024th', 70_000);
    expect(__getViolationRateTupleCountForTests()).toBe(1024);
  });

  test('all-in-window: prune walks but reclaims nothing (documents conditional bound)', () => {
    for (let i = 0; i < 1024; i++) {
      shouldEmitBridgeInvariantViolation('observer-b', `doc-${i}`, 1_000);
    }
    expect(__getViolationRateTupleCountForTests()).toBe(1024);

    shouldEmitBridgeInvariantViolation('observer-b', 'doc-new', 2_000);
    expect(__getViolationRateTupleCountForTests()).toBe(1025);
  });
});

describe('shouldEmitBridgeSplitBrainRederive — lazy prune of past-window entries', () => {
  test('grows linearly below the prune threshold', () => {
    for (let i = 0; i < 1023; i++) {
      shouldEmitBridgeSplitBrainRederive('post-merge', `doc-${i}`, 0);
    }
    expect(__getSplitBrainRateTupleCountForTests()).toBe(1023);
  });

  test('past-window entries reclaim when threshold is exceeded', () => {
    for (let i = 0; i < 1024; i++) {
      shouldEmitBridgeSplitBrainRederive('post-merge', `doc-${i}`, 0);
    }
    expect(__getSplitBrainRateTupleCountForTests()).toBe(1024);

    shouldEmitBridgeSplitBrainRederive('post-merge', 'doc-new', 70_000);
    expect(__getSplitBrainRateTupleCountForTests()).toBe(1);
  });

  test('in-window entries are preserved during prune (mixed window state)', () => {
    for (let i = 0; i < 1023; i++) {
      shouldEmitBridgeSplitBrainRederive('post-merge', `doc-old-${i}`, 0);
    }
    shouldEmitBridgeSplitBrainRederive('post-merge', 'doc-fresh', 30_000);
    expect(__getSplitBrainRateTupleCountForTests()).toBe(1024);

    shouldEmitBridgeSplitBrainRederive('post-merge', 'doc-new', 70_000);
    expect(__getSplitBrainRateTupleCountForTests()).toBe(2);
    expect(shouldEmitBridgeSplitBrainRederive('post-merge', 'doc-fresh', 71_000)).toBe(false);
  });

  test('threshold boundary: exactly 1023 entries does not trigger prune', () => {
    for (let i = 0; i < 1023; i++) {
      shouldEmitBridgeSplitBrainRederive('post-merge', `doc-${i}`, 0);
    }
    shouldEmitBridgeSplitBrainRederive('post-merge', 'doc-1024th', 70_000);
    expect(__getSplitBrainRateTupleCountForTests()).toBe(1024);
  });

  test('all-in-window: prune walks but reclaims nothing (documents conditional bound)', () => {
    for (let i = 0; i < 1024; i++) {
      shouldEmitBridgeSplitBrainRederive('post-merge', `doc-${i}`, 1_000);
    }
    expect(__getSplitBrainRateTupleCountForTests()).toBe(1024);

    shouldEmitBridgeSplitBrainRederive('post-merge', 'doc-new', 2_000);
    expect(__getSplitBrainRateTupleCountForTests()).toBe(1025);
  });

  test('all three sites for the same doc occupy distinct keys (each counted)', () => {
    shouldEmitBridgeSplitBrainRederive('post-merge', 'doc-1', 0);
    shouldEmitBridgeSplitBrainRederive('identity-gate', 'doc-1', 0);
    shouldEmitBridgeSplitBrainRederive('error-recovery', 'doc-1', 0);
    expect(__getSplitBrainRateTupleCountForTests()).toBe(3);
  });
});

describe('assertBridgeInvariant — return value reflects normalize-equality', () => {
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
