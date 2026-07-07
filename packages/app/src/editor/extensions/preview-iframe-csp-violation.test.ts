/**
 * CSP-violation surfacing for the preview iframe.
 *
 * The `html preview` iframe runs untrusted content under a deliberately
 * restrictive CSP. When the policy (or the host's own security layer) blocks a
 * request, the browser fires `securitypolicyviolation` inside the iframe and
 * drops the request — silently. The reader, especially inside the Claude
 * desktop preview browser where devtools is out of reach, sees only a broken
 * embed with no explanation.
 *
 * These tests pin the iframe-side half of the fix: the bootstrap script must
 * (1) register a `securitypolicyviolation` listener, (2) coalesce + dedupe +
 * bound the blocked requests, and (3) post them to the parent under a stable
 * key that {@link parsePreviewCspViolationMessage} can read. The CSP itself is
 * unchanged — `code-block-preview-csp.test.ts` continues to guard its bytes.
 */
import { describe, expect, mock, test } from 'bun:test';
import {
  buildPreviewIframeHeader,
  PREVIEW_CSP_VIOLATION_SAMPLE_CAP,
  parsePreviewCspViolationMessage,
} from './preview-iframe-header';

/**
 * Evaluate the injected bootstrap `<script>` in a controlled scope with every
 * global it touches passed in as a parameter — no jsdom needed. Returns a
 * `dispatch` that fires a synthetic `securitypolicyviolation` through the
 * listener the script registered, plus the `parent.postMessage` spy.
 *
 * `requestAnimationFrame` is a no-op so the auto-height reporter never posts —
 * the only `postMessage` traffic the spy sees is CSP-violation reports.
 * `setTimeout`/`clearTimeout` are the real timers so the report debounce
 * (coalescing a burst of violations into one message) is exercised for real.
 */
function evalBootstrap() {
  const header = buildPreviewIframeHeader('light');
  const script = header.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const addEventListener = (type: string, fn: (e: unknown) => void) => {
    listeners[type] ||= [];
    listeners[type].push(fn);
  };
  const postMessage = mock((_msg: unknown, _origin?: string) => {});
  const documentStub = {
    documentElement: { classList: { add() {}, remove() {} } },
    readyState: 'complete',
    addEventListener() {},
    body: {},
  };
  new Function(
    'document',
    'parent',
    'window',
    'addEventListener',
    'setTimeout',
    'clearTimeout',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'getComputedStyle',
    script,
  )(
    documentStub,
    { postMessage },
    {},
    addEventListener,
    setTimeout,
    clearTimeout,
    () => 0,
    () => {},
    () => ({ marginBottom: '0' }),
  );
  const dispatch = (e: {
    violatedDirective?: string;
    effectiveDirective?: string;
    blockedURI?: string;
  }) => {
    for (const fn of listeners.securitypolicyviolation ?? []) fn(e);
  };
  return { dispatch, postMessage, listeners };
}

/** Pull the latest CSP-violation payload the bootstrap posted to the parent. */
function latestCspReport(postMessage: ReturnType<typeof mock>) {
  const calls = postMessage.mock.calls.filter(
    (c) => parsePreviewCspViolationMessage(c[0]) !== null,
  );
  return calls.length > 0 ? parsePreviewCspViolationMessage(calls.at(-1)?.[0]) : null;
}

const DEBOUNCE_WAIT = 350;

describe('buildPreviewIframeHeader — CSP-violation reporting (wiring)', () => {
  const header = buildPreviewIframeHeader('light');

  test('registers a securitypolicyviolation listener in the bootstrap', () => {
    expect(header).toContain('securitypolicyviolation');
  });

  test('reports blocked requests under the okPreviewCspViolation key', () => {
    expect(header).toContain('okPreviewCspViolation');
  });

  test('reads the blocked URI and the violated directive off the event', () => {
    expect(header).toContain('blockedURI');
    // Either the modern effectiveDirective or the legacy violatedDirective.
    expect(header).toMatch(/effectiveDirective|violatedDirective/);
  });
});

