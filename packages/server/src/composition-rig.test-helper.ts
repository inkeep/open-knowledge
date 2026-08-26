import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import { type BootedServer, type BootServerOptions, bootServer } from './boot.ts';
import { ConfigSchema } from './config/schema.ts';

/**
 * Characterization rig for the composed server surface: boots the REAL
 * `bootServer` composition (mcp-mount dispatch + api-extension gates + collab
 * upgrade path) on an ephemeral loopback port so tests can probe routing,
 * admission, and lifecycle exactly as an HTTP client experiences them.
 *
 * `bootServer` refuses to boot without `<projectDir>/.ok/config.yml`; the
 * scaffold seeds it (plus `.ok/.gitignore` to keep the one-time hygiene
 * warning out of test stderr). No `git init`: every rig boots with
 * `gitEnabled: false`, which skips the git preflight and shadow-repo init, so
 * the rig never spawns child processes.
 */
function seedOkScaffold(projectDir: string): void {
  const okDir = resolve(projectDir, OK_DIR);
  mkdirSync(okDir, { recursive: true });
  writeFileSync(resolve(okDir, 'config.yml'), '', 'utf-8');
  writeFileSync(resolve(okDir, '.gitignore'), '', 'utf-8');
}

const TEST_CONFIG = ConfigSchema.parse({});

export async function bootCompositionRig(
  contentDir: string,
  overrides: Partial<BootServerOptions> = {},
): Promise<BootedServer> {
  seedOkScaffold(contentDir);
  // Isolate the home-dir scan on a dedicated empty tmpdir (NOT `contentDir`,
  // which would collapse the home + project config tiers onto one `.ok/`):
  // without an override, `homeDirOverride`/`skillsHome` fall through to the
  // runner's real `$HOME`, so `/api/skills/installed` enumerates the
  // developer's `~/.claude`. Computed BEFORE the boot so the mkdtemp is skipped
  // when a scope-separation suite supplies its own home.
  const ownedHome =
    overrides.configHomedirOverride ?? mkdtempSync(resolve(tmpdir(), 'ok-rig-home-'));
  const booted = await bootServer({
    host: '127.0.0.1',
    config: TEST_CONFIG,
    contentDir,
    port: 0,
    quiet: true,
    gitEnabled: false,
    idleShutdownMs: null,
    ...overrides,
    configHomedirOverride: ownedHome,
  });
  // The rig owns what it created — reap it on the teardown every consumer
  // already calls, rather than pushing cleanup onto each call site. A
  // caller-supplied home is left to its owner. (`destroy` is a plain mutable
  // property on a non-frozen object, so wrapping it is safe.)
  if (overrides.configHomedirOverride === undefined) {
    const inner = booted.destroy;
    booted.destroy = async (reason) => {
      // try/finally so the home is reaped even if the inner destroy throws its
      // AggregateError (a teardown-step timeout under CI load is documented,
      // not hypothetical) — mirrors bootServer's own destroy wrap.
      try {
        await inner(reason);
      } finally {
        rmSync(ownedHome, { recursive: true, force: true });
      }
    };
  }
  return booted;
}

/**
 * A synthetic `IncomingMessage` for HANDLER-LEVEL pins that dispatch a route's
 * handler directly (via `group.table.resolve(path)?.dispatch`), bypassing the
 * shared `/api/*` pipeline. That bypass is the point: `createApiRequestPipeline`
 * runs the origin gate and the universal `/api/*` peer + Host read gate before
 * it dispatches any route, so a handler's INLINE loopback/Host/local-op gate is
 * only observable when the handler runs without the pipeline in front of it.
 */
export function makeSyntheticReq(opts: {
  method?: string;
  url?: string;
  host?: string;
  origin?: string;
  remoteAddress?: string;
}): IncomingMessage {
  const req = Readable.from(Buffer.from('')) as unknown as IncomingMessage;
  req.method = opts.method ?? 'GET';
  req.url = opts.url ?? '/';
  req.headers = {
    host: opts.host ?? '127.0.0.1',
    ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
  };
  req.socket = {
    remoteAddress: opts.remoteAddress ?? '127.0.0.1',
  } as unknown as IncomingMessage['socket'];
  return req;
}

export interface CapturedRes {
  status: number;
  headers: Record<string, string | number | string[] | undefined>;
  body: string;
}

/**
 * A minimal `ServerResponse` that records what the wire emitters
 * (`errorResponse` / `successResponse`) write — status, headers, body — and
 * carries the `headersSent` / `writableEnded` / `destroyed` flags their
 * triple-guard reads.
 */
export function makeCaptureRes(): { res: ServerResponse; captured: CapturedRes } {
  const captured: CapturedRes = { status: 0, headers: {}, body: '' };
  const res = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    statusCode: 0,
    writeHead(status: number, headers?: Record<string, string | number | string[]>) {
      captured.status = status;
      if (headers)
        for (const [k, v] of Object.entries(headers)) captured.headers[k.toLowerCase()] = v;
      (res as { headersSent: boolean }).headersSent = true;
      return res;
    },
    setHeader(key: string, value: string | number | string[]) {
      captured.headers[key.toLowerCase()] = value;
    },
    getHeader(key: string) {
      return captured.headers[key.toLowerCase()];
    },
    end(body?: string) {
      // Handlers that set `res.statusCode` directly (the HEAD branches) instead
      // of calling writeHead surface their status here.
      if (captured.status === 0) captured.status = (res as { statusCode: number }).statusCode;
      if (body !== undefined) captured.body = body;
      (res as { writableEnded: boolean }).writableEnded = true;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * Issue a request with full header control. `fetch` refuses to override
 * `Host` (forbidden header), so the DNS-rebinding shape — loopback TCP peer
 * carrying an attacker-controlled Host — needs the raw `http.request`.
 */
export async function rawRequest(
  port: number,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
  } = {},
): Promise<RawResponse> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers,
        // Fresh socket per request. The server resets the connection after
        // refusing an oversized body, and a keep-alive agent would hand that
        // poisoned socket to the NEXT rawRequest → spurious ECONNRESET.
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          settled = true;
          resolvePromise({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      },
    );
    // A server that rejects mid-body (413) responds and tears down while the
    // client is still uploading; the resulting EPIPE/ECONNRESET on the
    // request side must not fail a call whose response was already read.
    req.on('error', (err) => {
      if (!settled) reject(err);
    });
    req.setTimeout(10_000, () => req.destroy(new Error(`timed out: ${path}`)));

    const body = options.body;
    if (body === undefined) {
      req.end();
      return;
    }
    // Stream the body in bounded chunks and abandon the remainder as soon as
    // a response arrives — pumping the rest into a socket the server has
    // already answered on just races an EPIPE.
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    let offset = 0;
    let responded = false;
    req.on('response', () => {
      responded = true;
    });
    const pump = (): void => {
      while (offset < buf.length && !responded) {
        const chunk = buf.subarray(offset, offset + 65_536);
        offset += chunk.length;
        if (!req.write(chunk)) {
          req.once('drain', pump);
          return;
        }
      }
      req.end();
    };
    pump();
  });
}

export interface ProblemJson {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
}

export function parseProblem(body: string): ProblemJson {
  return JSON.parse(body) as ProblemJson;
}
