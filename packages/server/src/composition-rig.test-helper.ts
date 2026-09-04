import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import { type BootedServer, type BootServerOptions, bootServer } from './boot.ts';
import { ConfigSchema } from './config/schema.ts';

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
  if (overrides.configHomedirOverride === undefined) {
    const inner = booted.destroy;
    booted.destroy = async (reason) => {
      try {
        await inner(reason);
      } finally {
        rmSync(ownedHome, { recursive: true, force: true });
      }
    };
  }
  return booted;
}

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
    req.on('error', (err) => {
      if (!settled) reject(err);
    });
    req.setTimeout(10_000, () => req.destroy(new Error(`timed out: ${path}`)));

    const body = options.body;
    if (body === undefined) {
      req.end();
      return;
    }
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
