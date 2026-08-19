#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FIXED_PROBE_CASE_IDS = ['v2-one-segment-document', 'v2-one-segment-content-root'];

const REQUIRED_EPOCH = 2;
const MANIFEST_PATH = '/.well-known/openknowledge-share-contract.json';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DEPLOYMENT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const REQUEST_TIMEOUT_MS = 15_000;

class ShareContractProbeError extends Error {
  constructor(code, message, evidence) {
    super(message);
    this.name = 'ShareContractProbeError';
    this.code = code;
    this.evidence = evidence;
  }
}

export function computeCorpusSha256(corpusBytes) {
  return createHash('sha256').update(corpusBytes).digest('hex');
}

function incompatibleEvidence(now, failure, manifest = {}) {
  return {
    status: 'incompatible',
    checkedAt: now().toISOString(),
    ...(Number.isInteger(manifest.epoch) ? { epoch: manifest.epoch } : {}),
    ...(typeof manifest.corpusSha256 === 'string' ? { corpusSha256: manifest.corpusSha256 } : {}),
    ...(typeof manifest.deploymentSha === 'string'
      ? { deploymentSha: manifest.deploymentSha }
      : {}),
    failure,
  };
}

function fail(code, message, now, manifest, probeId) {
  throw new ShareContractProbeError(
    code,
    message,
    incompatibleEvidence(
      now,
      {
        code,
        ...(probeId === undefined ? {} : { probeId }),
      },
      manifest,
    ),
  );
}

