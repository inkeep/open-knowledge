
import { describe, expect, test } from 'bun:test';
import { MountAbortError } from '@/editor/mount-promise';
import {
  BridgeSetupError,
  DocumentNotFoundError,
  PreSyncDisconnectError,
  ServerCapabilityMismatchError,
  SyncTimeoutError,
} from '@/editor/sync-promise';
import { errorCopy, errorDocName } from './DocumentErrorBoundary';

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
    const copy = errorCopy(new MountAbortError('docs/abc'));
    expect(copy.title).toBe('Cancelled');
    expect(copy.summary).toContain('docs/abc');
    expect(copy.summary).toMatch(/cancelled/i);
  });
});

describe('errorDocName', () => {
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
