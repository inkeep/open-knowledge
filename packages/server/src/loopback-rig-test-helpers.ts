import type { Server } from 'node:http';

export interface LoopbackListenResult {
  port: number;
  baseUrl: string;
}

export function listenOnLoopback(server: Server): Promise<LoopbackListenResult> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr !== 'object' || addr === null) {
        server.removeListener('error', reject);
        server.close(() =>
          reject(new Error('listenOnLoopback: server.address() returned no port')),
        );
        return;
      }
      server.removeListener('error', reject);
      resolve({ port: addr.port, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}
