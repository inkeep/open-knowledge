/**
 * The single outbound-fetch chokepoint for link previews. Every remote request
 * — the page fetch, the favicon fetch, and every redirect hop — passes through
 * here so the SSRF guard cannot be bypassed.
 *
 * The transport is node:http/node:https `request()`, NOT `fetch`, because the
 * pin must behave identically on both runtimes this server runs under (Bun in
 * dev/CI, Node in the packaged desktop and the npm CLI). Bun's `fetch` accepts
 * a `tls.serverName` extension for SNI-preserving IP pins, but Node's `fetch`
 * silently ignores it, which turns the pinned HTTPS handshake into
 * SNI=IP-literal and fails certificate validation on every external target.
 * `request()` honors the same pinning options on both runtimes (verified
 * empirically on Node 22 and Bun 1.3).
 *
 * The guard is TOCTOU-safe by construction. A hostname is resolved once via
 * the injectable resolver and EVERY resolved address is validated as public
 * unicast (ip-classifier). The request then keeps the original hostname URL —
 * so SNI, certificate validation (a name mismatch rejects the fetch), and the
 * automatic `Host` header all run against the real name — while the socket is
 * pinned to the validated address through the request's `lookup` option, which
 * answers with ONLY that address. The runtime performs no second DNS lookup,
 * so there is no window in which a name could re-resolve to an internal
 * address between the check and the connect. (Both runtimes may call `lookup`
 * in the all-addresses form; the pin answers whichever form was requested.)
 * IP-literal hosts skip resolution and are classified directly (encoded forms
 * canonicalized first, and the request URL is rebuilt on the canonical literal
 * so the runtime dials it as an IP rather than resolving it as a name).
 *
 * Redirects are never auto-followed — `request()` returns the 3xx — and we
 * re-run the full scheme+resolve+validate admission on each hop's target,
 * bounded to a small hop count. Response reads are bounded on both time
 * (AbortSignal) and DECOMPRESSED size, and admit only allowlisted content
 * types. Decompression contract: the request advertises
 * `Accept-Encoding: identity`; if a server compresses anyway, the body is
 * streamed through node:zlib (gzip/deflate/br) and the byte cap is applied to
 * the DECOMPRESSED output — the decompression-bomb guard — while unknown
 * encodings are rejected outright. No credentials ever leave: no cookie,
 * authorization, or referer header, and userinfo in the URL is dropped when
 * the request URL is rebuilt from parts (it never reaches the transport, which
 * would otherwise turn it into a basic-auth header).
 *
 * Failures return a bounded reason code and never a partial body. Reason codes
 * are the ONLY thing logged — never the hostname, resolved IP, or fetched
 * content — so local logs can't become an internal-network-topology oracle.
 */

