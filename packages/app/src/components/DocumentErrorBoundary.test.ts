/**
 * DocumentErrorBoundary — unit tests for the pure `errorCopy` mapping.
 *
 * Component-level rendering behavior (fallback-on-throw, retry invalidate+reset
 * ordering, back-nav gating, resetKeys clearing) is exercised end-to-end by
 * Playwright in `tests/stress/docs-open.e2e.ts`. This file
 * stays at the pure-function altitude that the rest of the repo uses for UI
 * helpers — no DOM, no React renderer, no @testing-library dependency added.
 */

import { describe, expect, test } from 'bun:test';
import { MountAbortError } from '@/editor/mount-promise';
import {
  BridgeSetupError,
  DocumentNotFoundError,
  PreSyncDisconnectError,
  ServerCapabilityMismatchError,
  SyncTimeoutError,
} from '@/editor/sync-promise';
import { errorCopy, errorDocName, isServerReachError } from './DocumentErrorBoundary';

describe('errorCopy', () => {
  test('SyncTimeoutError → "Couldn\'t load document" + doc name in summary', () => {
    const copy = errorCopy(new SyncTimeoutError('docs/guide', 30_000));
    expect(copy.title).toBe("Couldn't load document");
    expect(copy.summary).toContain('docs/guide');
    expect(copy.summary).not.toMatch(/\bsync/i);
  });

  test('PreSyncDisconnectError → "Connection dropped" + doc name in summary', () => {
    const copy = errorCopy(new PreSyncDisconnectError('notes/idea'));
    expect(copy.title).toBe('Connection dropped');
    expect(copy.summary).toContain('notes/idea');
    expect(copy.summary).not.toMatch(/\bsync/i);
  });

  test('DocumentNotFoundError → "Document not found" + doc name in summary', () => {
    const copy = errorCopy(new DocumentNotFoundError('missing.md'));
    expect(copy.title).toBe('Document not found');
    expect(copy.summary).toContain('missing.md');
  });

  test('BridgeSetupError → "Couldn\'t open document" + doc name in summary', () => {
    const copy = errorCopy(new BridgeSetupError('docs/troubled', new Error('observer wiring')));
    expect(copy.title).toBe("Couldn't open document");
    expect(copy.summary).toContain('docs/troubled');
  });

  test('ServerCapabilityMismatchError → "Server can\'t open documents" + restart hint', () => {
    const copy = errorCopy(new ServerCapabilityMismatchError('docs/lost', 'ws'));
    expect(copy.title).toBe("Server can't open documents");
    expect(copy.summary).toMatch(/restart/i);
    expect(copy.summary).not.toMatch(/\bsync/i);
  });

  test('unknown Error subclass → "Unknown error" + surfaced message', () => {
    const copy = errorCopy(new Error('wss handshake rejected'));
    expect(copy.title).toBe('Unknown error');
    expect(copy.summary).toContain('wss handshake rejected');
  });

  test('Error without message → "Unknown error" + fallback summary', () => {
    const copy = errorCopy(new Error());
    expect(copy.title).toBe('Unknown error');
    expect(copy.summary).toMatch(/unexpected/i);
  });

  test('non-Error thrown value → "Unknown error" + fallback summary', () => {
    const copy = errorCopy('just a string');
    expect(copy.title).toBe('Unknown error');
    expect(copy.summary).toMatch(/unexpected/i);
  });

  test('null thrown → "Unknown error" + fallback summary', () => {
    const copy = errorCopy(null);
    expect(copy.title).toBe('Unknown error');
    expect(copy.summary).toMatch(/unexpected/i);
  });

  test('MountAbortError → "Cancelled" + user-action framing + doc name', () => {
    // Pin the user-facing copy for the explicit-cancel path. The user
    // clicked "Cancel" on the stalled-mount affordance — copy frames the
    // outcome as their action, not a system fault. Cache-driven invalidate
    // (LRU eviction, park/evict) is silent and never surfaces here.
    const copy = errorCopy(new MountAbortError('docs/abc'));
    expect(copy.title).toBe('Cancelled');
    expect(copy.summary).toContain('docs/abc');
    expect(copy.summary).toMatch(/cancelled/i);
  });
});

describe('isServerReachError (gates the "Restart server" affordance)', () => {
  test('reach failures → true (a fresh server can recover them)', () => {
    expect(isServerReachError(new SyncTimeoutError('docs/timeout', 30_000))).toBe(true);
    expect(isServerReachError(new PreSyncDisconnectError('docs/dropped'))).toBe(true);
  });

  test('non-reach errors → false (restart would not help)', () => {
    expect(isServerReachError(new DocumentNotFoundError('missing.md'))).toBe(false);
    expect(isServerReachError(new BridgeSetupError('docs/troubled', new Error('x')))).toBe(false);
    expect(isServerReachError(new ServerCapabilityMismatchError('docs/lost', 'ws'))).toBe(false);
    expect(isServerReachError(new MountAbortError('docs/abc'))).toBe(false);
    expect(isServerReachError(new Error('wss handshake rejected'))).toBe(false);
    expect(isServerReachError(null)).toBe(false);
  });
});

describe('errorDocName', () => {
  // The "Back to previous document" affordance reads `errorDocName(error) ??
  // activeDocName` — a regression that omits a typed error class from the
  // union below would silently invalidate the wrong syncPromise on back-nav
  // (cleared activeDocName instead of the errored target). Pin one row per
  // typed error so adding a new error class without updating the union
  // shows up here as a compile failure or a missing test.
  test('SyncTimeoutError → docName', () => {
    expect(errorDocName(new SyncTimeoutError('docs/timeout', 30_000))).toBe('docs/timeout');
  });

  test('PreSyncDisconnectError → docName', () => {
    expect(errorDocName(new PreSyncDisconnectError('docs/dropped'))).toBe('docs/dropped');
  });

  test('DocumentNotFoundError → docName', () => {
    expect(errorDocName(new DocumentNotFoundError('docs/missing'))).toBe('docs/missing');
  });

  test('BridgeSetupError → docName', () => {
    expect(errorDocName(new BridgeSetupError('docs/bridge', new Error('observer')))).toBe(
      'docs/bridge',
    );
  });

  test('ServerCapabilityMismatchError → docName', () => {
    expect(errorDocName(new ServerCapabilityMismatchError('docs/caps', 'ws'))).toBe('docs/caps');
  });

  test('MountAbortError → docName', () => {
    expect(errorDocName(new MountAbortError('docs/abort'))).toBe('docs/abort');
  });

  test('untyped Error → null', () => {
    expect(errorDocName(new Error('plain'))).toBeNull();
  });

  test('non-Error value → null', () => {
    expect(errorDocName('string-thrown')).toBeNull();
    expect(errorDocName(null)).toBeNull();
  });
});
