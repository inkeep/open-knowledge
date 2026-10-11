import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DocumentReadSuccessSchema,
  MetricsWatcherRecentSuccessSchema,
  PageHeadingsSuccessSchema,
} from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  createTestClient,
  createTestServer,
  HARNESS_BOOT_TIMEOUT_MS,
  pollUntil,
  type TestServer,
} from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

test('persists an accepted replacement at a recreated path after an external move', async () => {
  const originalName = `original-${randomUUID()}`;
  const destinationName = `destination-${randomUUID()}`;
  const originalPath = join(server.contentDir, `${originalName}.md`);
  const destinationPath = join(server.contentDir, `${destinationName}.md`);
  const original = '# Original first\n\nOriginal body.\n\n## Original second\n';
  const replacement = '# Recreated first\n\nNew body.\n\n## Recreated second\n';

  writeFileSync(originalPath, original, { encoding: 'utf-8', flag: 'wx' });
  await pollUntil(
    async () => {
      const response = await fetch(`${server.baseUrl}/api/metrics/watcher-recent`);
      expect(response.status).toBe(200);
      const { decisions } = MetricsWatcherRecentSuccessSchema.parse(await response.json());
      return decisions.some(
        (decision) =>
          decision.decision === 'dispatched' &&
          decision.kind === 'create' &&
          decision['doc.name'].endsWith(`/${originalName}.md`),
      );
    },
    undefined,
    undefined,
    `the native watcher create dispatch for seeded ${originalName}`,
  );

  const client = await createTestClient(server.port, originalName, { resetOnCleanup: false });
  try {
    expect(client.ytext.toString()).toBe(original);
    let closed = false;
    client.provider.on('close', () => {
      closed = true;
    });

    renameSync(originalPath, destinationPath);
    await pollUntil(
      () =>
        closed &&
        server.instance.hocuspocus.documents
          .get(originalName)
          ?.getMap('lifecycle')
          .get('status') === 'renamed',
      undefined,
      undefined,
      `the client close and renamed lifecycle after the external move of ${originalName}`,
    );
    expect(existsSync(originalPath)).toBe(false);
    expect(readFileSync(destinationPath, 'utf-8')).toBe(original);
  } finally {
    await client.cleanup();
  }

  const created = await fetch(`${server.baseUrl}/api/create-page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: `${originalName}.md` }),
  });
  expect(created.status).toBe(200);
  expect(await created.json()).toMatchObject({ docName: originalName });
  expect(readFileSync(originalPath, 'utf-8')).toBe('');

  const written = await fetch(`${server.baseUrl}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      docName: originalName,
      markdown: replacement,
      position: 'replace',
      agentId: `writer-${randomUUID()}`,
    }),
  });
  expect(written.status).toBe(200);

  const recreatedDisk = readFileSync(originalPath, 'utf-8');
  const destinationDisk = readFileSync(destinationPath, 'utf-8');
  const liveResponse = await fetch(`${server.baseUrl}/api/document?docName=${originalName}`);
  expect(liveResponse.status).toBe(200);
  const live = DocumentReadSuccessSchema.parse(await liveResponse.json());
  const headingsResponse = await fetch(
    `${server.baseUrl}/api/page-headings?docName=${originalName}`,
  );
  expect(headingsResponse.status).toBe(200);
  const { headings } = PageHeadingsSuccessSchema.parse(await headingsResponse.json());

  expect({
    live: live.content,
    recreatedDisk,
    destinationDisk,
    headings: headings.map(({ text }) => text),
  }).toEqual({
    live: replacement,
    recreatedDisk: replacement,
    destinationDisk: original,
    headings: ['Recreated first', 'Recreated second'],
  });
});
