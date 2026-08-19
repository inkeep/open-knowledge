import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import {
  computeCorpusSha256,
  FIXED_PROBE_CASE_IDS,
  probeShareContract,
} from './probe-share-contract.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORPUS_BYTES = readFileSync(
  join(REPO_ROOT, 'test-support/fixtures/share-url-v1-v2.json'),
  'utf8',
);
const CORPUS = JSON.parse(CORPUS_BYTES);
const EXPECTED_DEPLOYMENT_SHA = '1234567890abcdef1234567890abcdef12345678';

const fixedCases = FIXED_PROBE_CASE_IDS.map((id) => {
  const fixture = CORPUS.validShares.find((candidate) => candidate.id === id);
  if (!fixture) throw new Error(`missing fixed probe fixture ${id}`);
  return fixture;
});

const servers = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

function htmlFor(fixture, overrides = {}) {
  const sourceHref = overrides.sourceHref ?? fixture.sharedUrl;
  const customSchemeHref =
    overrides.customSchemeHref ?? `openknowledge://share?token=${fixture.token}`;
  const expectedName =
    fixture.target.kind === 'folder' && fixture.target.folderPath === ''
      ? new URL(fixture.sharedUrl).pathname.split('/')[2]
      : decodeURIComponent(new URL(fixture.sharedUrl).pathname.split('/').at(-1));
  return `<!doctype html><html><body>
    <h1 data-testid="splash-filename"><a href="${sourceHref}">${expectedName}</a></h1>
    <a data-testid="splash-repo-path" href="${sourceHref}">source</a>
    <a href="${customSchemeHref}" data-testid="splash-open-cta">open</a>
  </body></html>`;
}

