import { lockBaseUrl } from '@inkeep/open-knowledge-server';
import { describe, expect, test } from 'vitest';
import {
  collabUrlFromApiOrigin,
  lockApiOrigin,
  lockCollabUrl,
} from '../../src/main/window-manager';

const DIALABLE_MATRIX: Array<{ label: string; lock: { port: number; url?: string } }> = [
  { label: 'port fallback (no url)', lock: { port: 4123 } },
  { label: 'url preferred over port', lock: { port: 4123, url: 'http://127.0.0.1:9999' } },
  { label: 'localhost url', lock: { port: 4123, url: 'http://localhost:9999' } },
  { label: 'trailing slash normalized', lock: { port: 4123, url: 'http://localhost:9999/' } },
  {
    label: 'stray path normalized to origin',
    lock: { port: 4123, url: 'http://127.0.0.1:9999/x' },
  },
  { label: 'https loopback accepted', lock: { port: 4123, url: 'https://127.0.0.1:9999' } },
  { label: 'ipv6 loopback accepted', lock: { port: 4123, url: 'http://[::1]:9999' } },
  { label: 'corrupt url falls back to port', lock: { port: 4123, url: 'not a url' } },
  {
    label: 'non-loopback host rejected',
    lock: { port: 4123, url: 'http://evil.example.com:9999' },
  },
  { label: 'private-network host rejected', lock: { port: 4123, url: 'http://10.0.0.1:9999' } },
  { label: 'non-http scheme rejected', lock: { port: 4123, url: 'ftp://127.0.0.1:9999' } },
];

describe('lockApiOrigin parity with the canonical lockBaseUrl', () => {
  test.each(DIALABLE_MATRIX)('$label', ({ lock }) => {
    expect(lockApiOrigin(lock)).toBe(lockBaseUrl(lock) ?? `http://localhost:${lock.port}`);
  });

  test('port-0 divergence is deliberate: desktop returns a string, canonical returns null', () => {
    expect(lockBaseUrl({ port: 0 })).toBeNull();
    expect(lockApiOrigin({ port: 0 })).toBe('http://localhost:0');
  });

  test('collab URL rides the same validated origin', () => {
    expect(lockCollabUrl({ port: 4123, url: 'http://127.0.0.1:9999' })).toBe(
      'ws://127.0.0.1:9999/collab',
    );
    expect(lockCollabUrl({ port: 4123, url: 'http://evil.example.com:9999' })).toBe(
      'ws://localhost:4123/collab',
    );
    expect(lockCollabUrl({ port: 4123, url: 'https://127.0.0.1:9999' })).toBe(
      'wss://127.0.0.1:9999/collab',
    );
  });

  test('an apiOrigin-string consumer derives the same collab URL as the lock-shaped helper', () => {
    const lock = { port: 4123, url: 'https://[::1]:9999' };
    expect(collabUrlFromApiOrigin(lockApiOrigin(lock))).toBe(lockCollabUrl(lock));
    expect(collabUrlFromApiOrigin('http://[::1]:9999')).toBe('ws://[::1]:9999/collab');
  });
});
