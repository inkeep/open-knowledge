import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentWriteBatchSuccessSchema, ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import { agentWriteMd, createTestServer, type TestServer } from './test-harness';

const DISK_FAULT_CLAIM = 'will be lost if the server restarts';
const DEBOUNCE_OUTLASTS_ROUTE_FLUSH_MS = 2000;
const MAX_DEBOUNCE_OUTLASTS_ROUTE_FLUSH_MS = 8000;

let server: TestServer | undefined;
let projectDir: string | undefined;

afterEach(async () => {
  await server?.cleanup();
  server = undefined;
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  projectDir = undefined;
});

async function prepareRemovedDoc() {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-doc-removed-http-')));
  const contentDir = join(projectDir, 'notes');
  mkdirSync(contentDir);
  const docName = `removed-${randomUUID()}`;
  const path = join(contentDir, `${docName}.md`);
  writeFileSync(path, '# Original\n\noriginal-body\n');
  const target = await createTestServer({
    contentDir,
    projectDir,
    debounce: DEBOUNCE_OUTLASTS_ROUTE_FLUSH_MS,
    maxDebounce: MAX_DEBOUNCE_OUTLASTS_ROUTE_FLUSH_MS,
  });
  server = target;
  await agentWriteMd(target.port, 'acknowledged-body\n', { docName, position: 'append' });
  rmSync(path);
  return { target, docName, path };
}

function expectRemovedDocProblem(problem: unknown): void {
  expect(problem).toMatchObject({
    type: 'urn:ok:error:doc-removed',
    title: 'Edit applied in memory; disk write refused because the document is no longer on disk.',
    detail: expect.stringContaining('Retrying will not help'),
  });
  expect(JSON.stringify(problem)).not.toContain(DISK_FAULT_CLAIM);
}

describe('a write to a document whose file was deleted', () => {
  test('single write is refused as a 409 doc-removed, not a 500 disk fault', async () => {
    const removed = await prepareRemovedDoc();
    const response = await fetch(`${removed.target.baseUrl}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName: removed.docName,
        markdown: 'after-delete\n',
        position: 'append',
      }),
    });
    expect(response.status).toBe(409);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    const raw = await response.text();
    expect(raw).not.toContain(DISK_FAULT_CLAIM);
    const body: unknown = JSON.parse(raw);
    expect(ProblemDetailsSchema.safeParse(body).success).toBe(true);
    expectRemovedDocProblem(body);
    expect(existsSync(removed.path)).toBe(false);
  });

  test('batch entry carries the same refusal while a sibling write still lands', async () => {
    const removed = await prepareRemovedDoc();
    const otherDoc = `other-${randomUUID()}`;
    const response = await fetch(`${removed.target.baseUrl}/api/agent-write-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docs: [
          { docName: removed.docName, markdown: 'after-delete\n', position: 'append' },
          { docName: otherDoc, markdown: '# Independent\n', position: 'replace' },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = AgentWriteBatchSuccessSchema.parse(await response.json());
    expect(body.written).toBe(1);
    expect(body.failed).toBe(1);
    const failed = body.results[0];
    expect(failed.status).toBe('error');
    if (failed.status !== 'error') throw new Error('Expected the removed document to be refused');
    expectRemovedDocProblem(failed.error);
    expect(body.results[1]).toMatchObject({ status: 'written', docName: otherDoc });
    expect(existsSync(removed.path)).toBe(false);
  });
});

describe('a write to a document whose path cannot be resolved', () => {
  test('a symlink cycle at the document path is refused as a 400 path-escape', async () => {
    projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-path-fault-http-')));
    const contentDir = join(projectDir, 'notes');
    mkdirSync(contentDir);
    const docName = `cycle-${randomUUID()}`;
    const path = join(contentDir, `${docName}.md`);
    const other = join(contentDir, `${docName}-loop.md`);
    symlinkSync(other, path);
    symlinkSync(path, other);
    const target = await createTestServer({
      contentDir,
      projectDir,
      debounce: DEBOUNCE_OUTLASTS_ROUTE_FLUSH_MS,
      maxDebounce: MAX_DEBOUNCE_OUTLASTS_ROUTE_FLUSH_MS,
    });
    server = target;

    const response = await fetch(`${target.baseUrl}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, markdown: 'body\n', position: 'append' }),
    });

    expect(response.status).toBe(400);
    const raw = await response.text();
    expect(raw).not.toContain(DISK_FAULT_CLAIM);
    expect(raw).not.toContain(contentDir);
    const body: unknown = JSON.parse(raw);
    expect(ProblemDetailsSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ type: 'urn:ok:error:path-escape' });
  });
});
