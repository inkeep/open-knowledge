import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  __resetStartupMarksForTest,
  firstContent,
  onFirstContent,
  pageListReady,
} from './startup-marks';

interface ReportedMarks {
  pageListReadyMs: number;
  firstContentMs: number;
}

// The plain (non-DOM) Bun runner has no `window` global; the module under test
// reads `window.okDesktop`, so the test provides a minimal `window` shim on
// `globalThis` and mutates `okDesktop` on it. Capture the original so cleanup
// can fully restore it — leaving a bare `window` shim on globalThis leaks into
// every later test file in the same process (any code branching on
// `typeof window !== 'undefined'` would then see a phantom window).
const globalRef = globalThis as unknown as { window?: { okDesktop?: unknown } };
const HAD_WINDOW = 'window' in globalRef;
const ORIGINAL_WINDOW = globalRef.window;

function win(): { okDesktop?: unknown } {
  globalRef.window ??= {};
  return globalRef.window;
}

function installBridge(): ReportedMarks[] {
  const calls: ReportedMarks[] = [];
  win().okDesktop = {
    startup: {
      reportMarks: (marks: ReportedMarks) => {
        calls.push(marks);
      },
    },
  };
  return calls;
}

function clearBridge(): void {
  delete win().okDesktop;
}

beforeEach(() => {
  __resetStartupMarksForTest();
});

afterEach(() => {
  __resetStartupMarksForTest();
  // Restore `window` to its pre-test state so no phantom shim leaks forward.
  if (HAD_WINDOW) globalRef.window = ORIGINAL_WINDOW;
  else delete globalRef.window;
});

describe('startup-marks', () => {
  test('reports only once both checkpoints land, with first-content = the later of the two', () => {
    const calls = installBridge();
    pageListReady();
    // Only one checkpoint so far — no report yet.
    expect(calls.length).toBe(0);
    firstContent();
    expect(calls.length).toBe(1);
    const { pageListReadyMs, firstContentMs } = calls[0];
    // firstContent ran second, so it is the later timestamp.
    expect(firstContentMs).toBeGreaterThanOrEqual(pageListReadyMs);
  });

  test('first-content is the later of the two regardless of arrival order', () => {
    const calls = installBridge();
    // Active doc syncs BEFORE the page list finishes loading.
    firstContent();
    expect(calls.length).toBe(0);
    pageListReady();
    expect(calls.length).toBe(1);
    const { pageListReadyMs, firstContentMs } = calls[0];
    // page-list landed last, so first-content == page-list-ready time here.
    expect(firstContentMs).toBe(pageListReadyMs);
  });

  test('reports exactly once even if checkpoints fire repeatedly', () => {
    const calls = installBridge();
    pageListReady();
    pageListReady();
    firstContent();
    firstContent();
    pageListReady();
    expect(calls.length).toBe(1);
  });

  test('is a no-op (no throw) when the desktop bridge is absent', () => {
    clearBridge();
    expect(() => {
      pageListReady();
      firstContent();
    }).not.toThrow();
  });

  test('is a no-op when the bridge lacks the startup surface (older host)', () => {
    win().okDesktop = {};
    expect(() => {
      pageListReady();
      firstContent();
    }).not.toThrow();
  });

  test('onFirstContent fires with the computed first-content epoch when both land', () => {
    installBridge();
    let received: number | undefined;
    onFirstContent((ms) => {
      received = ms;
    });
    pageListReady();
    expect(received).toBeUndefined();
    firstContent();
    expect(typeof received).toBe('number');
  });

  test('onFirstContent fires immediately if first-content already reached', () => {
    installBridge();
    pageListReady();
    firstContent();
    let received: number | undefined;
    onFirstContent((ms) => {
      received = ms;
    });
    expect(typeof received).toBe('number');
  });
});
