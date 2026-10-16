import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { agentWriteMd, createTestServer, type TestServer } from './test-harness';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.cleanup();
  server = undefined;
});

const REQUIRED_COUNTERS = [
  'deriveTimingDeferForceResolved',
  'reDeriveBackstopTripped',
  'reconcileCount',
] as const;

describe('GET /api/metrics/reconciliation exposes the regression counters', () => {
  test('the mechanism counters survive serialization and read zero on a healthy editing session', async () => {
    server = await createTestServer();
    const docName = `qa039-${randomUUID().slice(0, 8)}`;

    await agentWriteMd(server.port, '# Healthy\n\nordinary body\n', {
      docName,
      position: 'replace',
    });

    const res = await fetch(`http://127.0.0.1:${server.port}/api/metrics/reconciliation`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    for (const counter of REQUIRED_COUNTERS) {
      expect(typeof body[counter]).toBe('number');
    }
    expect(body.deriveTimingDeferForceResolved).toBe(0);
    expect(body.reDeriveBackstopTripped).toBe(0);
  }, 30_000);
});
