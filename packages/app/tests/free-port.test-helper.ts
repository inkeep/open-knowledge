import { type AddressInfo, createServer as createNetServer } from 'node:net';

/**
 * Pre-allocate a kernel-assigned free port on an explicit loopback family.
 *
 * Probe AND serve on the same explicit family. A bare `listen(0)`/`listen(port)`
 * binds dual-stack `::`, which succeeds on the v6 side even when an unrelated
 * long-lived process (an `ok ui` proxy, a dev server, a sibling parallel test
 * task) already holds 127.0.0.1:<same port> — and clients dialing `localhost`
 * coin-flip the address family, intermittently landing on the foreign v4
 * listener (observed as a collab-server-not-running 503 hijacking a test rig).
 * Probing and binding the same explicit family removes the race; callers must
 * dial the same loopback literal, never an ambiguous `localhost` URL.
 *
 * `127.0.0.1:p` and `[::1]:p` are independent kernel slots, so a port verified
 * free on one family carries no guarantee about the other — pass the family the
 * caller will actually bind.
 */
export async function getFreePort(
  loopbackHost: '127.0.0.1' | '::1' = '127.0.0.1',
): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, loopbackHost, () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}
