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

/**
 * Flag-ON semantic search driven through the REAL `createServer` boot, not a
 * hand-wired `createApiExtension`. This is the only test that exercises the
 * server-factory glue end-to-end: project-local config read
 * (`readSemanticSearchConfig` layering) → provider fingerprint → service
 * construction via the `embedderLoader` seam → api-extension wiring → the lazy
 * embed + query fusion on a `semantic: true` search. The deterministic concept
 * embedder stands in for the OpenAI HTTP client, so the suite makes no network
 * call while still running the production construction path.
 *
 * Also pins `.okignore`-excluded content never enters the corpus, so it is
 * never embedded, never counted in coverage, and never retrievable — even when
 * it is a strong conceptual match for the query.
 */

const CONCEPTS = [
  { id: 'auth', terms: ['auth', 'credential', 'session token', 'login', 'secret', 'sign-in'] },
  { id: 'retry', terms: ['retry', 'retries', 'refresh', 're-issue', 'rotation', 'backoff'] },
  { id: 'bread', terms: ['bread', 'sourdough', 'ferment', 'dough'] },
];

// Three served pages + one EXCLUDED page. `credential-rotation` is about
// auth+retry but shares zero tokens with "auth retries" (only the vector
// candidate source can retrieve it). `archive/old-secrets` is an even stronger
// auth+retry match — but it lives under `archive/`, which `.okignore` excludes,
// so it must never appear or be embedded.
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
// Hidden / dot-prefixed (`.github/` tooling). The predicate split makes it
// SEARCHABLE (admitted to the corpus, rank-deprioritized) but it is NEVER
// embedded — it surfaces as a lexical/full-text hit with no vector signal and is
// not counted in coverage. Strong auth+retry match, so it would also embed if the
// egress filter regressed. NOT an editor-host dir (`.cursor` / `.claude` /
// `.codex` / `.agents` hold skill PROJECTIONS and are excluded from the index by
// skills-as-content, so they are not searchable — a different concern from the
// dot-path lexical-admission split this test covers).
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
  // Loopback socket so `checkLocalOpSecurity`-gated routes (the embeddings
  // set/clear handlers) admit the request, the same as a real localhost client.
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

