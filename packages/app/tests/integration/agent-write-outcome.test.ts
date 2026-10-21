import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_WRITE_NEXT_STEPS, AGENT_WRITE_OUTCOMES } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createWatcherDouble } from '../../../server/src/watcher-double.test-helper';
import {
  agentWriteMd,
  createTestClient,
  createTestServer,
  pollUntil,
  type TestClient,
  type TestServer,
} from './test-harness';

const SEED = '# Doc\n\nfirst paragraph\n\nsecond paragraph\n';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  delete process.env.OK_TEST_COMPARE_READ_FAULT;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

async function boot(): Promise<TestServer> {
  const server = await createTestServer({
    gitEnabled: true,
    watcherBackend: createWatcherDouble().backend,
    debounce: 300_000,
    maxDebounce: 600_000,
  });
  cleanups.push(() => server.cleanup());
  return server;
}

async function open(server: TestServer, docName: string): Promise<TestClient> {
  const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
  cleanups.push(() => client.cleanup());
  return client;
}

async function seedAndOpen(
  server: TestServer,
  docName: string,
): Promise<{ client: TestClient; file: string }> {
  const file = join(server.contentDir, `${docName}.md`);
  await agentWriteMd(server.port, SEED, { docName, position: 'replace' });
  await pollUntil(() => existsSync(file) && readFileSync(file, 'utf-8') === SEED, 10_000, 25);
  const client = await open(server, docName);
  await pollUntil(() => client.ytext.toString() === SEED, 10_000, 25, 'the client to load');
  return { client, file };
}

