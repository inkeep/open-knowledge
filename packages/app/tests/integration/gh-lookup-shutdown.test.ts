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
  'server shutdown terminates the pending gh username lookup without completing sign-in',
  async () => {
    const fixture = await createControlledGh({
      version: 'complete',
      auth: 'complete',
      lookup: 'park',
    });
    vi.stubEnv('PATH', `${fixture.dir}${delimiter}${process.env.PATH ?? ''}`);
    const observer = observeChildren(['gh']);
    const controller = new AbortController();
    let server: TestServer | undefined;
    let destruction: Promise<void> | undefined;
    try {
      server = await createTestServer();
      const response = await fetch(`${server.baseUrl}/api/local-op/auth/gh-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      if (!response.body) throw new Error('Missing gh auth stream');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let stream = '';
      try {
        while (!stream.includes('"type":"verification"')) {
          const { done, value } = await reader.read();
          if (done) throw new Error('gh auth stream ended before verification');
          stream += decoder.decode(value, { stream: true });
        }
        await fixture.next('lookup');
        const lookup = observer.children.find(({ child }) => child.spawnargs[1] === 'api');
        expect(lookup).toBeDefined();
        if (!lookup) throw new Error('Pending lookup child was not observed');
        const termination = vi.spyOn(lookup.child, 'kill');
        destruction = server.instance.destroy();
        await Promise.resolve();
        const lookupWasTerminated = termination.mock.calls.length > 0;
        const firstFinished = Promise.race([
          lookup.closed.then(() => 'lookup closed'),
          destruction.then(() => 'server destroyed'),
        ]);
        fixture.release('lookup');
        expect(await firstFinished).toBe('lookup closed');
        await Promise.all([destruction, lookup.closed]);
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          stream += decoder.decode(value, { stream: true });
        }
        const events = stream
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { type?: string });
        expect(events.map((event) => event.type)).toContain('verification');
        expect({
          lookupWasTerminated,
          completed: events.some((event) => event.type === 'complete'),
        }).toEqual({
          lookupWasTerminated: true,
          completed: false,
        });
      } finally {
        reader.releaseLock();
      }
    } finally {
      controller.abort();
      await fixture.cleanup();
      await Promise.all(observer.children.map(({ closed }) => closed));
      await destruction;
      await server?.cleanup();
      observer.stop();
      vi.unstubAllEnvs();
    }
  },
);
