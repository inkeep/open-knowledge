import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createRestartableServer } from './restartable-server.test-helper.ts';

test('the server process exits when its owning IPC channel closes without losing a persisted doc', async () => {
  const server = await createRestartableServer();
  try {
    const write = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        docName: 'test-doc',
        markdown: 'Owned paragraph\n',
        position: 'replace',
        agentId: 'owner',
      }),
    });
    expect(write.status).toBe(200);
    expect(readFileSync(join(server.contentDir, 'test-doc.md'), 'utf8')).toBe('Owned paragraph\n');
    server.disconnectOwner();
    expect(await server.exited).toEqual({ code: 1, signal: null });
    expect(readFileSync(join(server.contentDir, 'test-doc.md'), 'utf8')).toBe('Owned paragraph\n');
  } finally {
    await expect(server.shutdown()).rejects.toThrow(/shutdown failed/);
  }
}, 30_000);

test('process crash releases ownership only after exit and replacement uses a fresh epoch', async () => {
  let server = await createRestartableServer();
  const initial = server;
  try {
    await expect(createRestartableServer({ contentDir: initial.contentDir })).rejects.toThrow(
      /already running|content ownership is already held/,
    );
    const info = await fetch(`http://127.0.0.1:${initial.port}/api/server-info`);
    expect((await info.json()).serverInstanceId).toBe(initial.serverInstanceId);
    server = await initial.killAndRestartOnSamePort({ downtimeMs: 0 });
    expect(await initial.exited).toEqual({ code: null, signal: 'SIGKILL' });
    expect(server.pid).not.toBe(initial.pid);
    expect(server.serverInstanceId).not.toBe(initial.serverInstanceId);
    const write = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        docName: 'test-doc',
        markdown: 'Replacement owner\n',
        position: 'replace',
        agentId: 'replacement-owner',
      }),
    });
    expect(write.status).toBe(200);
    expect(readFileSync(join(server.contentDir, 'test-doc.md'), 'utf8')).toBe(
      'Replacement owner\n',
    );
  } finally {
    await server.shutdown();
    await initial.shutdown();
  }
}, 30_000);
