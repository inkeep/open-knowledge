import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Extension } from '@hocuspocus/server';
import { createConceptEmbedder } from './embeddings/index.ts';
import { createServer, type ServerInstance } from './server-factory.ts';
import { initShadowRepo } from './shadow-repo.ts';


const CONCEPTS = [
  { id: 'auth', terms: ['auth', 'credential', 'session token', 'login', 'secret', 'sign-in'] },
  { id: 'retry', terms: ['retry', 'retries', 'refresh', 're-issue', 'rotation', 'backoff'] },
  { id: 'bread', terms: ['bread', 'sourdough', 'ferment', 'dough'] },
];

const SERVED_FILES: Record<string, string> = {
  'guides/credential-rotation.md':
    '# Credential Rotation\n\nThe credential rotation flow re-issues secrets when they expire.\n',
  'recipes/sourdough.md': '# Sourdough\n\nA recipe for sourdough bread with a long cold ferment.\n',
  'auth/login.md': '# Login\n\nThe login page authenticates a user and starts a session.\n',
};
const EXCLUDED_FILES: Record<string, string> = {
  'archive/old-secrets.md':
    '# Old Secrets\n\nLegacy notes on credential rotation: re-issue and refresh expired session secrets and login tokens.\n',
};
const HIDDEN_FILES: Record<string, string> = {
  '.github/auth-helper.md':
    '# Auth Helper\n\nCredential rotation: re-issue and refresh expired session secrets and login tokens.\n',
};
const SERVED_PAGE_COUNT = Object.keys(SERVED_FILES).length;

interface SearchRow {
  kind: string;
  path: string;
  signals: { lexical: number; fullText: number; recency: number; vector?: number };
}
interface SearchBody {
  results?: SearchRow[];
  semantic?: { capable: boolean; applied: boolean; coverage: { embedded: number; total: number } };
}

