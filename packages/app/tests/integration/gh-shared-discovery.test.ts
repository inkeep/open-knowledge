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
  'destroying one server preserves pending gh discovery and sign-in for another server',
  async () => {
    const fixture = await createControlledGh({ version: 'park', auth: 'park', lookup: 'park' });
    vi.stubEnv('PATH', `${fixture.dir}${delimiter}${process.env.PATH ?? ''}`);
    const observer = observeChildren([]);
    const controllers: AbortController[] = [];
    let firstServer: TestServer | undefined;
    let secondServer: TestServer | undefined;
    let firstRequest: Promise<{ status: number; body: string }> | undefined;
    let statusRequest: Promise<{ status: number; body: { ghAvailable?: boolean } }> | undefined;
    try {
      const statusCli = [
        process.execPath,
        '-e',
        `const socket = require('node:net').connect(${fixture.port}, '127.0.0.1', () => {
        socket.write(JSON.stringify({ phase: 'status', event: 'connected', pid: process.pid }) + '\\n', () => {
          process.stdout.write(JSON.stringify({ authenticated: false }) + '\\n', () => socket.end(() => process.exit(0)));
        });
      });`,
      ];
      firstServer = await createTestServer();
      secondServer = await createTestServer({ localOpCliArgs: statusCli });
      const firstController = new AbortController();
      controllers.push(firstController);
      firstRequest = fetch(`${firstServer.baseUrl}/api/local-op/auth/gh-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: firstController.signal,
      })
        .then(async (response) => ({ status: response.status, body: await response.text() }))
        .catch(() => ({ status: 0, body: '' }));
      const version = await fixture.next('version');
      const probe = observer.children.find(({ pid }) => pid === version.pid);
      expect(probe?.child.spawnargs).toContain('--version');
      if (!probe) throw new Error('Shared version child was not observed');

      const statusController = new AbortController();
      controllers.push(statusController);
      statusRequest = fetch(`${secondServer.baseUrl}/api/local-op/auth/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: statusController.signal,
      })
        .then(async (response) => ({
          status: response.status,
          body: (await response.json()) as { ghAvailable?: boolean },
        }))
        .catch(() => ({ status: 0, body: {} }));
      const status = await fixture.next('status');
      const statusChild = observer.children.find(({ pid }) => pid === status.pid);
      expect(statusChild).toBeDefined();
      if (!statusChild) throw new Error('Second-server status child was not observed');
      await statusChild.closed;
      await Promise.resolve();

      await firstServer.instance.destroy();
      fixture.release('version');
      await probe.closed;
      const [firstResponse, statusResponse] = await Promise.all([firstRequest, statusRequest]);
      expect(firstResponse.status).toBe(503);
      expect(statusResponse.status).toBe(200);
      expect(statusResponse.body.ghAvailable).toBe(true);
      const loginController = new AbortController();
      controllers.push(loginController);
      const loginResponse = await fetch(`${secondServer.baseUrl}/api/local-op/auth/gh-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: loginController.signal,
      });
      expect(loginResponse.status).toBe(200);
      if (!loginResponse.body) throw new Error('Missing second-server gh auth stream');
      const reader = loginResponse.body.getReader();
      try {
        let stream = '';
        while (!stream.includes('"type":"verification"')) {
          const { done, value } = await reader.read();
          if (done) throw new Error('Second-server gh auth stream ended before verification');
          stream += new TextDecoder().decode(value);
        }
        const auth = await fixture.next('auth');
        const authChild = observer.children.find(({ pid }) => pid === auth.pid);
        expect(authChild).toBeDefined();
        if (!authChild) throw new Error('Second-server auth child was not observed');
        await secondServer.instance.destroy();
        await authChild.closed;
        expect(authChild.child.exitCode !== null || authChild.child.signalCode !== null).toBe(true);
      } finally {
        reader.releaseLock();
      }
    } finally {
      for (const controller of controllers) controller.abort();
      await fixture.cleanup();
      await Promise.all([firstRequest, statusRequest]);
      await Promise.all(observer.children.map(({ closed }) => closed));
      await Promise.all([firstServer?.cleanup(), secondServer?.cleanup()]);
      observer.stop();
      vi.unstubAllEnvs();
    }
  },
);
