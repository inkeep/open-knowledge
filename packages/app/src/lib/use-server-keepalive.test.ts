import { describe, expect, test } from 'vitest';
import { keepaliveBaseFromCollabUrl } from './use-server-keepalive';

describe('keepaliveBaseFromCollabUrl', () => {
  test('returns undefined when collabUrl is unresolved', () => {
    expect(keepaliveBaseFromCollabUrl(null)).toBeUndefined();
    expect(keepaliveBaseFromCollabUrl('')).toBeUndefined();
  });

  test('strips the trailing /collab so the primitive can re-append /collab/keepalive', () => {
    expect(keepaliveBaseFromCollabUrl('ws://localhost:5173/collab')).toBe('ws://localhost:5173');
    expect(keepaliveBaseFromCollabUrl('wss://example.com/collab')).toBe('wss://example.com');
  });

  test('tolerates a trailing slash after /collab', () => {
    expect(keepaliveBaseFromCollabUrl('ws://localhost:5173/collab/')).toBe('ws://localhost:5173');
  });

  test('strips /collab from a port-less URL (defaultCollabWsUrl same-origin shape)', () => {
    expect(keepaliveBaseFromCollabUrl('ws://localhost/collab')).toBe('ws://localhost');
  });

  test('passes through a URL that does not end in /collab', () => {
    expect(keepaliveBaseFromCollabUrl('ws://host/other')).toBe('ws://host/other');
    expect(keepaliveBaseFromCollabUrl('ws://host/collab-service')).toBe('ws://host/collab-service');
  });

  test('the produced base re-composes to a single /collab/keepalive path', () => {
    const base = keepaliveBaseFromCollabUrl('ws://localhost:5173/collab');
    expect(`${base}/collab/keepalive`).toBe('ws://localhost:5173/collab/keepalive');
    expect(`${base}/collab/keepalive`).not.toContain('/collab/collab');
  });
});