import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { LookupFunction } from 'node:net';
import type { Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { getLogger } from '../logger.ts';
import { classifyHost, isPublicUnicastIp } from './ip-classifier.ts';

const logger = getLogger('link-preview.guarded-fetch');

const USER_AGENT = 'OpenKnowledge-LinkPreview/1.x';

/** Decompressed-body ceiling; reads abort once a response exceeds it. */
export const DEFAULT_MAX_BYTES = 512 * 1024;
/** Total wall-clock budget across all redirect hops and the body read. */
export const DEFAULT_TIMEOUT_MS = 5000;
/** Redirect hops followed before a chain is rejected. */
export const DEFAULT_MAX_REDIRECTS = 3;

/**
 * Bounded taxonomy of rejection causes. Deliberately coarse so it is safe to
 * log: no member encodes the target host, resolved address, or body.
 */
export type GuardRejectReason =
  | 'bad-scheme'
  | 'private-ip'
  | 'dns-failure'
  | 'redirect-limit'
  | 'oversized'
  | 'non-html'
  | 'timeout'
  | 'fetch-error';

/** @lintignore Union member of the exported GuardedFetchResult; no direct importer. */
export interface GuardedFetchSuccess {
  ok: true;
  /** Decompressed response bytes, guaranteed within the byte cap. */
  body: Uint8Array;
  /** Lowercased mime type with parameters stripped (e.g. `text/html`). */
  contentType: string;
  /** The final hostname-bearing URL after redirects (domain derivation seam). */
  finalUrl: string;
}

/** @lintignore Union member of the exported GuardedFetchResult; no direct importer. */
export interface GuardedFetchFailure {
  ok: false;
  reason: GuardRejectReason;
}

export type GuardedFetchResult = GuardedFetchSuccess | GuardedFetchFailure;

/**
 * One resolved DNS record; mirrors the fields of a getaddrinfo lookup.
 * @lintignore Referenced by the exported HostResolver type; no direct importer.
 */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * DNS seam. Production wires the platform resolver (getaddrinfo, all records);
 * tests substitute a resolver that forces a hostname to a chosen address so the
 * validator can be exercised without real DNS.
 */
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface GuardedFetchOptions {
  /**
   * Response content-type admission predicate (lowercased, no parameters).
   * Defaults to HTML only; the favicon path passes an image predicate.
   */
  allowContentType?: (mimeType: string) => boolean;
  /** Overrides {@link DEFAULT_MAX_BYTES}. */
  maxBytes?: number;
  /** Overrides {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Overrides {@link DEFAULT_MAX_REDIRECTS}. */
  maxRedirects?: number;
  /** DNS seam; defaults to the platform getaddrinfo resolver. */
  resolve?: HostResolver;
  /**
   * Resolved-address admission predicate; defaults to the public-unicast
   * classifier. Overridden ONLY by integration tests, to admit the loopback
   * address of a local rig so post-admission behavior (caps, redirects,
   * content-type) can be exercised against a real socket. Production never
   * passes it, and every redirect target still runs the real classifier, so
   * the SSRF property is proven by the tests that omit this override.
   */
  isAddressAllowed?: (ip: string) => boolean;
}

interface AdmittedTarget {
  /**
   * Sanitized URL the request is issued against: rebuilt from parts so
   * userinfo and fragment never survive. Keeps the original hostname (SNI,
   * cert validation, and the Host header derive from it) except for IP-literal
   * hosts, where it carries the canonical literal the runtime dials directly.
   */
  requestUrl: string;
  /**
   * The single validated address the socket must dial, enforced via the
   * request's `lookup` option; absent for IP-literal hosts (the runtime
   * connects to the literal without any DNS).
   */
  pinnedAddress: ResolvedAddress | undefined;
  /** Original hostname for explicit TLS SNI; absent for IP literals. */
  serverName: string | undefined;
  /** Hostname-bearing URL used as the base for resolving redirect Locations. */
  logicalUrl: string;
}

type AdmitResult = { ok: true; target: AdmittedTarget } | { ok: false; reason: GuardRejectReason };

const defaultResolve: HostResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, family: 0 });
  return records.map((record) => ({
    address: record.address,
    family: record.family === 6 ? 6 : 4,
  }));
};

/**
 * Rebuild the request URL against an explicit host, preserving scheme, port,
 * path, and query while dropping userinfo and fragment. Building from parts
 * (rather than string-editing the original) is what guarantees no embedded
 * credentials survive into the outbound request.
 */
function buildSanitizedUrl(url: URL, host: string): string {
  const port = url.port ? `:${url.port}` : '';
  return `${url.protocol}//${host}${port}${url.pathname}${url.search}`;
}

