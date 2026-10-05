import { once } from 'node:events';
import { createServer } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { expect, test } from 'vitest';
import { closeTestHttpServer } from './http-server.test-helper.ts';
import { listenOnLoopback } from './loopback-rig-test-helpers.ts';

test('HTTP fixture teardown releases an active response connection', async () => {
  const server = createServer((_request, response) => {
    response.write('pending response');
  });
  const accepted = new Promise<Socket>((resolve) => server.once('connection', resolve));
  const { port } = await listenOnLoopback(server);
  const client = createConnection({ host: '127.0.0.1', port });
  let shutdown: Promise<void> | undefined;
  try {
    const received = once(client, 'data');
    client.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
    const connection = await accepted;
    await received;
    expect(connection.destroyed).toBe(false);

    shutdown = closeTestHttpServer(server);
    expect(connection.destroyed).toBe(true);
    await shutdown;
    expect(server.listening).toBe(false);
  } finally {
    client.destroy();
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await shutdown;
  }
});