describe('buildPreviewIframeHeader — CSP-violation reporting (behavior)', () => {
  test('a blocked request is posted to the parent with directive + uri', async () => {
    const { dispatch, postMessage } = evalBootstrap();
    dispatch({ violatedDirective: 'img-src', blockedURI: 'http://insecure.example/tile.png' });
    await new Promise((r) => setTimeout(r, DEBOUNCE_WAIT));

    const report = latestCspReport(postMessage);
    expect(report).not.toBeNull();
    expect(report?.blocked).toEqual([
      { directive: 'img-src', uri: 'http://insecure.example/tile.png' },
    ]);
    expect(report?.truncated).toBe(false);
  });

  test('coalesces a burst of violations into a single deduped report', async () => {
    const { dispatch, postMessage } = evalBootstrap();
    // Same directive+uri three times → one entry; a second distinct one → two.
    dispatch({ violatedDirective: 'img-src', blockedURI: 'http://a/1.png' });
    dispatch({ violatedDirective: 'img-src', blockedURI: 'http://a/1.png' });
    dispatch({ violatedDirective: 'img-src', blockedURI: 'http://a/1.png' });
    dispatch({ effectiveDirective: 'font-src', blockedURI: 'http://a/font.woff' });
    await new Promise((r) => setTimeout(r, DEBOUNCE_WAIT));

    // Debounce coalesces the burst → exactly one report message reached parent.
    const cspMessages = postMessage.mock.calls.filter(
      (c) => parsePreviewCspViolationMessage(c[0]) !== null,
    );
    expect(cspMessages.length).toBe(1);

    const report = latestCspReport(postMessage);
    expect(report?.blocked).toEqual([
      { directive: 'img-src', uri: 'http://a/1.png' },
      { directive: 'font-src', uri: 'http://a/font.woff' },
    ]);
  });

  test('bounds the report and flags truncation past the sample cap', async () => {
    const { dispatch, postMessage } = evalBootstrap();
    const n = PREVIEW_CSP_VIOLATION_SAMPLE_CAP + 5;
    for (let i = 0; i < n; i++) {
      dispatch({ violatedDirective: 'img-src', blockedURI: `http://a/${i}.png` });
    }
    await new Promise((r) => setTimeout(r, DEBOUNCE_WAIT));

    const report = latestCspReport(postMessage);
    expect(report?.blocked.length).toBe(PREVIEW_CSP_VIOLATION_SAMPLE_CAP);
    expect(report?.truncated).toBe(true);
  });

  test('prefers effectiveDirective over the deprecated violatedDirective', async () => {
    // Both fields can be present; effectiveDirective is canonical. An inverted
    // fallback (`violatedDirective || effectiveDirective`) would still pass the
    // other tests, so pin the priority on a single event carrying both.
    const { dispatch, postMessage } = evalBootstrap();
    dispatch({
      effectiveDirective: 'img-src',
      violatedDirective: 'default-src',
      blockedURI: 'http://a/x.png',
    });
    await new Promise((r) => setTimeout(r, DEBOUNCE_WAIT));
    expect(latestCspReport(postMessage)?.blocked[0]?.directive).toBe('img-src');
  });
});

describe('parsePreviewCspViolationMessage', () => {
  test('reads a well-formed report', () => {
    const msg = {
      okPreviewCspViolation: {
        blocked: [{ directive: 'img-src', uri: 'http://x/y.png' }],
        truncated: false,
      },
    };
    expect(parsePreviewCspViolationMessage(msg)).toEqual({
      blocked: [{ directive: 'img-src', uri: 'http://x/y.png' }],
      truncated: false,
    });
  });

  test('passes the truncated flag through', () => {
    const msg = {
      okPreviewCspViolation: {
        blocked: [{ directive: 'img-src', uri: 'http://x' }],
        truncated: true,
      },
    };
    expect(parsePreviewCspViolationMessage(msg)?.truncated).toBe(true);
  });

  test('filters entries that are not {directive,uri} string pairs', () => {
    const msg = {
      okPreviewCspViolation: {
        blocked: [
          { directive: 'img-src', uri: 'http://ok' },
          { directive: 42, uri: 'http://bad' },
          { directive: 'font-src' },
          null,
          'nope',
        ],
        truncated: false,
      },
    };
    expect(parsePreviewCspViolationMessage(msg)?.blocked).toEqual([
      { directive: 'img-src', uri: 'http://ok' },
    ]);
  });

  test('rejects non-violation payloads', () => {
    expect(parsePreviewCspViolationMessage(null)).toBeNull();
    expect(parsePreviewCspViolationMessage('blocked')).toBeNull();
    expect(parsePreviewCspViolationMessage({ okPreviewHeight: 400 })).toBeNull();
    expect(parsePreviewCspViolationMessage({ okPreviewCspViolation: null })).toBeNull();
    expect(parsePreviewCspViolationMessage({ okPreviewCspViolation: {} })).toBeNull();
    expect(parsePreviewCspViolationMessage({ okPreviewCspViolation: { blocked: 'x' } })).toBeNull();
    // An empty blocked list carries no information → treated as not-a-report.
    expect(parsePreviewCspViolationMessage({ okPreviewCspViolation: { blocked: [] } })).toBeNull();
  });
});