/**
 * Drive one `POST /api/search` through the booted server's wired extension
 * chain. Several extensions expose `onRequest`; Hocuspocus calls them in
 * registration order until one writes a response. We mirror that here (a fresh
 * request per attempt so an early extension can't consume the body the api
 * extension needs) rather than reaching for one extension by index — that keeps
 * the test honest about which extension actually serves `/api/search`.
 */
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
  // Root `.okignore` excludes the whole archive subtree (project-relative).
  writeFileSync(join(tmpDir, '.okignore'), 'archive/\n', 'utf-8');
  // Project-local config flips the feature ON. The factory reads this FRESH at
  // construction (readSemanticSearchConfig), so it must exist before createServer.
  mkdirSync(join(tmpDir, '.ok', 'local'), { recursive: true });
  writeFileSync(
    join(tmpDir, '.ok', 'local', 'config.yml'),
    'search:\n  semantic:\n    enabled: true\n',
    'utf-8',
  );
  // Isolate the home so the `keyPresent` read in /api/semantic-status hits a
  // sandboxed secrets file, not the developer's real ~/.ok. Seed a key there so
  // the probe reports keyPresent:true (matching the injected embedder's warm).
  writeFileSync(
    join(tmpDir, '.ok', 'secrets.yml'),
    'OPENAI_API_KEY: sk-test-factory-key\n',
    'utf-8',
  );

  const shadowRepo = await initShadowRepo(tmpDir);
  // One deterministic embedder, injected through the production `embedderLoader`
  // seam — the same seam the OpenAI HTTP loader plugs into. No network.
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
    // The first opt-in search fires the lazy background corpus embed. Poll until
    // it warms (the concept embedder is fast + offline) — this exercises the real
    // lazy-warm path rather than a pre-seeded service. Bounded by a wall-clock
    // deadline (not an iteration count) so the test stays green even when the
    // full `bun run check` concurrency slows the background pass; warm normally
    // lands in well under a second, so the loop exits on the first iteration.
    const deadline = Date.now() + 20_000;
    let result: SearchBody | undefined;
    do {
      result = await searchViaServer(server, {
        query: 'auth retries',
        intent: 'full_text',
        semantic: true,
      });
      // holds on EVERY poll, warm or cold: excluded content is never indexed.
      for (const r of result.results ?? []) {
        expect(r.path.startsWith('archive/')).toBe(false);
      }
      if ((result.semantic?.coverage.embedded ?? 0) >= SERVED_PAGE_COUNT) break;
      await new Promise((r) => setTimeout(r, 25));
    } while (Date.now() < deadline);

    expect(result?.semantic?.capable).toBe(true);
    // Coverage denominator counts only the served pages — the excluded archive
    // doc is absent from the corpus entirely.
    expect(result?.semantic?.coverage.total).toBe(SERVED_PAGE_COUNT);
    expect(result?.semantic?.coverage.embedded).toBe(SERVED_PAGE_COUNT);
    expect(result?.semantic?.applied).toBe(true);

    // The zero-token-overlap doc is retrieved purely via the vector candidate source.
    const rotation = result?.results?.find((r) => r.path === 'guides/credential-rotation');
    expect(rotation, 'zero-overlap doc must surface via the vector candidate source').toBeDefined();
    expect(typeof rotation?.signals.vector).toBe('number');
    expect(rotation?.signals.vector ?? 0).toBeGreaterThan(0.3);

    // The strongly-matching but excluded doc is never retrievable.
    expect(result?.results?.find((r) => r.path === 'archive/old-secrets')).toBeUndefined();
    // The hidden (.github/) tooling doc IS searchable now (predicate split: dot-
    // paths are admitted to the corpus, rank-deprioritized) — but it is NEVER
    // embedded. It surfaces as a lexical/full-text hit carrying NO vector signal,
    // and the coverage.total === SERVED_PAGE_COUNT assertion above confirms it was
    // never embedded or counted as embeddable.
    const hiddenHit = result?.results?.find((r) => r.path.startsWith('.github/'));
    expect(hiddenHit, 'hidden dot-path is searchable').toBeDefined();
    expect(hiddenHit?.signals.vector, 'but a hidden dot-path is never embedded').toBeUndefined();

    // The real content-addressed cache path ran (not the memory-only test double).
    expect(existsSync(join(tmpDir, '.ok', 'local', 'embeddings'))).toBe(true);
  }, 30_000);

  test('GET /api/semantic-status reports enabled + ready + capable + coverage', async () => {
    // Runs after the warm above (a real search warmed the service lazily), so
    // `ready` is true and coverage is full. The status probe itself is
    // side-effect-free — it never warms (would read the OS keychain) or embeds;
    // it reports the service's already-resolved state.
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
    // Redacted last-4 tail of the seeded `sk-test-factory-key` — never the full key.
    expect(status.keyHint).toBe('-key');
    expect(status.ready).toBe(true);
    expect(status.capable).toBe(true);
    // Total counts only the served pages — hidden (.github/) + .okignore'd out.
    expect(status.total).toBe(SERVED_PAGE_COUNT);
    expect(status.embedded).toBe(SERVED_PAGE_COUNT);
  });

  test('the omnibar per-keystroke call shape stays lexical through the same booted server', async () => {
    // No `semantic` field — the cmd-K omnibar's per-keystroke shape (it carries
    // `source: 'omnibar'` but never `semantic`). Even with the feature enabled +
    // warm at the server level, this must not opt in: no vector, no excluded-doc
    // leak, and no status block (byte-identical to the pre-embeddings response).
    const { results, semantic } = await searchViaServer(server, {
      query: 'auth retries',
      intent: 'full_text',
      source: 'omnibar',
    });
    for (const r of results ?? []) expect('vector' in r.signals).toBe(false);
    expect(results?.find((r) => r.path === 'guides/credential-rotation')).toBeUndefined();
    // Hidden tooling docs ARE in the lexical corpus now (predicate split): they
    // are searchable by name/path through the omnibar's lexical path, just rank-
    // deprioritized. The no-vector loop above already confirms none are embedded.
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
      // Enable in the COMMITTED project config (`.ok/config.yml`, the shared
      // layer) and provide NO project-local config. A project-local egress
      // opt-in must NOT be honored from here — otherwise a committed config
      // could turn on content egress for everyone who clones the repo.
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
        // Semantic stays OFF: no status block and no vector signal — byte-
        // identical to the feature-off path, despite the committed config.
        expect(semantic).toBeUndefined();
        for (const r of results ?? []) expect('vector' in r.signals).toBe(false);

        // The status probe must agree: read through the SAME project-local-only
        // resolver, so a committed-config `enabled: true` reports `enabled:
        // false` here. Guards against the endpoint regressing to a merged read
        // (which would light up the Settings coverage panel for a non-opted-in
        // user).
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
    // Retrieval is rank-based by default (floor 0): the zero-token-overlap
    // credential-rotation doc surfaces purely via the vector candidate source
    // (proven by the main factory test above). Here a project-local
    // `similarityFloor` of 0.999 is set, which only a near-identical match could
    // clear — so the same doc must NOT surface. That exercises the full config →
    // readProjectLocalSemanticConfig → getSemanticSimilarityFloor → core
    // rankWithVector path, which typecheck can't verify and this subsystem has a
    // documented history of wiring to the wrong config layer.
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
        // Drive the lazy warm + embed, then assert the configured floor held: the
        // vector-only doc never surfaces and no result carries a vector signal.
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
        // ...but the configured 0.999 floor gated it out of retrieval entirely.
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
      // Enable in project-local so /api/semantic-status reports a real project.
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
        // Redirect the secrets file into the sandbox — the set/clear handlers
        // write `<home>/.ok/secrets.yml`, never the developer's real home.
        configHomedirOverride: dir,
        embedderLoader: () => Promise.resolve(createConceptEmbedder({ concepts: CONCEPTS })),
      });
      await srv.ready;
      const secretsPath = join(dir, '.ok', 'secrets.yml');
      try {
        // No key yet.
        const before = (await callViaServer(srv, 'GET', '/api/semantic-status')) as {
          keyPresent: boolean;
        };
        expect(before.keyPresent).toBe(false);
        expect(existsSync(secretsPath)).toBe(false);

        // Set the key via the loopback handler.
        const setRes = (await callViaServer(srv, 'POST', '/api/local-op/embeddings/set-key', {
          key: 'sk-account-ui-key',
        })) as { keyPresent: boolean };
        expect(setRes.keyPresent).toBe(true);
        expect(readFileSync(secretsPath, 'utf-8')).toContain('sk-account-ui-key');

        // Status reflects it (free file read).
        const after = (await callViaServer(srv, 'GET', '/api/semantic-status')) as {
          keyPresent: boolean;
          keySource: string | null;
        };
        expect(after.keyPresent).toBe(true);
        expect(after.keySource).toBe('file');

        // Clear it.
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