async function post(server: TestServer, path: string, body: unknown): Promise<Answer> {
  const response = await fetch(`${server.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function append(server: TestServer, docName: string, markdown: string): Promise<Answer> {
  return post(server, '/api/agent-write-md', {
    docName,
    markdown,
    position: 'append',
    agentId: 'outcome-agent',
  });
}

function disk(file: string): string | null {
  return existsSync(file) ? readFileSync(file, 'utf-8') : null;
}

function expectInClosedSets(answer: Answer): void {
  expect(AGENT_WRITE_OUTCOMES).toContain(answer.body.outcome);
  expect(AGENT_WRITE_NEXT_STEPS).toContain(answer.body.nextStep);
  expect(typeof answer.body.saved).toBe('boolean');
}

function liveText(server: TestServer, docName: string): string {
  return server.instance.hocuspocus.documents.get(docName)?.getText('source').toString() ?? '';
}

describe('every agent write answers its outcome, whether it is saved, and the next step', () => {
  test('a plain write is applied and saved, with nothing further to do', async () => {
    const server = await boot();
    const docName = `outcome-applied-${randomUUID()}`;
    const answer = await post(server, '/api/agent-write-md', {
      docName,
      markdown: '# Applied\n\nAlpha.\n',
      position: 'replace',
      agentId: 'outcome-agent',
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ outcome: 'applied', saved: true, nextStep: 'none' });
    expectInClosedSets(answer);
    expect(disk(join(server.contentDir, `${docName}.md`))).toBe('# Applied\n\nAlpha.\n');
  }, 60_000);

  test('a write over an outside edit to another block is merged first, saved, and asks for a re-read', async () => {
    const server = await boot();
    const docName = `outcome-merged-${randomUUID()}`;
    const { file } = await seedAndOpen(server, docName);
    writeFileSync(file, '# Doc\n\nfirst paragraph\n\nsecond paragraph, edited outside\n');

    const answer = await append(server, docName, '\nagent line\n');
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      outcome: 'merged-first',
      saved: true,
      nextStep: 're-read',
    });
    expectInClosedSets(answer);
    expect(disk(file)).toContain('edited outside');
    expect(disk(file)).toContain('agent line');
  }, 60_000);

  test('a write over a block changed here and outside keeps both, is saved, and a re-read returns both versions', async () => {
    const server = await boot();
    const docName = `outcome-both-${randomUUID()}`;
    const { client, file } = await seedAndOpen(server, docName);
    client.doc.transact(() => {
      const at = client.ytext.toString().indexOf('first paragraph');
      client.ytext.insert(at + 'first paragraph'.length, ', edited here');
    });
    await pollUntil(() => liveText(server, docName).includes('edited here'));
    writeFileSync(file, '# Doc\n\nfirst paragraph, edited outside\n\nsecond paragraph\n');

    const answer = await append(server, docName, '\nagent line\n');
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({
      type: 'urn:ok:error:both-kept',
      outcome: 'both-kept',
      saved: true,
      nextStep: 're-read',
    });
    expectInClosedSets(answer);
    expect(String(answer.body.detail)).toContain('do not retry it');
    expect(disk(file)).toContain('agent line');

    const reread = await fetch(
      `${server.baseUrl}/api/document?docName=${encodeURIComponent(docName)}`,
    );
    const { content } = (await reread.json()) as { content: string };
    expect(content).toContain('first paragraph, edited here');
    expect(content).toContain('first paragraph, edited outside');
  }, 60_000);

  test('a replace refused by a recent edit is not saved and says to retry', async () => {
    const server = await boot();
    const docName = `outcome-refused-${randomUUID()}`;
    const { client, file } = await seedAndOpen(server, docName);
    client.doc.transact(() => {
      client.ytext.insert(client.ytext.length, '\ntyped by a person\n');
    });
    await pollUntil(() => liveText(server, docName).includes('typed by a person'));

    const answer = await post(server, '/api/agent-write-md', {
      docName,
      markdown: '# Replacement\n',
      position: 'replace',
      agentId: 'outcome-agent',
    });
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ outcome: 'refused', saved: false, nextStep: 'retry' });
    expectInClosedSets(answer);
    expect(disk(file)).not.toContain('Replacement');
  }, 60_000);

  test('a write whose save is held is in the document, not saved, and asks for a re-read', async () => {
    const server = await boot();
    const docName = `outcome-held-${randomUUID()}`;
    const { file } = await seedAndOpen(server, docName);
    process.env.OK_TEST_COMPARE_READ_FAULT = `${docName}:EBUSY:1000`;

    const answer = await append(server, docName, '\nagent line\n');
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({
      type: 'urn:ok:error:save-held',
      outcome: 'projection-held',
      saved: false,
      nextStep: 're-read',
    });
    expectInClosedSets(answer);
    expect(disk(file)).toBe(SEED);
    expect(liveText(server, docName)).toContain('agent line');
  }, 60_000);
});

describe('what each refusal and each kind of document reports', () => {
  test('a patch to a path with no document is refused with retry, to send again at the right path', async () => {
    const server = await boot();
    const answer = await post(server, '/api/agent-patch', {
      docName: `outcome-missing-${randomUUID()}`,
      find: 'a',
      replace: 'b',
      agentId: 'outcome-agent',
    });
    expect(answer.status).toBe(404);
    expect(answer.body).toMatchObject({
      type: 'urn:ok:error:doc-not-found',
      outcome: 'refused',
      saved: false,
      nextStep: 'retry',
    });
  }, 60_000);

  test('a write to a Mermaid document, and its undo, carry no outcome until the save reports back', async () => {
    const server = await boot();
    const docName = `diagrams/outcome-${randomUUID()}.mmd`;
    const file = join(server.contentDir, docName);
    mkdirSync(join(server.contentDir, 'diagrams'), { recursive: true });
    writeFileSync(file, 'graph TD\n  A-->B\n');
    const answer = await post(server, '/api/agent-write-md', {
      docName,
      markdown: 'graph TD\n  A-->C\n',
      position: 'replace',
      agentId: 'outcome-agent',
    });
    expect(answer.status).toBe(200);
    expect(answer.body).not.toHaveProperty('outcome');
    expect(answer.body).not.toHaveProperty('saved');
    expect(answer.body).not.toHaveProperty('nextStep');

    const undo = await post(server, '/api/agent-undo', {
      docName,
      connectionId: 'agent-outcome-agent',
      agentId: 'outcome-agent',
    });
    expect(undo.status).toBe(200);
    expect(undo.body).not.toHaveProperty('outcome');
    expect(undo.body).not.toHaveProperty('saved');
  }, 60_000);
});

describe('an agent write whose own save meets an outside change', () => {
  test('is merged first when the save merges a change the pre-write merge read as unchanged', async () => {
    const server = await boot();
    const docName = `outcome-save-merged-${randomUUID()}`;
    const { file } = await seedAndOpen(server, docName);
    writeFileSync(file, '# Doc\n\nfirst paragraph   \n\nsecond paragraph\n');

    const answer = await append(server, docName, '\nagent line\n');
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      outcome: 'merged-first',
      saved: true,
      nextStep: 're-read',
    });
    expect(disk(file)).toBe('# Doc\n\nfirst paragraph   \n\nsecond paragraph\n\nagent line\n');
  }, 60_000);

  test('keeps both when the save finds the edited block also changed outside', async () => {
    const server = await boot();
    const docName = `outcome-save-both-${randomUUID()}`;
    const { file } = await seedAndOpen(server, docName);
    writeFileSync(file, '# Doc\n\nfirst paragraph   \n\nsecond paragraph\n');

    const answer = await post(server, '/api/agent-patch', {
      docName,
      find: 'first paragraph',
      replace: 'first paragraph, edited by the agent',
      agentId: 'outcome-agent',
    });
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({
      type: 'urn:ok:error:both-kept',
      outcome: 'both-kept',
      saved: true,
      nextStep: 're-read',
    });
    expect(disk(file)).toContain('first paragraph, edited by the agent');
  }, 60_000);

  test('is refused, not saved, when the file replaced a document that had no agreed version', async () => {
    const server = await boot();
    const docName = `outcome-replaced-${randomUUID()}`;
    const file = join(server.contentDir, `${docName}.md`);
    await open(server, docName);
    writeFileSync(file, '# From another tool\n');

    const answer = await append(server, docName, '\nagent line\n');
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({
      type: 'urn:ok:error:write-replaced',
      outcome: 'refused',
      saved: false,
      nextStep: 're-read',
    });
    expect(disk(file)).toBe('# From another tool\n');
  }, 60_000);
});

describe('a held save on a document with no agreed version', () => {
  test('is refused with the replace-on-next-write rule only when a file is there to take over', async () => {
    const server = await boot();
    const withFile = `outcome-nobase-file-${randomUUID()}`;
    await open(server, withFile);
    writeFileSync(join(server.contentDir, `${withFile}.md`), '# From another tool\n');
    process.env.OK_TEST_COMPARE_READ_FAULT = `${withFile}:EBUSY:1000`;
    const refused = await append(server, withFile, '\nagent line\n');
    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({ outcome: 'refused', saved: false, nextStep: 'none' });
    expect(String(refused.body.detail)).toContain('replaces the document with the file on disk');

    const noFile = `outcome-nobase-new-${randomUUID()}`;
    await open(server, noFile);
    process.env.OK_TEST_COMPARE_READ_FAULT = `${noFile}:EBUSY:1000`;
    const held = await append(server, noFile, '\nagent line\n');
    expect(held.status).toBe(503);
    expect(held.body).toMatchObject({ outcome: 'projection-held', saved: false });
    expect(String(held.body.detail)).not.toContain('replaces the document with the file on disk');
  }, 60_000);
});

describe('a rename outside the app of a document nobody has open', () => {
  test('leaves no rename-carry record once it settles', async () => {
    const double = createWatcherDouble();
    const server = await createTestServer({ watcherBackend: double.backend });
    cleanups.push(() => server.cleanup());
    const pages = async (): Promise<string> =>
      JSON.stringify(await (await fetch(`${server.baseUrl}/api/pages`)).json());
    const docName = `outcome-unopened-${randomUUID()}`;
    const file = join(server.contentDir, `${docName}.md`);
    writeFileSync(file, SEED);
    double.subscriptionFor(server.contentDir).deliver([{ type: 'create', path: file }]);
    await pollUntil(async () => (await pages()).includes(docName), 10_000, 25, 'the new file');
    expect(server.instance.hocuspocus.documents.has(docName)).toBe(false);
    const carries = vi.spyOn(server.instance.durabilityState, 'beginRenameCarry');
    cleanups.push(() => carries.mockRestore());

    const moved = join(server.contentDir, `${docName}-moved.md`);
    renameSync(file, moved);
    double.subscriptionFor(server.contentDir).deliver([
      { type: 'delete', path: file },
      { type: 'create', path: moved },
    ]);
    await pollUntil(
      async () => (await pages()).includes(`${docName}-moved`),
      10_000,
      25,
      'the move to be followed',
    );
    expect(carries).toHaveBeenCalledWith(docName);
    expect(server.instance.durabilityState.renameCarryOf(docName)).toBeUndefined();
  }, 60_000);
});
