import { mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
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
  return bootServer({
    host: '127.0.0.1',
    config: TEST_CONFIG,
    contentDir,
    port: 0,
    quiet: true,
    gitEnabled: false,
    idleShutdownMs: null,
    attachUiSibling: false,
    ...overrides,
  });
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
