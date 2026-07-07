/**
 * Loopback-address predicate for gating host-shape endpoints.
 *
 * Node sets `req.socket.remoteAddress` to the peer's address as a string. For
 * connections that arrived via loopback it's one of the four shapes —
 * anything else (LAN, public, or a misconfigured proxy) is refused by callers
 * that MUST NOT disclose the host (e.g. `GET /api/workspace` discloses the
 * absolute filesystem path, which is local-editing-only data).
 *
 * Accepts:
 *   - `127.0.0.1`                 classic IPv4 loopback
 *   - `127.X.Y.Z`                 anywhere in the `127.0.0.0/8` block (Linux
 *                                 does hand out non-.0.0.1 loopback addresses
 *                                 when apps open them explicitly)
 *   - `::1`                       IPv6 loopback
 *   - `::ffff:127.X.Y.Z`          IPv4-mapped IPv6 loopback block (dual-stack
 *                                 sockets on Linux/macOS represent 127.0.0.0/8
 *                                 this way when the listener is `::` instead
 *                                 of `0.0.0.0`; parity with the pure-IPv4
 *                                 branch so a non-.0.0.1 loopback address that
 *                                 happens to reach us via a dual-stack socket
 *                                 is accepted the same way as over v4)
 *
 * Rejects: undefined (socket already closed — treat as untrusted), every
 * public/private-LAN v4 address, every v6 address outside `::1`, and any
 * IPv4-mapped v6 address that isn't loopback (e.g. `::ffff:192.168.1.5`).
 */
export function isLoopbackAddress(remote: string | undefined): boolean {
  if (!remote) return false;
  if (remote === '::1') return true;
  // IPv4-mapped IPv6 loopback block — mirrors the pure-IPv4 branch.
  // The trailing `.` in the prefix defeats edge strings like `::ffff:127` or
  // `::ffff:1270.0.0.1` that could otherwise match a bare-prefix check.
  if (remote.startsWith('::ffff:127.')) return true;
  // IPv4 loopback block (127.0.0.0/8). `startsWith('127.')` is sufficient —
  // string peers never contain arbitrary trailing garbage under Node's parser.
  if (remote.startsWith('127.')) return true;
  return false;
}

/**
 * DNS-rebinding defense for loopback-only endpoints.
 *
 * `req.socket.remoteAddress === 127.0.0.1` is trivially satisfied by any
 * request that reaches the socket via loopback — including requests from a
 * malicious page whose hostname was rebound to `127.0.0.1` after the browser
 * fetched the attacker's JS. In that case the TCP peer is still loopback, but
 * the `Host` header names the attacker's domain. The fix is to additionally
 * verify that the caller actually spoke to us via a loopback hostname: the
 * Host header must be one of `localhost[:port]`, `127.X.Y.Z[:port]`, or
 * `[::1][:port]`. This matches the canonical mitigation from the Ethereum /
 * geth JSON-RPC incident and the OWASP DNS-Rebinding playbook.
 *
 * Accepts:
 *   - `localhost` or `localhost:<port>`
 *   - `127.X.Y.Z` or `127.X.Y.Z:<port>` (the entire 127.0.0.0/8 loopback block)
 *   - `[::1]` or `[::1]:<port>` (IPv6 loopback, always bracketed in Host)
 *
 * Rejects: missing header, any other hostname, bare `::1` without brackets
 * (not a valid Host production under RFC 7230), and anything that doesn't
 * cleanly parse as host[:port].
 */
export function isAllowedWorkspaceHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  // Strip an optional trailing `:port` — hostnames never contain `:` except
  // in the IPv6-bracketed form which we handle explicitly.
  if (host.startsWith('[')) {
    // IPv6 literal: `[::1]` or `[::1]:port`. Everything before the closing
    // bracket is the host; whatever follows must be empty or `:<digits>`.
    const close = host.indexOf(']');
    if (close < 0) return false;
    const inner = host.slice(1, close);
    const trailing = host.slice(close + 1);
    if (trailing !== '' && !/^:\d+$/.test(trailing)) return false;
    return inner === '::1';
  }
  const colon = host.lastIndexOf(':');
  const hostname = colon >= 0 ? host.slice(0, colon) : host;
  const portPart = colon >= 0 ? host.slice(colon + 1) : null;
  // When a port separator is present, the port MUST be a non-empty digit run.
  // `localhost:` and `127.0.0.1:` are rejected; bare `localhost` (no colon) is
  // the only port-less shape that passes.
  if (portPart !== null && !/^\d+$/.test(portPart)) return false;
  if (hostname === 'localhost') return true;
  // IPv4 loopback block (127.0.0.0/8). Mirrors isLoopbackAddress — Node's
  // string parsing of Host never yields arbitrary trailing garbage after the
  // IP octets.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  return false;
}