async function admit(
  rawUrl: string,
  resolve: HostResolver,
  isAddressAllowed: (ip: string) => boolean,
): Promise<AdmitResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'fetch-error' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'bad-scheme' };
  }

  const classification = classifyHost(url.hostname);
  if (classification.kind === 'ip-literal') {
    if (!classification.allowed) return { ok: false, reason: 'private-ip' };
    const connectHost =
      classification.family === 6 ? `[${classification.canonical}]` : classification.canonical;
    return {
      ok: true,
      target: {
        requestUrl: buildSanitizedUrl(url, connectHost),
        pinnedAddress: undefined,
        serverName: undefined,
        logicalUrl: url.toString(),
      },
    };
  }

  let records: ResolvedAddress[];
  try {
    records = await resolve(url.hostname);
  } catch {
    return { ok: false, reason: 'dns-failure' };
  }
  if (records.length === 0) return { ok: false, reason: 'dns-failure' };
  for (const record of records) {
    if (!isAddressAllowed(record.address)) return { ok: false, reason: 'private-ip' };
  }

  const chosen = records[0];
  return {
    ok: true,
    target: {
      requestUrl: buildSanitizedUrl(url, url.hostname),
      pinnedAddress: {
        address: chosen.address,
        family: chosen.family === 6 || chosen.address.includes(':') ? 6 : 4,
      },
      serverName: url.hostname,
      logicalUrl: url.toString(),
    },
  };
}

/**
 * Connection pin: answer every runtime lookup with ONLY the validated address.
 * Both runtimes may ask in the all-addresses form (happy-eyeballs), and both
 * reject a scalar answer to an `all` question, so the shape must follow the
 * question.
 */
function pinnedLookup(pinned: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
    } else {
      callback(null, pinned.address, pinned.family);
    }
  };
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function parseMimeType(header: string | undefined): string {
  if (!header) return '';
  return (header.split(';', 1)[0] ?? '').trim().toLowerCase();
}

/** A request/read that failed because the shared deadline fired reads as a timeout. */
function classifyFetchError(err: unknown, signal: AbortSignal): GuardRejectReason {
  if (signal.aborted) return 'timeout';
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return 'timeout';
  }
  return 'fetch-error';
}

/** Best-effort release of an unread response (redirect / rejected body). */
function discardMessage(message: IncomingMessage): void {
  try {
    message.destroy();
  } catch {
    // The stream may already be closed by the remote/runtime; a cleanup
    // destroy that throws has no bearing on the guard decision.
  }
}

type IssueResult =
  | { ok: true; response: IncomingMessage }
  | { ok: false; reason: GuardRejectReason };

function issueRequest(target: AdmittedTarget, signal: AbortSignal): Promise<IssueResult> {
  return new Promise((settle) => {
    let settled = false;
    const resolveOnce = (result: IssueResult) => {
      if (settled) return;
      settled = true;
      settle(result);
    };

    const isHttps = target.requestUrl.startsWith('https:');
    const options: RequestOptions = {
      method: 'GET',
      // One socket per request, never pooled: a keep-alive agent could reuse a
      // connection across hops whose pinned addresses differ.
      agent: false,
      signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html',
        'Accept-Encoding': 'identity',
      },
    };
    if (target.pinnedAddress) options.lookup = pinnedLookup(target.pinnedAddress);
    if (isHttps && target.serverName) options.servername = target.serverName;

    try {
      const req = (isHttps ? httpsRequest : httpRequest)(target.requestUrl, options, (response) => {
        // Swallow-guard: a mid-body socket error must reach the body reader's
        // listener, not crash the process as an unhandled stream error in the
        // window before that listener attaches.
        response.on('error', () => {});
        resolveOnce({ ok: true, response });
      });
      req.on('error', (err) => resolveOnce({ ok: false, reason: classifyFetchError(err, signal) }));
      req.end();
    } catch (err) {
      resolveOnce({ ok: false, reason: classifyFetchError(err, signal) });
    }
  });
}

/**
 * Streaming decoder for a response that compressed despite
 * `Accept-Encoding: identity`. Returns `'identity'` for an uncompressed body,
 * a zlib transform for the encodings we can safely decode, or `null` for
 * anything else (rejected — an undecodable body can't be admitted and an
 * unknown coding can't be size-guarded).
 */
function makeDecompressor(encoding: string): Transform | 'identity' | null {
  if (encoding === '' || encoding === 'identity') return 'identity';
  if (encoding === 'gzip' || encoding === 'x-gzip') return createGunzip();
  if (encoding === 'deflate') return createInflate();
  if (encoding === 'br') return createBrotliDecompress();
  return null;
}

