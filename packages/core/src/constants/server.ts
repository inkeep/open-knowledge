/**
 * Default bind host for `ok start`. Overridable at runtime via the
 * `--host` CLI flag or the `HOST` environment variable; resolved at
 * the start command, not via config.
 *
 * Numeric IPv4 loopback — NOT the `localhost` hostname — on purpose. On
 * Windows, `getaddrinfo('localhost')` returns `::1` first, so
 * `httpServer.listen(port, 'localhost')` binds IPv6 loopback ONLY, while
 * Node's `fetch`/undici clients resolve `localhost` to `127.0.0.1` and get
 * ECONNREFUSED — the MCP-autostarted server was unreachable on Windows. A
 * numeric address skips DNS resolution, so the bind family is identical on
 * every platform and matches the `http://127.0.0.1:<port>` clients already
 * hardcoded in `sync` / `embeddings` / `diagnose`. Still loopback-only, so
 * the DNS-rebinding / origin checks are unaffected.
 */
export const DEFAULT_SERVER_HOST = '127.0.0.1';
