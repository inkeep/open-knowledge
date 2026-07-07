import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { clientVersionHeaders } from '@inkeep/open-knowledge-core';
import * as Y from 'yjs';
import { buildAuthToken } from '../../src/lib/auth-token';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer, waitForSync } from './test-harness';

// A current, read-blind server must accept every instrumented client
// unchanged: it never reads the version metadata, so the extra HTTP headers and
// auth-token fields are inert. We exercise both instrumented transports against
// a real server booted by the harness.
describe('read-blind server accepts instrumented clients', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  }, HARNESS_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await server.cleanup();
  });

  test('HTTP: /api/server-info with x-ok-client-* headers returns 2xx', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/server-info`, {
      headers: clientVersionHeaders({ kind: 'cli', runtimeVersion: '9.9.9-test' }),
    });
    expect(res.ok).toBe(true);
    await res.json();
  });

  test('Hocuspocus WS: auth succeeds with a version-bearing token', async () => {
    const doc = new Y.Doc();
    let authFailed = false;
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${server.port}/collab`,
      name: `test-${crypto.randomUUID()}`,
      document: doc,
      // Anonymous tab: token now always present (carries version fields).
      token: buildAuthToken(null, null),
      connect: true,
    });
    provider.on('authenticationFailed', () => {
      authFailed = true;
    });
    try {
      await waitForSync(provider);
      expect(authFailed).toBe(false);
      expect(provider.isAuthenticated).toBe(true);
    } finally {
      provider.destroy();
      doc.destroy();
    }
  });
});
