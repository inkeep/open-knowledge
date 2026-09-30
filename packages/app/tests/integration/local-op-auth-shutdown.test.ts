import { constants, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { createControlledAuthCli, observeChildren } from './auth-child-lifecycle.test-helper';
import { createTestServer, type TestServer } from './test-harness';

async function openLogin(
  server: TestServer,
  channel: string,
  controller: AbortController,
  expectedStatus = 200,
) {
  const response = await fetch(`${server.baseUrl}/api/local-op/auth/${channel}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: controller.signal,
  });
  expect(response.status).toBe(expectedStatus);
  if (expectedStatus !== 200) {
    await response.text();
    return;
  }
  if (!response.body) throw new Error('Missing auth stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('Auth stream ended before verification');
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines.filter(Boolean)) {
        if (JSON.parse(line).type === 'verification') return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

describe.each(['login', 'gh-login'])('auth shutdown: %s', (channel) => {
  test.each(['active', 'detached', 'cancelled', 'displaced', 'failed test', 'shutdown admission'])(
    'server destruction reaps every owned child after %s',
    async (scenario) => {
      const fixture = await createControlledAuthCli();
      const binDir = mkdtempSync(join(tmpdir(), 'ok-auth-bin-'));
      copyFileSync(
        process.execPath,
        join(binDir, process.platform === 'win32' ? 'gh.exe' : 'gh'),
        constants.COPYFILE_FICLONE,
      );
      vi.stubEnv('PATH', `${binDir}${delimiter}${process.env.PATH ?? ''}`);
      const observer = observeChildren(channel === 'login' ? fixture.cliArgs : ['gh', 'auth']);
      const controllers: AbortController[] = [];
      let server: TestServer | undefined;
      const forcedFailure = new Error('controlled test failure');
      let caught: unknown;
      try {
        server = await createTestServer({ localOpCliArgs: fixture.cliArgs });
        writeFileSync(join(server.contentDir, 'auth'), fixture.script);
        try {
          const first = new AbortController();
          controllers.push(first);
          if (scenario === 'shutdown admission') await server.instance.destroy();
          await openLogin(server, channel, first, scenario === 'shutdown admission' ? 503 : 200);
          expect(observer.children).toHaveLength(scenario === 'shutdown admission' ? 0 : 1);
          if (scenario === 'detached') first.abort();
          if (scenario === 'cancelled') {
            const response = await fetch(`${server.baseUrl}/api/local-op/auth/cancel`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ channel }),
            });
            expect(response.status).toBe(200);
            await response.text();
          }
          if (scenario === 'displaced') {
            const second = new AbortController();
            controllers.push(second);
            await openLogin(server, channel, second);
            expect(observer.children).toHaveLength(2);
          }
          if (scenario === 'failed test') throw forcedFailure;
        } catch (error) {
          if (error !== forcedFailure) throw error;
          caught = error;
        } finally {
          await server.instance.destroy();
        }
        expect(caught).toBe(scenario === 'failed test' ? forcedFailure : undefined);
        expect(observer.runningPids()).toEqual([]);
      } finally {
        for (const controller of controllers) controller.abort();
        await fixture.release();
        await Promise.all(observer.children.map(({ closed }) => closed));
        await server?.cleanup();
        observer.stop();
        vi.unstubAllEnvs();
        rmSync(binDir, { recursive: true, force: true });
      }
    },
  );
});
