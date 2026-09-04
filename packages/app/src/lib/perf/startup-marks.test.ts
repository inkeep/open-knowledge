import { afterEach, beforeEach, describe, expect, test } from 'vitest';
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
  if (HAD_WINDOW) globalRef.window = ORIGINAL_WINDOW;
  else delete globalRef.window;
});

describe('startup-marks', () => {
  test('reports only once both checkpoints land, with first-content = the later of the two', () => {
    const calls = installBridge();
    pageListReady();
    expect(calls.length).toBe(0);
    firstContent();
    expect(calls.length).toBe(1);
    const { pageListReadyMs, firstContentMs } = calls[0];
    expect(firstContentMs).toBeGreaterThanOrEqual(pageListReadyMs);
  });

  test('first-content is the later of the two regardless of arrival order', () => {
    const calls = installBridge();
    firstContent();
    expect(calls.length).toBe(0);
    pageListReady();
    expect(calls.length).toBe(1);
    const { pageListReadyMs, firstContentMs } = calls[0];
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