function normalizeOrigin(origin) {
  const candidate = /^[A-Za-z][A-Za-z\d+.-]*:/.test(origin) ? origin : `https://${origin}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('origin must be an absolute HTTP(S) URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('origin must use HTTP(S)');
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error('origin must not contain credentials, a query, or a fragment');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.href.replace(/\/$/, '');
}

function findFixedFixtures(corpus, now) {
  if (!corpus || typeof corpus !== 'object' || !Array.isArray(corpus.validShares)) {
    fail('corpus-malformed', 'fixture corpus has no validShares array', now);
  }

  return FIXED_PROBE_CASE_IDS.map((id) => {
    const matches = corpus.validShares.filter((fixture) => fixture?.id === id);
    if (matches.length !== 1) {
      fail('corpus-fixed-probe-missing', `fixture corpus must contain exactly one ${id}`, now);
    }
    const fixture = matches[0];
    if (
      fixture.version !== 2 ||
      typeof fixture.sharedUrl !== 'string' ||
      typeof fixture.token !== 'string' ||
      fixture.token.length === 0
    ) {
      fail('corpus-fixed-probe-malformed', `fixed probe fixture ${id} is malformed`, now);
    }
    return fixture;
  });
}

async function fetchWithTimeout(fetchImpl, url) {
  return fetchImpl(url, {
    headers: { accept: 'application/json, text/html;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

// Retry once on a network-level failure (fetch rejects — DNS, connection reset,
// or the request-timeout AbortError) so a single CDN blip at the cron mark does
// not page on-call for a fault that self-resolves next run. A non-ok HTTP
// response does NOT reject, so 4xx/5xx stay immediate failures — only transport
// faults retry.
async function fetchWithRetry(fetchImpl, url) {
  try {
    return await fetchWithTimeout(fetchImpl, url);
  } catch {
    return fetchWithTimeout(fetchImpl, url);
  }
}

async function readManifest(fetchImpl, origin, now) {
  let response;
  try {
    response = await fetchWithRetry(fetchImpl, `${origin}${MANIFEST_PATH}`);
  } catch {
    fail('manifest-request-failed', 'manifest request failed', now);
  }
  if (!response.ok) {
    fail('manifest-http-status', `manifest request returned ${response.status}`, now);
  }

  let raw;
  try {
    raw = await response.text();
  } catch {
    fail('manifest-read-failed', 'manifest response could not be read', now);
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    fail('manifest-invalid-json', 'manifest is not valid JSON', now);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('manifest-invalid-shape', 'manifest must be a JSON object', now);
  }
  return manifest;
}

function validateManifest(manifest, expectedCorpusSha256, expectedDeploymentSha, now) {
  if (!Number.isInteger(manifest.epoch) || manifest.epoch < REQUIRED_EPOCH) {
    fail('manifest-epoch', `manifest epoch must be at least ${REQUIRED_EPOCH}`, now, manifest);
  }
  if (typeof manifest.corpusSha256 !== 'string' || !SHA256_PATTERN.test(manifest.corpusSha256)) {
    fail('manifest-corpus-digest-shape', 'manifest corpusSha256 is malformed', now, manifest);
  }
  if (manifest.corpusSha256 !== expectedCorpusSha256) {
    fail('manifest-corpus-digest-mismatch', 'manifest corpus digest does not match', now, manifest);
  }
  if (
    typeof manifest.deploymentSha !== 'string' ||
    !DEPLOYMENT_SHA_PATTERN.test(manifest.deploymentSha)
  ) {
    fail('manifest-deployment-sha-shape', 'manifest deploymentSha is malformed', now, manifest);
  }
  if (expectedDeploymentSha !== undefined && manifest.deploymentSha !== expectedDeploymentSha) {
    fail(
      'manifest-deployment-sha-mismatch',
      'manifest deployment SHA does not match',
      now,
      manifest,
    );
  }
}

function decodeHtmlAttribute(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function attribute(tag, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `(?:^|\\s)${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i',
  ).exec(tag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? undefined : decodeHtmlAttribute(value);
}

function anchorHref(html, testId, now, manifest, probeId) {
  const matches = [...html.matchAll(/<a\b[^>]*>/gi)]
    .map((match) => match[0])
    .filter((tag) => attribute(tag, 'data-testid') === testId);
  if (matches.length !== 1) {
    fail(
      'page-anchor-cardinality',
      `probe ${probeId} must render exactly one ${testId} anchor`,
      now,
      manifest,
      probeId,
    );
  }
  const href = attribute(matches[0], 'href');
  if (href === undefined) {
    fail(
      'page-anchor-href-missing',
      `probe ${probeId} ${testId} anchor has no href`,
      now,
      manifest,
      probeId,
    );
  }
  return href;
}

function assertDecodedSplash(html, fixture, manifest, now) {
  if (!/<(?:h1|h2)\b[^>]*data-testid=(?:"splash-filename"|'splash-filename')[^>]*>/i.test(html)) {
    fail(
      'page-decode-result',
      `probe ${fixture.id} did not render the decoded splash`,
      now,
      manifest,
      fixture.id,
    );
  }

  const sourceHref = anchorHref(html, 'splash-repo-path', now, manifest, fixture.id);
  if (sourceHref !== fixture.sharedUrl) {
    fail(
      'page-source-href',
      `probe ${fixture.id} source href is not canonical`,
      now,
      manifest,
      fixture.id,
    );
  }

  const customSchemeHref = anchorHref(html, 'splash-open-cta', now, manifest, fixture.id);
  const expectedCustomSchemeHref = `openknowledge://share?token=${fixture.token}`;
  if (customSchemeHref !== expectedCustomSchemeHref) {
    fail(
      'page-custom-uri',
      `probe ${fixture.id} custom URI is not the exact token-only handoff`,
      now,
      manifest,
      fixture.id,
    );
  }
}

async function probePage(fetchImpl, origin, fixture, manifest, now) {
  let response;
  try {
    response = await fetchWithRetry(fetchImpl, `${origin}/d/${fixture.token}`);
  } catch {
    fail('page-request-failed', `probe ${fixture.id} request failed`, now, manifest, fixture.id);
  }
  if (!response.ok) {
    fail(
      'page-http-status',
      `probe ${fixture.id} request returned ${response.status}`,
      now,
      manifest,
      fixture.id,
    );
  }

  let html;
  try {
    html = await response.text();
  } catch {
    fail(
      'page-read-failed',
      `probe ${fixture.id} response could not be read`,
      now,
      manifest,
      fixture.id,
    );
  }
  assertDecodedSplash(html, fixture, manifest, now);
  return { id: fixture.id, status: 'compatible' };
}

export async function probeShareContract({
  origin,
  corpus,
  corpusBytes,
  expectedDeploymentSha,
  fetchImpl = fetch,
  now = () => new Date(),
}) {
  const normalizedOrigin = normalizeOrigin(origin);
  const fixtures = findFixedFixtures(corpus, now);
  const expectedCorpusSha256 = computeCorpusSha256(corpusBytes);
  const manifest = await readManifest(fetchImpl, normalizedOrigin, now);
  validateManifest(manifest, expectedCorpusSha256, expectedDeploymentSha, now);

  const probes = [];
  for (const fixture of fixtures) {
    probes.push(await probePage(fetchImpl, normalizedOrigin, fixture, manifest, now));
  }

  return {
    status: 'compatible',
    checkedAt: now().toISOString(),
    epoch: manifest.epoch,
    corpusSha256: manifest.corpusSha256,
    deploymentSha: manifest.deploymentSha,
    probes,
  };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`invalid argument near ${key ?? '<end>'}`);
    }
    if (values.has(key)) throw new Error(`duplicate argument ${key}`);
    values.set(key, value);
  }

  const allowed = new Set(['--origin', '--corpus', '--expected-deployment-sha', '--evidence']);
  for (const key of values.keys()) {
    if (!allowed.has(key)) throw new Error(`unknown argument ${key}`);
  }
  if (!values.has('--origin')) throw new Error('--origin is required');
  if (!values.has('--evidence')) throw new Error('--evidence is required');
  return values;
}

function writeEvidence(path, evidence) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
}

async function main() {
  const values = parseArgs(process.argv.slice(2));
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const corpusPath = resolve(
    values.get('--corpus') ??
      join(scriptDirectory, '../../test-support/fixtures/share-url-v1-v2.json'),
  );
  const evidencePath = resolve(values.get('--evidence'));
  const now = () => new Date();

  try {
    const corpusBytes = readFileSync(corpusPath, 'utf8');
    const corpus = JSON.parse(corpusBytes);
    const evidence = await probeShareContract({
      origin: values.get('--origin'),
      corpus,
      corpusBytes,
      expectedDeploymentSha: values.get('--expected-deployment-sha'),
      now,
    });
    writeEvidence(evidencePath, evidence);
    console.log(
      `share-contract probe compatible: epoch=${evidence.epoch} deployment=${evidence.deploymentSha}`,
    );
  } catch (error) {
    const evidence =
      error instanceof ShareContractProbeError
        ? error.evidence
        : incompatibleEvidence(now, { code: 'probe-internal-error' });
    writeEvidence(evidencePath, evidence);
    const message = error instanceof Error ? error.message : 'unknown probe failure';
    console.error(`share-contract probe incompatible: ${message}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  await main();
}
