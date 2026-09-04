import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { LookupFunction } from 'node:net';
import type { Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { getLogger } from '../logger.ts';
import { findHeadEndOffset } from './html-metadata.ts';
import { classifyHost, isPublicUnicastIp } from './ip-classifier.ts';

const logger = getLogger('link-preview.guarded-fetch');

const USER_AGENT = 'OpenKnowledge-LinkPreview/1.x';

export const DEFAULT_MAX_BYTES = 512 * 1024;
export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_REDIRECTS = 3;

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
  body: Uint8Array;
  contentType: string;
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

export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface GuardedFetchOptions {
  allowContentType?: (mimeType: string) => boolean;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  resolve?: HostResolver;
  isAddressAllowed?: (ip: string) => boolean;
}

interface AdmittedTarget {
  requestUrl: string;
  pinnedAddress: ResolvedAddress | undefined;
  serverName: string | undefined;
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

function classifyFetchError(err: unknown, signal: AbortSignal): GuardRejectReason {
  if (signal.aborted) return 'timeout';
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return 'timeout';
  }
  return 'fetch-error';
}

function discardMessage(message: IncomingMessage): void {
  try {
    message.destroy();
  } catch {}
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

function makeDecompressor(encoding: string): Transform | 'identity' | null {
  if (encoding === '' || encoding === 'identity') return 'identity';
  if (encoding === 'gzip' || encoding === 'x-gzip') return createGunzip();
  if (encoding === 'deflate') return createInflate();
  if (encoding === 'br') return createBrotliDecompress();
  return null;
}

export function createHeadEndScanner(): (chunk: Uint8Array) => number {
  let html = '';
  return (chunk) => {
    const consumed = html.length;
    html += Buffer.from(chunk).toString('latin1');
    const end = findHeadEndOffset(html);
    return end === -1 ? -1 : end - consumed;
  };
}

function readCappedBody(
  message: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
  scanHeadEnd: boolean,
): Promise<{ ok: true; body: Uint8Array } | { ok: false; reason: GuardRejectReason }> {
  const encoding = (message.headers['content-encoding'] ?? '').trim().toLowerCase();
  const decompressor = makeDecompressor(encoding);
  if (decompressor === null) {
    discardMessage(message);
    return Promise.resolve({ ok: false, reason: 'fetch-error' });
  }
  const source = decompressor === 'identity' ? message : message.pipe(decompressor);

  return new Promise((settle) => {
    const chunks: Buffer[] = [];
    const findHeadEnd = scanHeadEnd ? createHeadEndScanner() : null;
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

    if (source !== message) {
      message.on('error', (err) =>
        resolveOnce({ ok: false, reason: classifyFetchError(err, signal) }),
      );
    }
    source.on('data', (chunk: Buffer) => {
      if (findHeadEnd) {
        const endInChunk = findHeadEnd(chunk);
        if (endInChunk !== -1) {
          if (received + endInChunk > maxBytes) {
            resolveOnce({ ok: false, reason: 'oversized' });
            return;
          }
          chunks.push(chunk.subarray(0, endInChunk));
          resolveOnce({ ok: true, body: new Uint8Array(Buffer.concat(chunks)) });
          return;
        }
      }
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

    const bodyResult = await readCappedBody(
      response,
      maxBytes,
      signal,
      contentType === 'text/html',
    );
    if (!bodyResult.ok) return rejectWith(bodyResult.reason);
    return { ok: true, body: bodyResult.body, contentType, finalUrl: target.logicalUrl };
  }
}
