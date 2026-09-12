import { setTimeout as wait } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  awaitConvergedServerText,
  createTestClient,
  createTestClients,
  createTestServer,
  getServerState,
  type TestServer,
} from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('awaitConvergedServerText', () => {
  test('stops waiting rather than returning bytes the client has not received', async () => {
    const client = await createTestClient(server.port, undefined, { syncControl: true });
    try {
      client.pauseSync();
      await agentWriteMd(server.port, 'held body\n', {
        docName: client.docName,
        position: 'replace',
      });

      const failure = await awaitConvergedServerText(server, client, {
        timeoutMs: 400,
        pollIntervalMs: 10,
      }).then(
        () => null,
        (error: Error) => error,
      );

      expect(failure?.message).toMatch(/did not converge/);
      expect(failure?.message).toContain('server Y.Text');
      expect(failure?.message).not.toContain('server has no document by that name');

      expect(getServerState(server, client.docName)?.ytext.toString()).toContain('held body');
      expect(client.ytext.toString()).not.toContain('held body');
    } finally {
      client.resumeSync();
      await client.cleanup();
    }
  });

  test('stops waiting when the client fragment edit has not reached the server', async () => {
    const client = await createTestClient(server.port, undefined, { syncControl: true });
    try {
      client.setDropOutbound(true);
      client.fragment.push([new Y.XmlElement('thematicBreak')]);

      await expect(
        awaitConvergedServerText(server, client, { timeoutMs: 400, pollIntervalMs: 10 }),
      ).rejects.toThrow(/did not converge/);

      expect(getServerState(server, client.docName)?.ytext.toString()).toBe('');
      expect(client.fragment.length).toBe(1);
    } finally {
      client.setDropOutbound(false);
      await client.cleanup();
    }
  });

  test('stops waiting when the client deletion has not reached the server', async () => {
    const client = await createTestClient(server.port, undefined, { syncControl: true });
    try {
      await agentWriteMd(server.port, 'alpha\n\nbravo\n', {
        docName: client.docName,
        position: 'replace',
      });
      const seeded = await awaitConvergedServerText(server, client);
      expect(seeded).toContain('alpha');

      client.setDropOutbound(true);
      client.doc.transact(() => {
        client.ytext.delete(0, 6);
      });
      expect(client.ytext.toString()).not.toContain('alpha');

      await expect(
        awaitConvergedServerText(server, client, { timeoutMs: 400, pollIntervalMs: 10 }),
      ).rejects.toThrow(/did not converge/);

      expect(getServerState(server, client.docName)?.ytext.toString()).toContain('alpha');
    } finally {
      client.setDropOutbound(false);
      await client.cleanup();
    }
  });

  test('stops waiting when a peer deletion has not reached the client', async () => {
    const [reader, deleter] = await createTestClients(server.port, {
      count: 2,
      perClientOptions: { syncControl: true },
    });
    try {
      await agentWriteMd(server.port, 'alpha\n\nbravo\n', {
        docName: reader.docName,
        position: 'replace',
      });
      expect(await awaitConvergedServerText(server, reader)).toContain('alpha');
      expect(await awaitConvergedServerText(server, deleter)).toContain('alpha');

      reader.pauseSync();
      deleter.doc.transact(() => {
        deleter.ytext.delete(0, 6);
      });
      await awaitConvergedServerText(server, deleter);

      await expect(
        awaitConvergedServerText(server, reader, { timeoutMs: 400, pollIntervalMs: 10 }),
      ).rejects.toThrow(/did not converge/);

      expect(reader.ytext.toString()).toContain('alpha');
    } finally {
      reader.resumeSync();
      await Promise.all([reader.cleanup(), deleter.cleanup()]);
    }
  });

  test('bounds the wait and names the doc when the client keeps writing', async () => {
    const client = await createTestClient(server.port, undefined, { syncControl: true });
    client.setDropOutbound(true);
    client.doc.transact(() => {
      client.ytext.insert(0, 'unsent');
    });
    const churn = setInterval(() => {
      client.doc.transact(() => {
        client.ytext.insert(0, '.');
      });
    }, 1);
    try {
      const startedAt = Date.now();
      const failure = await awaitConvergedServerText(server, client, {
        timeoutMs: 300,
        pollIntervalMs: 10,
      }).then(
        () => null,
        (error: Error) => error,
      );
      const elapsedMs = Date.now() - startedAt;

      expect(failure).not.toBeNull();
      expect(failure?.message).toMatch(/did not converge/);
      expect(failure?.message).toContain(client.docName);
      expect(failure?.message).toMatch(/client Y\.Text \([1-9]\d* chars\)/);
      expect(failure?.message).not.toContain('server has no document by that name');
      expect(elapsedMs).toBeLessThan(1_000);
    } finally {
      clearInterval(churn);
      client.setDropOutbound(false);
      await client.cleanup();
    }
  });

  test('compares once before consulting the clock, so a zero budget still resolves', async () => {
    const client = await createTestClient(server.port, undefined, { syncControl: true });
    try {
      await agentWriteMd(server.port, 'zero budget body\n', {
        docName: client.docName,
        position: 'replace',
      });
      await awaitConvergedServerText(server, client);

      const converged = await awaitConvergedServerText(server, client, { timeoutMs: 0 });
      expect(converged).toContain('zero budget body');
      expect(client.ytext.toString()).toBe(converged);

      client.pauseSync();
      await agentWriteMd(server.port, 'held past the zero budget\n', {
        docName: client.docName,
        position: 'replace',
      });

      const failure = await awaitConvergedServerText(server, client, { timeoutMs: 0 }).then(
        () => null,
        (error: Error) => error,
      );
      expect(failure?.message).toMatch(/did not converge/);
      expect(failure?.message).toContain('held past the zero budget');
      expect(failure?.message).not.toContain('server has no document by that name');
    } finally {
      client.resumeSync();
      await client.cleanup();
    }
  });

  test('spends only the remaining budget on the final sleep, not a whole cadence', async () => {
    const client = await createTestClient(server.port, undefined, { syncControl: true });
    try {
      client.pauseSync();
      await agentWriteMd(server.port, 'cadence larger than budget\n', {
        docName: client.docName,
        position: 'replace',
      });

      const startedAt = Date.now();
      const failure = await awaitConvergedServerText(server, client, {
        timeoutMs: 120,
        pollIntervalMs: 1_000,
      }).then(
        () => null,
        (error: Error) => error,
      );
      const elapsedMs = Date.now() - startedAt;

      expect(failure?.message).toMatch(/did not converge within 120 ms/);
      expect(elapsedMs).toBeLessThan(600);
    } finally {
      client.resumeSync();
      await client.cleanup();
    }
  });

  test('polls at the cadence rather than sleeping the budget in one go', async () => {
    const client = await createTestClient(server.port, undefined, { syncControl: true });
    try {
      client.pauseSync();
      await agentWriteMd(server.port, 'cadence smaller than budget\n', {
        docName: client.docName,
        position: 'replace',
      });

      const startedAt = Date.now();
      const pending = awaitConvergedServerText(server, client, {
        timeoutMs: 2_000,
        pollIntervalMs: 20,
      });
      const stillWaiting = await Promise.race([
        pending.then(() => 'resolved' as const),
        wait(100).then(() => 'pending' as const),
      ]);
      expect(stillWaiting).toBe('pending');

      client.resumeSync();

      const converged = await pending;
      const elapsedMs = Date.now() - startedAt;

      expect(converged).toContain('cadence smaller than budget');
      expect(client.ytext.toString()).toBe(converged);
      expect(elapsedMs).toBeLessThan(1_000);
    } finally {
      client.resumeSync();
      await client.cleanup();
    }
  });

  test('keeps waiting while the server update is held, then returns the converged bytes', async () => {
    const client = await createTestClient(server.port, undefined, { syncControl: true });
    try {
      client.pauseSync();
      await agentWriteMd(server.port, 'late body\n', {
        docName: client.docName,
        position: 'replace',
      });

      const pending = awaitConvergedServerText(server, client, {
        timeoutMs: 5_000,
        pollIntervalMs: 10,
      });
      const stillWaiting = await Promise.race([
        pending.then(() => 'resolved' as const),
        wait(100).then(() => 'pending' as const),
      ]);
      expect(stillWaiting).toBe('pending');

      client.resumeSync();

      const converged = await pending;
      expect(converged).toContain('late body');
      expect(client.ytext.toString()).toBe(converged);
      expect(getServerState(server, client.docName)?.ytext.toString()).toBe(converged);
    } finally {
      await client.cleanup();
    }
  });

  test('resolves the two-hop fragment chain with the server-derived bytes', async () => {
    const client = await createTestClient(server.port);
    try {
      expect(client.ytext.toString()).toBe('');
      client.fragment.push([new Y.XmlElement('thematicBreak')]);

      const converged = await awaitConvergedServerText(server, client, { timeoutMs: 10_000 });

      expect(converged).toContain('---');
      expect(client.ytext.toString()).toBe(converged);
      expect(getServerState(server, client.docName)?.ytext.toString()).toBe(converged);
    } finally {
      await client.cleanup();
    }
  });
});
