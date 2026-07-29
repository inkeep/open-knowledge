/**
 * The regression counters must be readable from OUTSIDE the process.
 *
 * `metrics.test.ts` asserts the counters in-process via `getMetrics()`, and the
 * `/api/metrics/reconciliation` envelope test only checks that `reconcileCount`
 * is a number. The response schema is `.loose()`, so a counter that was never
 * added to the serialized snapshot — or one dropped from it — still yields a
 * schema-valid 200 and an in-process test that keeps passing. The operability
 * claim ("poll one endpoint and know no protective mechanism has been firing")
 * lives entirely on fields nothing asserts over HTTP.
 *
 */

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { agentWriteMd, createTestServer, type TestServer } from './test-harness';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.cleanup();
  server = undefined;
});

/** Counters whose whole purpose is external readability. */
const REQUIRED_COUNTERS = [
  'deriveTimingDeferForceResolved',
  'reDeriveBackstopTripped',
  'reconcileCount',
] as const;

describe('GET /api/metrics/reconciliation exposes the regression counters', () => {
  test('the mechanism counters survive serialization and read zero on a healthy editing session', async () => {
    server = await createTestServer();
    const docName = `qa039-${randomUUID().slice(0, 8)}`;

    // A healthy session: an ordinary agent write, no mechanism staging.
    await agentWriteMd(server.port, '# Healthy\n\nordinary body\n', {
      docName,
      position: 'replace',
    });

    const res = await fetch(`http://127.0.0.1:${server.port}/api/metrics/reconciliation`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // Presence: a `.loose()` schema cannot catch a dropped counter, so name them.
    for (const counter of REQUIRED_COUNTERS) {
      expect(typeof body[counter]).toBe('number');
    }
    // Healthy run: no protective mechanism has fired.
    expect(body.deriveTimingDeferForceResolved).toBe(0);
    expect(body.reDeriveBackstopTripped).toBe(0);
  }, 30_000);
});
