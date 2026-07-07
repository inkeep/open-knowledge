/**
 * Test-only loopback listen helpers for HTTP rig boots.
 *
 * STOP: test rigs must bind a loopback-SPECIFIC address and dial exactly the
 * bound literal. A bare `listen(0)` binds the IPv6 wildcard `::`, whose
 * loopback-specific port slots (`127.0.0.1:p`, `[::1]:p`) stay silently
 * bindable by foreign processes — their listeners then intercept the rig's
 * `localhost` dials (most-specific bound socket wins), so assertions run
 * against a foreign server's response. Contract test:
 * rig-loopback-exclusivity.test.ts; source scan:
 * loopback-bind-discipline.test.ts.
 *
 * The host stays an inline `'127.0.0.1'` literal at each `.listen(` call in
 * THIS helper — a single IPv4 family, dialable as `http://127.0.0.1:${port}`
 * without bracketed-host URL handling. (Two Playwright fixtures in
 * packages/app/tests/stress deliberately run their dev servers on `[::1]`
 * instead — same loopback-specific discipline, different family; see the
 * rationale comments at those `--host ::1` spawn sites.)
 */

import type { Server } from 'node:http';
import { createServer } from 'node:http';

export interface LoopbackListenResult {
  port: number;
  /** Dial this (or URLs built from it) — never `http://localhost:${port}`. */
  baseUrl: string;
}

/**
 * Listen on an OS-assigned port bound specifically to `127.0.0.1` and
 * advertise the matching base URL. Preferred over getFreeLoopbackPort():
 * listen-first has no close-then-rebind window.
 */
export function listenOnLoopback(server: Server): Promise<LoopbackListenResult> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr !== 'object' || addr === null) {
        // Don't leave the caller's server listening (a leaked loopback
        // listener is the failure class these helpers exist to prevent), and
        // detach the listener so a later 'error' can't double-settle.
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

/**
 * Pre-allocate a free port on `127.0.0.1` for seams that need the port
 * before the real server exists. The caller's rebind MUST also pass
 * `'127.0.0.1'`: a foreign process grabbing the port inside the
 * close-then-rebind window then fails loudly as EADDRINUSE instead of
 * silently coexisting on a different specificity.
 */
export function getFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (typeof addr !== 'object' || addr === null) {
        // Close the still-listening probe before rejecting — a leaked
        // loopback listener is the failure class these helpers exist to
        // prevent.
        probe.removeListener('error', reject);
        probe.close(() =>
          reject(new Error('getFreeLoopbackPort: probe.address() returned no port')),
        );
        return;
      }
      const { port } = addr;
      probe.close(() => resolve(port));
    });
  });
}
