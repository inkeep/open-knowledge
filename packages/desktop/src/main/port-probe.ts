import { createServer } from 'node:net';
import { getLogger } from './desktop-logger.ts';

const log = getLogger('port-probe');

export function probeLoopbackPort(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(false);
  return new Promise<boolean>((resolve, reject) => {
    const server = createServer();
    let settled = false;
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        resolve(false);
        return;
      }
      log.warn({ port, code: err.code, err }, 'unexpected error probing loopback port');
      reject(err);
    });
    server.listen(port, '127.0.0.1', () => {
      if (settled) return;
      settled = true;
      server.close(() => resolve(true));
    });
  });
}
