import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMetrics } from '@inkeep/open-knowledge-server';
import { afterEach, describe, expect, test } from 'vitest';
import { createTestServer, type TestServer, wait } from './test-harness.ts';

let server: TestServer | undefined;

afterEach(async () => {
  delete process.env.OK_TEST_STORE_FAULT;
  if (server) {
    await server.cleanup();
    server = undefined;
  }
});

async function writeMd(port: number, docName: string, markdown: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docName, markdown, position: 'replace' }),
  });
}

async function pollUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(50);
  }
  return predicate();
}

describe('persistence staleness watchdog (integration)', () => {
  test('re-flushes a doc whose store failed with no retry pending', async () => {
    server = await createTestServer({ stalenessGraceMs: 250, stalenessSweepIntervalMs: 100 });
    const docName = `staleness-rescue-${randomUUID()}`;
    const filePath = join(server.contentDir, `${docName}.md`);
    const forcedBefore = getMetrics().persistenceStalenessForcedStores;
    const detectedBefore = getMetrics().persistenceStalenessDetected;

    process.env.OK_TEST_STORE_FAULT = docName;
    const res = await writeMd(server.port, docName, '# persisted content\n');
    expect(res.status).toBe(507);
    delete process.env.OK_TEST_STORE_FAULT;

    expect(existsSync(filePath)).toBe(false);

    const rescued = await pollUntil(
      () => existsSync(filePath) && readFileSync(filePath, 'utf-8') === '# persisted content\n',
      10_000,
    );
    expect(rescued).toBe(true);
    expect(getMetrics().persistenceStalenessDetected).toBeGreaterThan(detectedBefore);
    expect(getMetrics().persistenceStalenessForcedStores).toBeGreaterThan(forcedBefore);
  });

  test('production-shaped grace window does not fire inside a test run (negative control)', async () => {
    server = await createTestServer();
    const docName = `staleness-control-${randomUUID()}`;
    const filePath = join(server.contentDir, `${docName}.md`);
    const detectedBefore = getMetrics().persistenceStalenessDetected;
    const forcedBefore = getMetrics().persistenceStalenessForcedStores;

    process.env.OK_TEST_STORE_FAULT = docName;
    const res = await writeMd(server.port, docName, '# never flushed here\n');
    expect(res.status).toBe(507);
    delete process.env.OK_TEST_STORE_FAULT;

    await wait(1_500);
    expect(existsSync(filePath)).toBe(false);
    expect(getMetrics().persistenceStalenessDetected).toBe(detectedBefore);
    expect(getMetrics().persistenceStalenessForcedStores).toBe(forcedBefore);
  });

  test('stands down instead of clobbering an external native edit', async () => {
    server = await createTestServer({ stalenessGraceMs: 250, stalenessSweepIntervalMs: 100 });
    const docName = `staleness-external-${randomUUID()}`;
    const filePath = join(server.contentDir, `${docName}.md`);
    const forcedBefore = getMetrics().persistenceStalenessForcedStores;

    const first = await writeMd(server.port, docName, '# version one\n');
    expect(first.status).toBe(200);
    const flushed = await pollUntil(
      () => existsSync(filePath) && readFileSync(filePath, 'utf-8') === '# version one\n',
      10_000,
    );
    expect(flushed).toBe(true);

    const stoodDownBefore = getMetrics().persistenceStalenessStoodDown;
    process.env.OK_TEST_STORE_FAULT = docName;
    const second = await writeMd(server.port, docName, '# version two\n');
    expect(second.status).toBe(507);
    delete process.env.OK_TEST_STORE_FAULT;
    writeFileSync(filePath, '# external native edit\n', 'utf-8');

    const watchdogStoodDown = await pollUntil(
      () => getMetrics().persistenceStalenessStoodDown > stoodDownBefore,
      2_000,
    );
    if (!watchdogStoodDown) {
      const state = await fetch(
        `http://127.0.0.1:${server.port}/api/document?docName=${encodeURIComponent(docName)}`,
      );
      expect(state.ok).toBe(true);
      const watcherReconciled = (await state.text()).includes('external native edit');
      const lifecycle = server.instance.hocuspocus.documents.get(docName)?.getMap('lifecycle');
      const watcherSurfacedConflict =
        lifecycle?.get('status') === 'conflict' &&
        lifecycle.get('reason') === 'merged-with-markers';
      expect(watcherReconciled || watcherSurfacedConflict).toBe(true);
    }

    await wait(500);
    expect(readFileSync(filePath, 'utf-8')).toBe('# external native edit\n');
    expect(getMetrics().persistenceStalenessForcedStores).toBe(forcedBefore);
  });
});