async function startReader({ manifest, pages = new Map(), malformedManifest = false } = {}) {
  const server = createServer((request, response) => {
    if (request.url === '/.well-known/openknowledge-share-contract.json') {
      if (manifest === undefined) {
        response.writeHead(404).end('missing');
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(malformedManifest ? '{' : JSON.stringify(manifest));
      return;
    }

    const page = pages.get(request.url);
    if (page === undefined) {
      response.writeHead(404).end('missing');
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(page);
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('missing listener port');
  return `http://127.0.0.1:${address.port}`;
}

function compatibleReader(overrides = {}) {
  const pages = new Map(fixedCases.map((fixture) => [`/d/${fixture.token}`, htmlFor(fixture)]));
  return {
    manifest: {
      epoch: 2,
      corpusSha256: computeCorpusSha256(CORPUS_BYTES),
      deploymentSha: EXPECTED_DEPLOYMENT_SHA,
      ...overrides.manifest,
    },
    pages: overrides.pages ?? pages,
    malformedManifest: overrides.malformedManifest,
  };
}

async function expectProbeFailure(reader, message) {
  const origin = await startReader(reader);
  await expect(
    probeShareContract({
      origin,
      corpus: CORPUS,
      corpusBytes: CORPUS_BYTES,
      expectedDeploymentSha: EXPECTED_DEPLOYMENT_SHA,
    }),
  ).rejects.toThrow(message);
}

describe('share-contract reader probe', () => {
  test('proves the fixed v2 document and content-root pages against the manifest', async () => {
    const origin = await startReader(compatibleReader());
    const evidence = await probeShareContract({
      origin,
      corpus: CORPUS,
      corpusBytes: CORPUS_BYTES,
      expectedDeploymentSha: EXPECTED_DEPLOYMENT_SHA,
      now: () => new Date('2026-08-13T12:00:00.000Z'),
    });

    expect(evidence).toMatchObject({
      status: 'compatible',
      epoch: 2,
      corpusSha256: computeCorpusSha256(CORPUS_BYTES),
      deploymentSha: EXPECTED_DEPLOYMENT_SHA,
      checkedAt: '2026-08-13T12:00:00.000Z',
      probes: FIXED_PROBE_CASE_IDS.map((id) => ({ id, status: 'compatible' })),
    });
    const serialized = JSON.stringify(evidence);
    for (const fixture of fixedCases) {
      expect(serialized).not.toContain(fixture.token);
      expect(serialized).not.toContain(fixture.sharedUrl);
    }
  });

  test('normalizes a scheme-less Vercel deployment URL to HTTPS', async () => {
    const reader = compatibleReader();
    const requestedUrls = [];
    const fetchImpl = async (input) => {
      const url = new URL(String(input));
      requestedUrls.push(url.href);
      if (url.pathname === '/.well-known/openknowledge-share-contract.json') {
        return new Response(JSON.stringify(reader.manifest), {
          headers: { 'content-type': 'application/json' },
        });
      }
      const page = reader.pages.get(url.pathname);
      return page === undefined
        ? new Response('missing', { status: 404 })
        : new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    };

    const evidence = await probeShareContract({
      origin: 'reader.example.vercel.app',
      corpus: CORPUS,
      corpusBytes: CORPUS_BYTES,
      expectedDeploymentSha: EXPECTED_DEPLOYMENT_SHA,
      fetchImpl,
    });

    expect(evidence.status).toBe('compatible');
    expect(requestedUrls).not.toHaveLength(0);
    expect(requestedUrls.every((url) => url.startsWith('https://reader.example.vercel.app/'))).toBe(
      true,
    );
  });

  test('retries once past a transient network blip on the first fetch', async () => {
    const origin = await startReader(compatibleReader());
    let attempts = 0;
    const flakyFetch = (url, init) => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new TypeError('transient network blip'));
      return fetch(url, init);
    };
    const evidence = await probeShareContract({
      origin,
      corpus: CORPUS,
      corpusBytes: CORPUS_BYTES,
      expectedDeploymentSha: EXPECTED_DEPLOYMENT_SHA,
      fetchImpl: flakyFetch,
    });
    expect(evidence.status).toBe('compatible');
    // The blip on the first attempt was retried rather than paged on.
    expect(attempts).toBeGreaterThan(1);
  });

  test('fails closed when the network fault persists past the single retry', async () => {
    const origin = await startReader(compatibleReader());
    const alwaysThrows = () => Promise.reject(new TypeError('persistent network fault'));
    await expect(
      probeShareContract({
        origin,
        corpus: CORPUS,
        corpusBytes: CORPUS_BYTES,
        expectedDeploymentSha: EXPECTED_DEPLOYMENT_SHA,
        fetchImpl: alwaysThrows,
      }),
    ).rejects.toThrow(/manifest request failed/);
  });

  test.each([
    ['missing manifest', {}, /manifest request returned 404/],
    [
      'malformed manifest',
      compatibleReader({ malformedManifest: true }),
      /manifest is not valid JSON/,
    ],
    ['wrong epoch', compatibleReader({ manifest: { epoch: 1 } }), /manifest epoch/],
    [
      'wrong corpus digest',
      compatibleReader({ manifest: { corpusSha256: '0'.repeat(64) } }),
      /corpus digest/,
    ],
    [
      'missing deployment SHA',
      compatibleReader({ manifest: { deploymentSha: undefined } }),
      /deploymentSha/,
    ],
    [
      'wrong deployment SHA',
      compatibleReader({ manifest: { deploymentSha: 'f'.repeat(40) } }),
      /deployment SHA/,
    ],
  ])('fails closed on %s', async (_name, reader, message) => {
    await expectProbeFailure(reader, message);
  });

  test('fails when the document page source anchor is not the canonical source URL', async () => {
    const pages = compatibleReader().pages;
    const documentFixture = fixedCases[0];
    pages.set(
      `/d/${documentFixture.token}`,
      htmlFor(documentFixture, {
        sourceHref:
          'https://github.com/inkeep/open-knowledge/blob/main/modules/backend-libraries.md',
      }),
    );
    await expectProbeFailure(compatibleReader({ pages }), /source href/);
  });

  test('fails when the content-root page custom handoff is not the exact token-only URI', async () => {
    const pages = compatibleReader().pages;
    const contentRootFixture = fixedCases[1];
    pages.set(
      `/d/${contentRootFixture.token}`,
      htmlFor(contentRootFixture, {
        customSchemeHref: `openknowledge://share?url=${encodeURIComponent(contentRootFixture.sharedUrl)}`,
      }),
    );
    await expectProbeFailure(compatibleReader({ pages }), /custom URI/);
  });

  test('the CLI writes bounded incompatible evidence before exiting non-zero', () => {
    const directory = mkdtempSync(join(tmpdir(), 'share-contract-probe-'));
    const evidencePath = join(directory, 'evidence.json');
    try {
      const result = spawnSync(
        process.execPath,
        [
          join(REPO_ROOT, '.github/scripts/probe-share-contract.mjs'),
          '--origin',
          'http://127.0.0.1:1',
          '--evidence',
          evidencePath,
        ],
        { encoding: 'utf8' },
      );

      expect(result.status).toBe(1);
      expect(JSON.parse(readFileSync(evidencePath, 'utf8'))).toMatchObject({
        status: 'incompatible',
        failure: { code: 'manifest-request-failed' },
      });
      const evidence = readFileSync(evidencePath, 'utf8');
      expect(evidence).not.toContain('127.0.0.1');
      for (const fixture of fixedCases) expect(evidence).not.toContain(fixture.token);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