function makeReq(method: string, url: string, body = ''): IncomingMessage {
  const readable = Readable.from(Buffer.from(body)) as unknown as IncomingMessage;
  readable.method = method;
  readable.url = url;
  readable.headers = { host: 'localhost' };
  readable.socket = { remoteAddress: '127.0.0.1' } as unknown as IncomingMessage['socket'];
  return readable;
}
function makeRes(): { res: ServerResponse; captured: { status: number; body: string } } {
  const captured = { status: 0, body: '' };
  const res = {
    writeHead(status: number) {
      captured.status = status;
    },
    end(body?: string) {
      captured.body = body ?? '';
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

let tmpDir: string;
let server: ServerInstance;

async function callViaServer(
  srv: ServerInstance,
  method: string,
  url: string,
  bodyObj?: Record<string, unknown>,
): Promise<unknown> {
  const onRequestExts = srv.hocuspocus.configuration.extensions.filter(
    (
      e,
    ): e is Extension & {
      onRequest: (c: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    } => typeof (e as { onRequest?: unknown }).onRequest === 'function',
  );
  expect(onRequestExts.length, 'createServer must wire an onRequest api extension').toBeGreaterThan(
    0,
  );
  const { res, captured } = makeRes();
  for (const ext of onRequestExts) {
    const req = makeReq(method, url, bodyObj === undefined ? '' : JSON.stringify(bodyObj));
    await ext.onRequest({ request: req, response: res });
    if (captured.status !== 0) break;
  }
  expect(captured.status).toBe(200);
  return JSON.parse(captured.body);
}

function searchViaServer(
  srv: ServerInstance,
  bodyObj: Record<string, unknown>,
): Promise<SearchBody> {
  return callViaServer(srv, 'POST', '/api/search', bodyObj) as Promise<SearchBody>;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ok-sem-factory-'));
  for (const [rel, content] of Object.entries({
    ...SERVED_FILES,
    ...EXCLUDED_FILES,
    ...HIDDEN_FILES,
  })) {
    const abs = join(tmpDir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }
  writeFileSync(join(tmpDir, '.okignore'), 'archive/\n', 'utf-8');
  mkdirSync(join(tmpDir, '.ok', 'local'), { recursive: true });
  writeFileSync(
    join(tmpDir, '.ok', 'local', 'config.yml'),
    'search:\n  semantic:\n    enabled: true\n',
    'utf-8',
  );
  writeFileSync(
    join(tmpDir, '.ok', 'secrets.yml'),
    'OPENAI_API_KEY: sk-test-factory-key\n',
    'utf-8',
  );

  const shadowRepo = await initShadowRepo(tmpDir);
  const embedder = createConceptEmbedder({ concepts: CONCEPTS });
  server = createServer({
    contentDir: tmpDir,
    projectDir: tmpDir,
    quiet: true,
    debounce: 60_000,
    gitEnabled: false,
    shadowRepo,
    skipStateManifestCheck: true,
    destroyTimeoutMs: 500,
    configHomedirOverride: tmpDir,
    embedderLoader: () => Promise.resolve(embedder),
  });
  await server.ready;
});

afterAll(async () => {
  await server.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('createServer boot — flag-ON semantic search (factory glue)', () => {
  test('config-enabled boot fuses a vector signal and reports coverage; excluded content stays out', async () => {
    const deadline = Date.now() + 20_000;
    let result: SearchBody | undefined;
    do {
      result = await searchViaServer(server, {
        query: 'auth retries',
        intent: 'full_text',
        semantic: true,
      });
      for (const r of result.results ?? []) {
        expect(r.path.startsWith('archive/')).toBe(false);
      }
      if ((result.semantic?.coverage.embedded ?? 0) >= SERVED_PAGE_COUNT) break;
      await new Promise((r) => setTimeout(r, 25));
    } while (Date.now() < deadline);

    expect(result?.semantic?.capable).toBe(true);
    expect(result?.semantic?.coverage.total).toBe(SERVED_PAGE_COUNT);
    expect(result?.semantic?.coverage.embedded).toBe(SERVED_PAGE_COUNT);
    expect(result?.semantic?.applied).toBe(true);

    const rotation = result?.results?.find((r) => r.path === 'guides/credential-rotation');
    expect(rotation, 'zero-overlap doc must surface via the vector candidate source').toBeDefined();
    expect(typeof rotation?.signals.vector).toBe('number');
    expect(rotation?.signals.vector ?? 0).toBeGreaterThan(0.3);

    expect(result?.results?.find((r) => r.path === 'archive/old-secrets')).toBeUndefined();
    const hiddenHit = result?.results?.find((r) => r.path.startsWith('.github/'));
    expect(hiddenHit, 'hidden dot-path is searchable').toBeDefined();
    expect(hiddenHit?.signals.vector, 'but a hidden dot-path is never embedded').toBeUndefined();

    expect(existsSync(join(tmpDir, '.ok', 'local', 'embeddings'))).toBe(true);
  }, 30_000);

  test('GET /api/semantic-status reports enabled + ready + capable + coverage', async () => {
    const status = (await callViaServer(server, 'GET', '/api/semantic-status')) as {
      enabled: boolean;
      keyPresent: boolean;
      keySource: string | null;
      keyHint: string | null;
      ready: boolean;
      capable: boolean;
      embedded: number;
      total: number;
    };
    expect(status.enabled).toBe(true);
    expect(status.keyPresent).toBe(true);
    expect(status.keySource).toBe('file');
    expect(status.keyHint).toBe('-key');
    expect(status.ready).toBe(true);
    expect(status.capable).toBe(true);
    expect(status.total).toBe(SERVED_PAGE_COUNT);
    expect(status.embedded).toBe(SERVED_PAGE_COUNT);
  });

  test('the omnibar per-keystroke call shape stays lexical through the same booted server', async () => {
    const { results, semantic } = await searchViaServer(server, {
      query: 'auth retries',
      intent: 'full_text',
      source: 'omnibar',
    });
    for (const r of results ?? []) expect('vector' in r.signals).toBe(false);
    expect(results?.find((r) => r.path === 'guides/credential-rotation')).toBeUndefined();
    expect(results?.find((r) => r.path.startsWith('.github/'))).toBeDefined();
    expect(semantic).toBeUndefined();
  });

  test('semantic:false forces lexical through the same booted server', async () => {
    const { results, semantic } = await searchViaServer(server, {
      query: 'auth retries',
      intent: 'full_text',
      semantic: false,
    });
    for (const r of results ?? []) expect('vector' in r.signals).toBe(false);
    expect(results?.find((r) => r.path === 'guides/credential-rotation')).toBeUndefined();
    expect(semantic).toBeUndefined();
  });
});

describe('createServer boot — project-local scope enforcement (egress safety)', () => {
  test('enabled in the COMMITTED project config is ignored — project-local only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-sem-scope-'));
    try {
      writeFileSync(
        join(dir, 'note.md'),
        '# Note\n\nThe credential rotation flow re-issues secrets when they expire.\n',
        'utf-8',
      );
      mkdirSync(join(dir, '.ok'), { recursive: true });
      writeFileSync(
        join(dir, '.ok', 'config.yml'),
        'search:\n  semantic:\n    enabled: true\n',
        'utf-8',
      );

      const shadowRepo = await initShadowRepo(dir);
      const srv = createServer({
        contentDir: dir,
        projectDir: dir,
        quiet: true,
        debounce: 60_000,
        gitEnabled: false,
        shadowRepo,
        skipStateManifestCheck: true,
        destroyTimeoutMs: 500,
        configHomedirOverride: dir,
        embedderLoader: () => Promise.resolve(createConceptEmbedder({ concepts: CONCEPTS })),
      });
      await srv.ready;
      try {
        const { results, semantic } = await searchViaServer(srv, {
          query: 'auth retries',
          intent: 'full_text',
          semantic: true,
        });
        expect(semantic).toBeUndefined();
        for (const r of results ?? []) expect('vector' in r.signals).toBe(false);

        const status = (await callViaServer(srv, 'GET', '/api/semantic-status')) as {
          enabled: boolean;
          ready: boolean;
          capable: boolean;
        };
        expect(status.enabled).toBe(false);
        expect(status.ready).toBe(false);
        expect(status.capable).toBe(false);
      } finally {
        await srv.destroy();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createServer boot — similarityFloor config reaches core ranking', () => {
  test('a high project-local similarityFloor gates out a vector-only match the default would surface', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-sem-floor-'));
    try {
      writeFileSync(
        join(dir, 'rotation.md'),
        '# Credential Rotation\n\nThe credential rotation flow re-issues secrets when they expire.\n',
        'utf-8',
      );
      mkdirSync(join(dir, '.ok', 'local'), { recursive: true });
      writeFileSync(
        join(dir, '.ok', 'local', 'config.yml'),
        'search:\n  semantic:\n    enabled: true\n    similarityFloor: 0.999\n',
        'utf-8',
      );
      writeFileSync(join(dir, '.ok', 'secrets.yml'), 'OPENAI_API_KEY: sk-test\n', 'utf-8');
      const shadowRepo = await initShadowRepo(dir);
      const srv = createServer({
        contentDir: dir,
        projectDir: dir,
        quiet: true,
        debounce: 60_000,
        gitEnabled: false,
        shadowRepo,
        skipStateManifestCheck: true,
        destroyTimeoutMs: 500,
        configHomedirOverride: dir,
        embedderLoader: () => Promise.resolve(createConceptEmbedder({ concepts: CONCEPTS })),
      });
      await srv.ready;
      try {
        const deadline = Date.now() + 20_000;
        let result: SearchBody | undefined;
        do {
          result = await searchViaServer(srv, {
            query: 'auth retries',
            intent: 'full_text',
            semantic: true,
          });
          if ((result.semantic?.coverage.embedded ?? 0) >= 1) break;
          await new Promise((r) => setTimeout(r, 25));
        } while (Date.now() < deadline);

        expect(result?.semantic?.capable).toBe(true);
        expect(result?.semantic?.coverage.embedded).toBe(1); // the doc embedded
        expect(result?.results?.find((r) => r.path === 'rotation')).toBeUndefined();
        for (const r of result?.results ?? []) expect('vector' in r.signals).toBe(false);
        expect(result?.semantic?.applied).toBe(false);
      } finally {
        await srv.destroy();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('createServer boot — embeddings key set/clear handlers (Account control)', () => {
  test('set-key writes the secrets file, status flips keyPresent, clear-key removes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-sem-setkey-'));
    try {
      writeFileSync(join(dir, 'note.md'), '# Note\n', 'utf-8');
      mkdirSync(join(dir, '.ok', 'local'), { recursive: true });
      writeFileSync(
        join(dir, '.ok', 'local', 'config.yml'),
        'search:\n  semantic:\n    enabled: true\n',
        'utf-8',
      );
      const shadowRepo = await initShadowRepo(dir);
      const srv = createServer({
        contentDir: dir,
        projectDir: dir,
        quiet: true,
        debounce: 60_000,
        gitEnabled: false,
        shadowRepo,
        skipStateManifestCheck: true,
        destroyTimeoutMs: 500,
        configHomedirOverride: dir,
        embedderLoader: () => Promise.resolve(createConceptEmbedder({ concepts: CONCEPTS })),
      });
      await srv.ready;
      const secretsPath = join(dir, '.ok', 'secrets.yml');
      try {
        const before = (await callViaServer(srv, 'GET', '/api/semantic-status')) as {
          keyPresent: boolean;
        };
        expect(before.keyPresent).toBe(false);
        expect(existsSync(secretsPath)).toBe(false);

        const setRes = (await callViaServer(srv, 'POST', '/api/local-op/embeddings/set-key', {
          key: 'sk-account-ui-key',
        })) as { keyPresent: boolean };
        expect(setRes.keyPresent).toBe(true);
        expect(readFileSync(secretsPath, 'utf-8')).toContain('sk-account-ui-key');

        const after = (await callViaServer(srv, 'GET', '/api/semantic-status')) as {
          keyPresent: boolean;
          keySource: string | null;
        };
        expect(after.keyPresent).toBe(true);
        expect(after.keySource).toBe('file');

        const clearRes = (await callViaServer(
          srv,
          'POST',
          '/api/local-op/embeddings/clear-key',
          {},
        )) as {
          keyPresent: boolean;
        };
        expect(clearRes.keyPresent).toBe(false);
        const cleared = (await callViaServer(srv, 'GET', '/api/semantic-status')) as {
          keyPresent: boolean;
        };
        expect(cleared.keyPresent).toBe(false);
      } finally {
        await srv.destroy();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
