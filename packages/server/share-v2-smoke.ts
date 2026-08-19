import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  decodeShareUrl,
  type ShareConstructUrlResponse,
  ShareConstructUrlResponseSchema,
} from '@inkeep/open-knowledge-core';
import type { EndpointRig } from './src/share/endpoint-http.test-helper.ts';

type ShareSuccess = Extract<ShareConstructUrlResponse, { ok: true }>;

const CONTENT_ROOT = 'knowledge base/handbook';
const DOCUMENT_PATH = 'guides/getting started.md';
const REPOSITORY_DOCUMENT_PATH = `${CONTENT_ROOT}/${DOCUMENT_PATH}`;
const GITHUB_REPOSITORY = 'https://github.com/inkeep/open-knowledge';

process.env.LOG_LEVEL ??= 'silent';
const [{ bootEndpointServer }, { createGitTriangle }] = await Promise.all([
  import('./src/share/endpoint-http.test-helper.ts'),
  import('./src/share/git-fixture.test-helper.ts'),
]);

async function constructShare(port: number, body: unknown): Promise<ShareSuccess> {
  const response = await fetch(`http://127.0.0.1:${port}/api/share/construct-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, `construct-url returned HTTP ${response.status}`);

  const parsed = ShareConstructUrlResponseSchema.parse(await response.json());
  if (!parsed.ok) assert.fail(`construct-url failed: ${parsed.error}`);
  return parsed;
}

function tokenFromShareUrl(shareUrl: string): string {
  const token = new URL(shareUrl).pathname.split('/').filter(Boolean).at(-1);
  assert.ok(token, `share URL did not contain a token: ${shareUrl}`);
  return token;
}

function printCase(
  label: string,
  result: ShareSuccess,
  decoded: ReturnType<typeof decodeShareUrl>,
): void {
  console.log(`\n${label}`);
  console.log(`  token:      v${decoded.version}`);
  console.log(`  source:     ${result.sharedUrl}`);
  console.log(`  freshness:  ${result.freshness ?? 'unavailable'}`);
  if (decoded.version === 2) {
    console.log(`  root depth: ${decoded.contentRootDepth}`);
    console.log(`  target:     ${JSON.stringify(decoded.target)}`);
  }
}

const triangle = createGitTriangle();
const rigs: EndpointRig[] = [];

try {
  triangle.seedAndPush(REPOSITORY_DOCUMENT_PATH, '# Getting started\n');
  triangle.git(triangle.senderDir, ['remote', 'set-url', 'origin', `${GITHUB_REPOSITORY}.git`]);

  const nestedRig = await bootEndpointServer({
    projectDir: triangle.senderDir,
    contentDir: join(triangle.senderDir, CONTENT_ROOT),
  });
  rigs.push(nestedRig);

  const nestedDocument = await constructShare(nestedRig.port, {
    kind: 'doc',
    docPath: DOCUMENT_PATH,
  });
  const nestedDocumentDecoded = decodeShareUrl(tokenFromShareUrl(nestedDocument.shareUrl));
  assert.deepEqual(nestedDocumentDecoded, {
    version: 2,
    sharedUrl: `${GITHUB_REPOSITORY}/blob/main/knowledge%20base/handbook/guides/getting%20started.md`,
    contentRootDepth: 2,
    source: {
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
      branch: 'main',
      kind: 'doc',
      targetSegments: ['knowledge base', 'handbook', 'guides', 'getting started.md'],
    },
    target: { kind: 'doc', docPath: DOCUMENT_PATH },
  });
  assert.equal(nestedDocument.freshness, 'current');

  const nestedRoot = await constructShare(nestedRig.port, {
    kind: 'folder',
    folderPath: '',
  });
  const nestedRootDecoded = decodeShareUrl(tokenFromShareUrl(nestedRoot.shareUrl));
  assert.deepEqual(nestedRootDecoded, {
    version: 2,
    sharedUrl: `${GITHUB_REPOSITORY}/tree/main/knowledge%20base/handbook`,
    contentRootDepth: 2,
    source: {
      host: 'github.com',
      owner: 'inkeep',
      repo: 'open-knowledge',
      branch: 'main',
      kind: 'folder',
      targetSegments: ['knowledge base', 'handbook'],
    },
    target: { kind: 'folder', folderPath: '' },
  });
  assert.equal(nestedRoot.freshness, 'current');

  const rootRig = await bootEndpointServer({ projectDir: triangle.senderDir });
  rigs.push(rootRig);

  const rootDocument = await constructShare(rootRig.port, {
    kind: 'doc',
    docPath: REPOSITORY_DOCUMENT_PATH,
  });
  const rootDocumentDecoded = decodeShareUrl(tokenFromShareUrl(rootDocument.shareUrl));
  assert.deepEqual(rootDocumentDecoded, {
    version: 1,
    sharedUrl: `${GITHUB_REPOSITORY}/blob/main/knowledge%20base/handbook/guides/getting%20started.md`,
  });
  assert.equal(rootDocument.freshness, 'current');

  console.log('Share v2 smoke passed');
  printCase('Nested content document', nestedDocument, nestedDocumentDecoded);
  printCase('Nested content root', nestedRoot, nestedRootDecoded);
  printCase('Repository-root compatibility', rootDocument, rootDocumentDecoded);
} finally {
  try {
    await Promise.all(rigs.map((rig) => rig.cleanup()));
  } finally {
    triangle.cleanup();
  }
}
