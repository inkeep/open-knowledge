/**
 * Hermetic-test guard: rejects `fetch` to anything that is not loopback.
 *
 * A unit test whose pass/fail depends on a socket to the outside world inherits
 * the resolver, the proxy, and a remote host's availability. This makes that class
 * refuse before it leaves the process, naming the test that made the request.
 *
 * Loopback stays reachable deliberately: suites here stand up real servers on
 * 127.0.0.1 and talk to them, which never leaves the machine. A CLOSED loopback
 * port is the sanctioned way to get a REAL transport error without inventing one
 * (see `refused-loopback.test-helper.ts`).
 *
 * A clean run emits ZERO `[no-net-connect]` lines; the guard's own suite mutes its
 * deliberate blocks to keep that literally true. A guard that fires routinely is a
 * broken alarm, so a line in CI output is a new reach to fix at its seam.
 *
 * WHAT THIS DOES NOT COVER, in rough order of how likely you are to hit it:
 *  - A test that assigns over `globalThis.fetch`. The guard is then inert in that
 *    file, for every host. This is the dominant idiom in this subtree, so the file
 *    you are editing may well have it switched off. Prefer a
 *    host-conditional pass-through to the captured real fetch, or a module-level
 *    fake, over a blanket replacement.
 *  - `node:http` / `node:https` directly. `packages/server/src/link-preview/
 *    guarded-fetch.ts` is shipping product code that does exactly this.
 *  - Raw `node:net` sockets, and jsdom's `XMLHttpRequest`.
 *  - Spawned subprocesses, which own their own globals: the CLI e2e tier
 *    (`packages/cli/vitest.e2e.config.ts`) tests a binary in another process.
 *
 * Prior art, and why this diverges: `msw` (`setupServer(...).listen({
 * onUnhandledRequest: 'error' })`) closes `node:http`, XHR and `fetch` in one
 * interceptor stack; `nock` and undici's `MockAgent` both offer
 * `disableNetConnect` / `enableNetConnect`, and `MockAgent` intercepts at the
 * dispatcher rather than by replacing a global. All three are request-mocking
 * frameworks; what is wanted here is a single allow-loopback-only policy on the one
 * surface this code fetches through, installed in every worker with no per-test
 * registration. Note also that none of them closes the first gap above: a
 * `globalThis.fetch` reassignment bypasses a dispatcher just as completely.
 *
 * There is deliberately no opt-out flag: an escape hatch would be re-openable by
 * the next test that finds the guard inconvenient.
 */
import { expect } from 'vitest';

const INSTALLED = Symbol.for('ok.test.noNetConnect.installed');

// Deliberately matches `isLoopbackBindAddress` in packages/core
// (src/config/resolve-server-config.ts): same hosts, same octet validation. The
// wildcards `0.0.0.0` and `::` are NOT loopback -- core classifies them that way,
// `loopback-bind-discipline.test.ts` treats binding them as a violation, and per
// Winsock the all-zeros destination is not even routable on Windows. `.localhost`
// is admitted on top of core's set: RFC 6761 reserves it to resolve to loopback,
// and this predicate answers about fetch targets rather than bind addresses.
// Both halves of that claim, the parity and the deliberate divergences, are
// enforced by `packages/core/src/config/loopback-parity.test.ts`, which lives
// beside `isLoopbackBindAddress` because that is where its dep graph already is.
const IPV4_OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const LOOPBACK_V4_RE = new RegExp(`^127\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}$`);

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

export function isLoopbackHostname(hostname: string): boolean {
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const lower = bare.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(lower)) return true;
  if (lower.endsWith('.localhost')) return true;
  return LOOPBACK_V4_RE.test(lower);
}

function resolveTarget(input: unknown): URL | null {
  const base =
    typeof globalThis.location?.href === 'string' ? globalThis.location.href : undefined;
  const raw =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : typeof (input as { url?: unknown })?.url === 'string'
          ? (input as { url: string }).url
          : null;
  if (raw === null) return null;
  try {
    return new URL(raw, base);
  } catch {
    return null;
  }
}

// data:/blob:/file: carry no host and open no socket, so a hostname test would
// refuse them for having an empty hostname rather than for going anywhere.
const SOCKETLESS_PROTOCOLS = new Set(['data:', 'blob:', 'file:']);

export class NetConnectBlockedError extends Error {
  override readonly name = 'NetConnectBlockedError' as const;
  constructor(hostname: string, testName: string) {
    super(
      `Blocked an outbound network request to "${hostname}" from test: ${testName}. ` +
        'Unit tests must be hermetic — only loopback hosts are reachable. Fake the ' +
        'dependency at its seam, or point it at a CLOSED loopback port when you need a ' +
        'real transport error. See test-support/no-net-connect.ts.',
    );
  }
}

export function installNoNetConnect(): void {
  const realFetch = globalThis.fetch;
  if (typeof realFetch !== 'function') return;
  // The marker lives on the wrapper rather than on `globalThis`, so a test that
  // replaced `fetch` without restoring it cannot make a later install believe the
  // guard is present when it is not (precedent: `client-fetch.ts`).
  if ((realFetch as { [INSTALLED]?: boolean })[INSTALLED] === true) return;

  const guardedFetch = async function guardedFetch(
    input: Parameters<typeof realFetch>[0],
    init?: Parameters<typeof realFetch>[1],
  ): ReturnType<typeof realFetch> {
    const target = resolveTarget(input);
    // An unresolvable target cannot reach the network either way: `fetch` rejects a
    // malformed or relative-without-base URL before opening a socket, so passing it
    // through surfaces its own error rather than masking it with the guard's.
    if (
      target !== null &&
      !SOCKETLESS_PROTOCOLS.has(target.protocol) &&
      !isLoopbackHostname(target.hostname)
    ) {
      const testName = expect.getState().currentTestName ?? '<outside a test>';
      const blocked = new NetConnectBlockedError(target.hostname, testName);
      // A caller that swallows transport errors (every defensive upload path does)
      // would otherwise turn this into a silently-wrong assertion rather than a
      // legible failure, which is the exact invisibility this guard exists to end.
      console.error(`[no-net-connect] ${blocked.message}`);
      throw blocked;
    }
    return realFetch(input, init);
  } as typeof realFetch;

  (guardedFetch as { [INSTALLED]?: boolean })[INSTALLED] = true;
  globalThis.fetch = guardedFetch;
}

installNoNetConnect();
