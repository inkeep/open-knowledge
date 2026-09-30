import { delimiter } from 'node:path';
import { expect, test, vi } from 'vitest';
import { observeChildren } from './auth-child-lifecycle.test-helper';
import { createControlledGh } from './gh-process-lifecycle.test-helper';
import { createTestServer, type TestServer } from './test-harness';

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const { guardAbsoluteGhLaunches } = await import('./gh-process-safety.test-helper');
  return guardAbsoluteGhLaunches(original);
});

test.skipIf(process.platform === 'win32')(
  'server shutdown drains its pending gh discovery child before returning',
  async () => {
    const fixture = await createControlledGh({ version: 'park', auth: 'park', lookup: 'park' });
    vi.stubEnv('PATH', `${fixture.dir}${delimiter}${process.env.PATH ?? ''}`);
    const observer = observeChildren([]);
    const controller = new AbortController();
    let server: TestServer | undefined;
    let destruction: Promise<void> | undefined;
    let request: Promise<{ status: number; body: string }> | undefined;
    try {
      server = await createTestServer();
      request = fetch(`${server.baseUrl}/api/local-op/auth/gh-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      })
        .then(async (response) => ({ status: response.status, body: await response.text() }))
        .catch(() => ({ status: 0, body: '' }));
      const connected = await fixture.next('version');
      const probe = observer.children.find(({ pid }) => pid === connected.pid);
      expect(probe?.child.spawnargs).toContain('--version');
      if (!probe) throw new Error('Pending version child was not observed');
      destruction = server.instance.destroy();
      const firstFinished = await Promise.race([
        probe.closed.then(() => 'probe closed'),
        destruction.then(() => 'server destroyed'),
      ]);
      expect(firstFinished).toBe('probe closed');
      await destruction;
      const response = await request;
      expect(response.status).toBe(503);
      expect(probe.child.exitCode !== null || probe.child.signalCode !== null).toBe(true);
    } finally {
      controller.abort();
      await fixture.cleanup();
      await request;
      await destruction;
      await Promise.all(observer.children.map(({ closed }) => closed));
      await server?.cleanup();
      observer.stop();
      vi.unstubAllEnvs();
    }
  },
);
