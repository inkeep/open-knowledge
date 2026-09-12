import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentWriteBatchSuccessSchema, ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import { writeTracker } from '../../../server/src/file-watcher';
import { contentHash } from '../../../server/src/version-hash';
import {
  agentWriteMd,
  createTestServer,
  getServerState,
  pollUntil,
  type TestServer,
} from './test-harness';

const APPLIED_MARKER = 'applied-before-final-disk-read';
let server: TestServer | undefined;
let projectDir: string | undefined;

afterEach(async () => {
  await server?.cleanup();
  server = undefined;
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  projectDir = undefined;
});

async function prepareRace(extension: '.md' | '.mdx') {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-stale-http-')));
  const contentDir = join(projectDir, 'notes');
  mkdirSync(contentDir);
  const docName = `race-${randomUUID()}`;
  const file = `${docName}${extension}`;
  const path = join(contentDir, file);
  writeFileSync(path, '# Original\n\noriginal-body\n');
  const target = await createTestServer({ contentDir, projectDir, debounce: 50, maxDebounce: 200 });
  server = target;
  const stale = readFileSync(path, 'utf-8');
  await agentWriteMd(target.port, 'acknowledged-body\n', { docName, position: 'append' });
  await pollUntil(
    () => !writeTracker.get(path)?.some((entry) => entry.hash === contentHash(stale)),
  );
  const source = getServerState(target, docName)?.ytext;
  if (!source) throw new Error('Expected a loaded document after the acknowledged write');
  const restoreAfterEdit = () => {
    if (!source.toString().includes(APPLIED_MARKER)) return;
    source.unobserve(restoreAfterEdit);
    writeFileSync(path, stale);
  };
  source.observe(restoreAfterEdit);
  return { target, docName, file: `notes/${file}`, path, stale, source };
}

function expectRetainedEdit(race: Awaited<ReturnType<typeof prepareRace>>): void {
  expect(readFileSync(race.path, 'utf-8')).toBe(race.stale);
  expect(race.source.toString()).toContain(APPLIED_MARKER);
  expect(race.source.toString()).toContain('acknowledged-body');
  expect(
    race.target.instance.durabilityState.getStaleExternalWrite(race.docName)?.retainedContent,
  ).toBe(race.source.toString());
  expect(
    readFileSync(join(race.target.instance.lockDir, 'stale-external-writes.json'), 'utf-8'),
  ).toContain(APPLIED_MARKER);
}

function expectStaleDetails(error: unknown, file: string): void {
  expect(error).toMatchObject({
    type: 'urn:ok:error:stale-external-write',
    title: 'Edit retained; disk write blocked by a stale external-write conflict.',
    detail: expect.stringContaining('recovery snapshot'),
    file,
    resolutionOptions: ['mine', 'theirs', 'content', 'delete'],
  });
  expect(error).toMatchObject({ detail: expect.stringContaining('Do not repeat this edit') });
}

describe('stale external write discovered by the final HTTP disk flush', () => {
  test.each(['.md', '.mdx'] as const)(
    'single write returns actionable conflict details for %s',
    async (extension) => {
      const race = await prepareRace(extension);
      const response = await fetch(`${race.target.baseUrl}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          docName: race.docName,
          markdown: `${APPLIED_MARKER}\n`,
          position: 'append',
        }),
      });
      expect(response.status).toBe(409);
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      const body: unknown = await response.json();
      expect(ProblemDetailsSchema.safeParse(body).success).toBe(true);
      expectStaleDetails(body, race.file);
      expectRetainedEdit(race);
      const conflicts = await (await fetch(`${race.target.baseUrl}/api/sync/conflicts`)).json();
      expect(conflicts.conflicts).toContainEqual(expect.objectContaining({ file: race.file }));
    },
  );

  test('batch retains per-document conflict details and independent successful writes', async () => {
    const race = await prepareRace('.mdx');
    const otherDoc = `other-${randomUUID()}`;
    const response = await fetch(`${race.target.baseUrl}/api/agent-write-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docs: [
          { docName: race.docName, markdown: `${APPLIED_MARKER}\n`, position: 'append' },
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
    if (failed.status !== 'error') throw new Error('Expected the restored document to conflict');
    expectStaleDetails(failed.error, race.file);
    expect(body.results[1]).toMatchObject({ status: 'written', docName: otherDoc });
    expect(readFileSync(join(race.target.contentDir, `${otherDoc}.md`), 'utf-8')).toBe(
      '# Independent\n',
    );
    expectRetainedEdit(race);
  });
});
