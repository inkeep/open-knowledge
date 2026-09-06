/**
 * Loopback origins whose connections are always refused by the kernel.
 *
 * A client pointed here gets a REAL transport failure rather than a hand-built
 * `Error`: nothing listens, so `fetch` rejects with a genuine undici
 * `TypeError: fetch failed` wrapping `Error { code: 'ECONNREFUSED', syscall:
 * 'connect' }`, and it never leaves the machine.
 *
 * Two constraints fix the port numbers, both pinned by `no-net-connect.test.ts`:
 *
 *  - Below every platform's ephemeral range (Linux 32768-60999, macOS and Windows
 *    49152-65535), so `listen(0)` can never hand one out. Bind-then-close returns
 *    the port to that pool, leaving a window for a concurrent test to re-bind it
 *    and turn the expected refusal into a connection.
 *  - Not on the WHATWG fetch blocked-port list. Port 1 is, and fails quietly
 *    rather than loudly: fetch rejects before any syscall with
 *    `cause: Error('bad port')`, which carries no `code`, so an errno assertion
 *    reads `undefined` instead of `ECONNREFUSED`.
 *
 * The ALT origin exists so a test can tell two hosts apart: a "names the host it
 * actually tried" assertion stops discriminating once both candidates collapse
 * onto one origin. Both origins are held to both constraints by the same
 * parametrized tests, so neither can rot into the other's shape.
 */
export const REFUSED_LOOPBACK_ORIGIN = 'http://127.0.0.1:4';

export const REFUSED_LOOPBACK_ORIGIN_ALT = 'http://127.0.0.1:5';