function readCappedBody(
  message: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ ok: true; body: Uint8Array } | { ok: false; reason: GuardRejectReason }> {
  const encoding = (message.headers['content-encoding'] ?? '').trim().toLowerCase();
  const decompressor = makeDecompressor(encoding);
  if (decompressor === null) {
    discardMessage(message);
    return Promise.resolve({ ok: false, reason: 'fetch-error' });
  }
  // The cap below counts bytes AFTER this pipe, so it bounds the decompressed
  // size — a tiny compressed bomb still aborts at the cap.
  const source = decompressor === 'identity' ? message : message.pipe(decompressor);

  return new Promise((settle) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const teardown = () => {
      signal.removeEventListener('abort', onAbort);
      discardMessage(message);
      if (source !== message) (source as Transform).destroy();
    };
    const resolveOnce = (
      result: { ok: true; body: Uint8Array } | { ok: false; reason: GuardRejectReason },
    ) => {
      if (settled) return;
      settled = true;
      teardown();
      settle(result);
    };
    const onAbort = () => resolveOnce({ ok: false, reason: 'timeout' });
    signal.addEventListener('abort', onAbort, { once: true });

    // `pipe` does not forward source errors; surface them on the terminal read.
    if (source !== message) {
      message.on('error', (err) =>
        resolveOnce({ ok: false, reason: classifyFetchError(err, signal) }),
      );
    }
    source.on('data', (chunk: Buffer) => {
      received += chunk.byteLength;
      if (received > maxBytes) {
        resolveOnce({ ok: false, reason: 'oversized' });
        return;
      }
      chunks.push(chunk);
    });
    source.on('end', () => resolveOnce({ ok: true, body: new Uint8Array(Buffer.concat(chunks)) }));
    source.on('error', (err) =>
      resolveOnce({ ok: false, reason: classifyFetchError(err, signal) }),
    );
  });
}

function rejectWith(reason: GuardRejectReason): GuardedFetchFailure {
  logger.debug({ reason }, 'link-preview guarded fetch rejected');
  return { ok: false, reason };
}

/**
 * Fetch a URL under the SSRF guard. Returns the bounded response body plus the
 * derived content-type and final URL on success, or a bounded reason code on
 * any violation — never a partial body.
 */
export async function guardedFetch(
  rawUrl: string,
  options: GuardedFetchOptions = {},
): Promise<GuardedFetchResult> {
  const allowContentType = options.allowContentType ?? ((mimeType) => mimeType === 'text/html');
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const resolve = options.resolve ?? defaultResolve;
  const isAddressAllowed = options.isAddressAllowed ?? isPublicUnicastIp;

  const signal = AbortSignal.timeout(timeoutMs);
  let logicalUrl = rawUrl;
  let redirects = 0;

  while (true) {
    const admitted = await admit(logicalUrl, resolve, isAddressAllowed);
    if (!admitted.ok) return rejectWith(admitted.reason);
    const { target } = admitted;

    const issued = await issueRequest(target, signal);
    if (!issued.ok) return rejectWith(issued.reason);
    const response = issued.response;
    const status = response.statusCode ?? 0;

    if (isRedirectStatus(status)) {
      const location = response.headers.location;
      discardMessage(response);
      if (location === undefined) return rejectWith('fetch-error');
      if (redirects >= maxRedirects) return rejectWith('redirect-limit');
      redirects += 1;
      try {
        logicalUrl = new URL(location, target.logicalUrl).toString();
      } catch {
        return rejectWith('fetch-error');
      }
      continue;
    }

    const contentType = parseMimeType(response.headers['content-type']);
    if (!allowContentType(contentType)) {
      discardMessage(response);
      return rejectWith('non-html');
    }

    const bodyResult = await readCappedBody(response, maxBytes, signal);
    if (!bodyResult.ok) return rejectWith(bodyResult.reason);
    return { ok: true, body: bodyResult.body, contentType, finalUrl: target.logicalUrl };
  }
}
