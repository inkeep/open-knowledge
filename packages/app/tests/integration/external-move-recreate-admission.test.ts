import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DocumentReadSuccessSchema,
  DuplicatePathSuccessSchema,
  MetricsReconciliationSuccessSchema,
  MetricsWatcherRecentSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  createTestClient,
  createTestServer,
  HARNESS_BOOT_TIMEOUT_MS,
  pollUntil,
  type TestServer,
} from './test-harness';

const ORIGINAL = '# Former occupant\n\nContent before the move.\n';
const COPIED = '# Copied source\n\nContent from the source.\n';

let server: TestServer;

beforeEach(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterEach(async () => {
  await server.cleanup();
});

async function watcherDispatchCount(kind: string, pathSuffix: string): Promise<number> {
  const response = await fetch(`${server.baseUrl}/api/metrics/watcher-recent`);
  expect(response.status).toBe(200);
  const { decisions } = MetricsWatcherRecentSuccessSchema.parse(await response.json());
  return decisions.filter(
    (decision) =>
      decision.decision === 'dispatched' &&
      decision.kind === kind &&
      decision['doc.name'].endsWith(`/${pathSuffix}`),
  ).length;
}

async function watcherCreateCount(docName: string): Promise<number> {
  return watcherDispatchCount('create', `${docName}.md`);
}

async function seedFile(docName: string, content: string): Promise<string> {
  const path = join(server.contentDir, `${docName}.md`);
  if (!existsSync(dirname(path))) {
    const folder = dirname(docName);
    mkdirSync(dirname(path));
    await pollUntil(
      async () => (await watcherDispatchCount('folder-create', folder)) > 0,
      undefined,
      undefined,
      `the native watcher folder-create dispatch for seeded ${folder}`,
    );
  }
  writeFileSync(path, content, { encoding: 'utf-8', flag: 'wx' });
  await pollUntil(
    async () => (await watcherCreateCount(docName)) > 0,
    undefined,
    undefined,
    `the native watcher create dispatch for seeded ${docName}`,
  );
  return path;
}

async function moveLoadedDocument(docName: string): Promise<string> {
  const originalPath = await seedFile(docName, ORIGINAL);
  const destinationPath = join(server.contentDir, `moved-${randomUUID()}.md`);
  const client = await createTestClient(server.port, docName, { resetOnCleanup: false });
  try {
    expect(client.ytext.toString()).toBe(ORIGINAL);
    let closed = false;
    client.provider.on('close', () => {
      closed = true;
    });
    renameSync(originalPath, destinationPath);
    await pollUntil(
      () =>
        closed &&
        server.instance.hocuspocus.documents.get(docName)?.getMap('lifecycle').get('status') ===
          'renamed',
      undefined,
      undefined,
      `the client close and renamed lifecycle after the external move of ${docName}`,
    );
    expect(existsSync(originalPath)).toBe(false);
    expect(readFileSync(destinationPath, 'utf-8')).toBe(ORIGINAL);
  } finally {
    await client.cleanup();
  }
  return destinationPath;
}

async function assertAdmission(
  docName: string,
  content: string,
  destinationPath: string,
): Promise<void> {
  expect(readFileSync(join(server.contentDir, `${docName}.md`), 'utf-8')).toBe(content);
  const response = await fetch(
    `${server.baseUrl}/api/document?docName=${encodeURIComponent(docName)}`,
  );
  expect(response.status).toBe(200);
  const document = DocumentReadSuccessSchema.parse(await response.json());
  expect({
    docName: document.docName,
    content: document.content,
    lifecycle: document.lifecycle,
    movedDisk: readFileSync(destinationPath, 'utf-8'),
  }).toEqual({ docName, content, lifecycle: null, movedDisk: ORIGINAL });
}

test('empty page creation exposes the new content and active lifecycle at a moved path', async () => {
  const docName = `page-${randomUUID()}`;
  const destinationPath = await moveLoadedDocument(docName);
  const response = await fetch(`${server.baseUrl}/api/create-page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: `${docName}.md` }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ docName });
  await assertAdmission(docName, '', destinationPath);
});

test('file duplication exposes copied content and active lifecycle at its reused path', async () => {
  const source = `source-${randomUUID()}`;
  await seedFile(source, COPIED);
  const docName = `${source} copy`;
  const destinationPath = await moveLoadedDocument(docName);
  const response = await fetch(`${server.baseUrl}/api/duplicate-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'file', path: `${source}.md` }),
  });
  expect(response.status).toBe(200);
  const duplicate = DuplicatePathSuccessSchema.parse(await response.json());
  expect(duplicate).toEqual({ kind: 'file', path: docName, duplicatedDocNames: [docName] });
  await assertAdmission(duplicate.path, COPIED, destinationPath);
});

test('folder duplication exposes copied child content and active lifecycle at its reused path', async () => {
  const folder = `folder-${randomUUID()}`;
  await seedFile(`${folder}/entry`, COPIED);
  const docName = `${folder} copy/entry`;
  const destinationPath = await moveLoadedDocument(docName);
  rmdirSync(join(server.contentDir, `${folder} copy`));
  const response = await fetch(`${server.baseUrl}/api/duplicate-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'folder', path: folder }),
  });
  expect(response.status).toBe(200);
  const duplicate = DuplicatePathSuccessSchema.parse(await response.json());
  expect(duplicate.kind).toBe('folder');
  expect(duplicate.path).toBe(`${folder} copy`);
  const child = `${duplicate.path}/entry`;
  expect(duplicate.duplicatedDocNames).toContain(child);
  expect(child).toBe(docName);
  await assertAdmission(child, COPIED, destinationPath);
});

async function removedDocumentCount(): Promise<unknown> {
  const response = await fetch(`${server.baseUrl}/api/metrics/reconciliation`);
  expect(response.status).toBe(200);
  const metrics = MetricsReconciliationSuccessSchema.parse(await response.json());
  return metrics.recentlyRemovedDocsSize;
}

test('native recreation exposes its new content and active lifecycle after watcher admission', async () => {
  const docName = `native-${randomUUID()}`;
  const destinationPath = await moveLoadedDocument(docName);
  expect(await removedDocumentCount()).toBe(1);
  const seedCreateCount = await watcherCreateCount(docName);
  const content = '# Recreated externally\n\nContent from the new file.\n';
  writeFileSync(join(server.contentDir, `${docName}.md`), content, {
    encoding: 'utf-8',
    flag: 'wx',
  });
  await pollUntil(
    async () => (await watcherCreateCount(docName)) > seedCreateCount,
    undefined,
    undefined,
    `the native watcher create dispatch for recreated ${docName}`,
  );
  await pollUntil(
    async () => (await removedDocumentCount()) === 0,
    undefined,
    undefined,
    `the removed-document marker for ${docName} to clear`,
  );
  await assertAdmission(docName, content, destinationPath);
});
