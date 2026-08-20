/**
 * Advisory loopback port availability probe for the Remote control pane.
 *
 * The pane pins a fixed `server.port` so a tunnel's target stays stable across
 * restarts. If that port is already held (another OK instance, another project,
 * any process), boot silently falls back to an ephemeral port and the tunnel
 * target no longer matches. Probing BEFORE Apply lets the pane tell the user
 * "that port is taken — pick another" while they type, instead of after a
 * confusing restart.
 *
 * Best-effort and advisory: there is a TOCTOU gap between this probe and the
 * real bind, so a "free" result is a strong hint, not a guarantee. The server
 * binds loopback (the tunnel forwards to it), so loopback is the surface to test.
 */
import { createServer } from 'node:net';
import { getLogger } from './desktop-logger.ts';

const log = getLogger('port-probe');

/**
 * Resolve `true` when `port` can be bound on `127.0.0.1` right now, `false` when
 * it is in use (EADDRINUSE/EACCES) or out of the valid `1..65535` range. Never
 * REJECTS for a genuinely-unavailable port (EADDRINUSE/EACCES) or an
 * out-of-range input. It REJECTS on an unexpected system error (ENOMEM, ENOBUFS,
 * ...) so the caller fails open (treats it as "can't confirm", not "in use")
 * instead of falsely flagging every port as taken on a resource-starved machine.
 */
export function probeLoopbackPort(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(false);
  return new Promise<boolean>((resolve, reject) => {
    const server = createServer();
    let settled = false;
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      // The listen never opened a handle, so there is nothing to close.
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
      // Close our own handle before resolving so the port stays bindable.
      server.close(() => resolve(true));
    });
  });
}
