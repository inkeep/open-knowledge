import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Extension } from '@hocuspocus/server';
import { CONFIG_DOC_NAME_PROJECT_LOCAL } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createConceptEmbedder, type LoadOpenAiEmbedderInput } from './embeddings/index.ts';
import { getLogger } from './logger.ts';
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
let observedLoaderInput: LoadOpenAiEmbedderInput | undefined;

async function callViaServer(
  srv: ServerInstance,
  method: string,
  url: string,
  bodyObj?: Record<string, unknown>,
): Promise<unknown> {
  {
    const req = makeReq(method, url, bodyObj === undefined ? '' : JSON.stringify(bodyObj));
    const { res, captured } = makeRes();
    if (await srv.nativeApi.dispatch(req, res)) {
      expect(captured.status).toBe(200);
      return JSON.parse(captured.body);
    }
  }
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
    'search:\n  semantic:\n    enabled: true\n    maxBatchSize: 2\n    maxBatchChars: 16000\n    docTimeoutMs: 120000\n',
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
    embedderLoader: (input) => {
      observedLoaderInput = input;
      return Promise.resolve(embedder);
    },
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
    expect(observedLoaderInput?.options).toMatchObject({
      maxBatchSize: 2,
      maxBatchChars: 16_000,
      docTimeoutMs: 120_000,
    });
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

test.each([120_000, 900_000])(
  'transport fallback warnings occur only on load and reload (initial timeout %i)',
  async (initialTimeout) => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-sem-fallback-reload-'));
    const warn = vi.spyOn(getLogger('server'), 'warn');
    let srv: ServerInstance | undefined;
    let loaderInput: LoadOpenAiEmbedderInput | undefined;
    try {
      writeFileSync(join(dir, 'note.md'), '# Note\n\nAuthentication retries.\n', 'utf-8');
      mkdirSync(join(dir, '.ok', 'local'), { recursive: true });
      const localPath = join(dir, '.ok', 'local', 'config.yml');
      const source = `search:\n  semantic:\n    enabled: true\n    baseUrl: http://localhost:11434/v1\n    model: local-embedding\n    maxBatchSize: 2\n    maxBatchChars: 16000\n    docTimeoutMs: ${initialTimeout}\n`;
      writeFileSync(localPath, source, 'utf-8');
      srv = createServer({
        contentDir: dir,
        projectDir: dir,
        quiet: true,
        debounce: 60_000,
        gitEnabled: false,
        shadowRepo: await initShadowRepo(dir),
        skipStateManifestCheck: true,
        destroyTimeoutMs: 500,
        configHomedirOverride: dir,
        embedderLoader: (input) => {
          loaderInput = input;
          return Promise.resolve(createConceptEmbedder({ concepts: CONCEPTS }));
        },
      });
      const activeServer = srv;
      await activeServer.ready;
      const fallbackWarnings = () =>
        warn.mock.calls.filter(
          ([details]) =>
            typeof details === 'object' &&
            details !== null &&
            'code' in details &&
            details.code === 'VALUE_FALLBACK',
        );
      const initialWarningCount = initialTimeout === 900_000 ? 1 : 0;
      expect(fallbackWarnings()).toHaveLength(initialWarningCount);
      await vi.waitFor(async () => {
        await searchViaServer(activeServer, { query: 'authentication', semantic: true });
        expect(loaderInput?.options?.docTimeoutMs).toBe(
          initialTimeout === 900_000 ? 30_000 : initialTimeout,
        );
      });
      expect(fallbackWarnings()).toHaveLength(initialWarningCount);
      warn.mockClear();
      const edited = source.replace(`docTimeoutMs: ${initialTimeout}`, 'docTimeoutMs: 900001');
      writeFileSync(localPath, edited, 'utf-8');

      await vi.waitFor(
        () => {
          expect(fallbackWarnings()).toEqual([
            [
              {
                code: 'VALUE_FALLBACK',
                scope: 'project-local',
                file: localPath,
                path: 'search.semantic.docTimeoutMs',
                line: 8,
                column: expect.any(Number),
              },
              '[config] search.semantic.docTimeoutMs: Expected an integer between 1 and 600000; using default 30000.',
            ],
          ]);
        },
        { timeout: 10_000 },
      );
      await vi.waitFor(async () => {
        await searchViaServer(activeServer, { query: 'authentication', semantic: true });
        expect(loaderInput?.options).toMatchObject({
          maxBatchSize: 2,
          maxBatchChars: 16_000,
          docTimeoutMs: 30_000,
        });
      });
      expect(loaderInput?.config).toMatchObject({
        baseUrl: 'http://localhost:11434/v1',
        model: 'local-embedding',
      });
      expect(readFileSync(localPath, 'utf-8')).toBe(edited);
      expect(await callViaServer(activeServer, 'GET', '/api/config/diagnostics')).toMatchObject({
        diagnostics: [{ code: 'VALUE_FALLBACK', scope: 'project-local', file: localPath }],
      });
      for (let request = 0; request < 3; request += 1) {
        await searchViaServer(activeServer, { query: 'authentication', semantic: true });
        await callViaServer(activeServer, 'GET', '/api/config/diagnostics');
      }
      expect(fallbackWarnings()).toHaveLength(1);
      expect(
        warn.mock.calls.some(
          ([, message]) => message === '[config] could not read project-local config',
        ),
      ).toBe(false);
    } finally {
      await srv?.destroy();
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);

test('persisted Y.Text transport fallback warns once after the file watcher echo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ok-sem-fallback-persist-'));
  const warn = vi.spyOn(getLogger('server'), 'warn');
  const info = vi.spyOn(getLogger('server'), 'info');
  let srv: ServerInstance | undefined;
  let loaderInput: LoadOpenAiEmbedderInput | undefined;
  try {
    writeFileSync(join(dir, 'note.md'), '# Note\n\nAuthentication retries.\n', 'utf-8');
    mkdirSync(join(dir, '.ok', 'local'), { recursive: true });
    const localPath = join(dir, '.ok', 'local', 'config.yml');
    const source =
      'search:\n  semantic:\n    enabled: true\n    baseUrl: http://localhost:11434/v1\n    model: local-embedding\n    maxBatchSize: 2\n    maxBatchChars: 16000\n    docTimeoutMs: 120000\n';
    writeFileSync(localPath, source, 'utf-8');
    srv = createServer({
      contentDir: dir,
      projectDir: dir,
      quiet: true,
      debounce: 60_000,
      gitEnabled: false,
      shadowRepo: await initShadowRepo(dir),
      skipStateManifestCheck: true,
      destroyTimeoutMs: 500,
      configHomedirOverride: dir,
      embedderLoader: (input) => {
        loaderInput = input;
        return Promise.resolve(createConceptEmbedder({ concepts: CONCEPTS }));
      },
    });
    const activeServer = srv;
    await activeServer.ready;
    await vi.waitFor(async () => {
      await searchViaServer(activeServer, { query: 'authentication', semantic: true });
      expect(loaderInput?.options?.docTimeoutMs).toBe(120_000);
    });
    warn.mockClear();
    info.mockClear();
    const edited = source.replace('docTimeoutMs: 120000', 'docTimeoutMs: 900000');
    const connection = await activeServer.hocuspocus.openDirectConnection(
      CONFIG_DOC_NAME_PROJECT_LOCAL,
    );
    const document = connection.document;
    if (!document) throw new Error('expected an open config document');
    const origin = Object.freeze({ source: 'local', context: {} });
    document.transact(() => {
      const ytext = document.getText('source');
      ytext.delete(0, ytext.length);
      ytext.insert(0, edited);
    }, origin);
    await connection.disconnect();

    await vi.waitFor(
      () => {
        expect(info).toHaveBeenCalledWith(
          { docName: CONFIG_DOC_NAME_PROJECT_LOCAL, outcome: 'no-op', isEcho: true },
          '[config-file-watcher] applyExternalConfigChange outcome',
        );
      },
      { timeout: 10_000 },
    );
    await vi.waitFor(async () => {
      await searchViaServer(activeServer, { query: 'authentication', semantic: true });
      expect(loaderInput?.options).toMatchObject({
        maxBatchSize: 2,
        maxBatchChars: 16_000,
        docTimeoutMs: 30_000,
      });
    });
    expect(loaderInput?.config).toMatchObject({
      baseUrl: 'http://localhost:11434/v1',
      model: 'local-embedding',
    });
    expect(readFileSync(localPath, 'utf-8')).toBe(edited);
    expect(
      warn.mock.calls.filter(
        ([details]) =>
          typeof details === 'object' &&
          details !== null &&
          'code' in details &&
          details.code === 'VALUE_FALLBACK',
      ),
    ).toEqual([
      [
        {
          code: 'VALUE_FALLBACK',
          scope: 'project-local',
          file: localPath,
          path: 'search.semantic.docTimeoutMs',
          line: 8,
          column: expect.any(Number),
        },
        '[config] search.semantic.docTimeoutMs: Expected an integer between 1 and 600000; using default 30000.',
      ],
    ]);
  } finally {
    await srv?.destroy();
    warn.mockRestore();
    info.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test('generated-index settings do not repeat an unrelated project-local fallback warning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ok-sem-fallback-generated-index-'));
  const warn = vi.spyOn(getLogger('server'), 'warn');
  let srv: ServerInstance | undefined;
  try {
    writeFileSync(join(dir, 'note.md'), '# Note\n', 'utf-8');
    mkdirSync(join(dir, '.ok', 'local'), { recursive: true });
    const localPath = join(dir, '.ok', 'local', 'config.yml');
    writeFileSync(localPath, 'search:\n  semantic:\n    docTimeoutMs: 900000\n', 'utf-8');
    writeFileSync(
      join(dir, '.ok', 'config.yml'),
      'contentRules:\n  okf:\n    generate:\n      index: false\n',
      'utf-8',
    );
    srv = createServer({
      contentDir: dir,
      projectDir: dir,
      quiet: true,
      debounce: 60_000,
      gitEnabled: false,
      shadowRepo: await initShadowRepo(dir),
      skipStateManifestCheck: true,
      destroyTimeoutMs: 500,
      configHomedirOverride: dir,
    });
    const activeServer = srv;
    await activeServer.ready;
    const fallbackWarnings = () =>
      warn.mock.calls.filter(
        ([details]) =>
          typeof details === 'object' &&
          details !== null &&
          'code' in details &&
          details.code === 'VALUE_FALLBACK',
      );
    expect(fallbackWarnings()).toHaveLength(1);
    warn.mockClear();
    expect(
      await callViaServer(activeServer, 'POST', '/api/generated-index/settings', { enabled: true }),
    ).toMatchObject({ enabled: true, applied: true });
    expect(await callViaServer(activeServer, 'GET', '/api/config/diagnostics')).toMatchObject({
      diagnostics: [{ code: 'VALUE_FALLBACK', scope: 'project-local', file: localPath }],
    });
    expect(fallbackWarnings()).toHaveLength(0);
  } finally {
    await srv?.destroy();
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

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
        expect(result?.semantic?.coverage.embedded).toBe(1);
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

        await searchViaServer(srv, { query: 'auth retries', semantic: true });
        const warmed = (await callViaServer(srv, 'GET', '/api/semantic-status')) as {
          ready: boolean;
        };
        expect(warmed.ready).toBe(true);

        const setRes = (await callViaServer(srv, 'POST', '/api/local-op/embeddings/set-key', {
          key: 'sk-account-ui-key',
        })) as { keyPresent: boolean };
        expect(setRes.keyPresent).toBe(true);
        expect(readFileSync(secretsPath, 'utf-8')).toContain('sk-account-ui-key');
        const afterSet = (await callViaServer(srv, 'GET', '/api/semantic-status')) as {
          ready: boolean;
        };
        expect(afterSet.ready).toBe(false);

        const after = (await callViaServer(srv, 'GET', '/api/semantic-status')) as {
          keyPresent: boolean;
          keySource: string | null;
        };
        expect(after.keyPresent).toBe(true);
        expect(after.keySource).toBe('project');

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
