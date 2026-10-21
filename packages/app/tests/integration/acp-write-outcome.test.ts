import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AcpPermissionStore,
  AcpRegistry,
  AcpThreadManager,
  getLogger,
} from '@inkeep/open-knowledge-server';
import { afterEach, describe, expect, test } from 'vitest';
import { createWatcherDouble } from '../../../server/src/watcher-double.test-helper';
import {
  agentWriteMd,
  createTestClient,
  createTestServer,
  pollUntil,
  type TestServer,
} from './test-harness';

const SEED = '# Doc\n\nAlpha paragraph.\n\nBeta paragraph.\n';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  delete process.env.OK_TEST_COMPARE_READ_FAULT;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface AgentAnswer {
  result?: unknown;
  error?: { code: number; message: string; data?: Record<string, unknown> };
}

interface FileWrite {
  path: string;
  content: string;
}

function applied(outcome = 'applied', nextStep = 'none') {
  return { result: { _meta: { openknowledge: { outcome, saved: true, nextStep } } } };
}

async function boot(contentDir?: string): Promise<TestServer> {
  const server = await createTestServer({
    gitEnabled: true,
    watcherBackend: createWatcherDouble().backend,
    debounce: 300_000,
    maxDebounce: 600_000,
    ...(contentDir === undefined ? {} : { contentDir, keepContentDir: true }),
  });
  cleanups.push(() => server.cleanup());
  return server;
}

function liveText(server: TestServer, docName: string): string {
  return server.instance.hocuspocus.documents.get(docName)?.getText('source').toString() ?? '';
}

async function seedAndOpen(server: TestServer, docName: string) {
  const file = join(server.contentDir, `${docName}.md`);
  await agentWriteMd(server.port, SEED, { docName, position: 'replace' });
  await pollUntil(() => existsSync(file) && readFileSync(file, 'utf-8') === SEED, 10_000, 25);
  const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
  cleanups.push(() => client.cleanup());
  await pollUntil(() => client.ytext.toString() === SEED, 10_000, 25, 'the client to load');
  return { client, file };
}

function writingAgent(localDir: string, writes: readonly FileWrite[], answerFile: string) {
  const agentPath = join(localDir, 'writer.mjs');
  writeFileSync(
    agentPath,
    `import { writeFileSync } from 'node:fs';
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
let nextId = 1000;
const pending = new Map();
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    write({ jsonrpc: '2.0', id, method, params: { sessionId: 'sess-1', ...params } });
  });
async function handlePrompt(msg) {
  const answers = [];
  for (const file of ${JSON.stringify(writes)}) {
    answers.push(await request('fs/write_text_file', file));
  }
  writeFileSync(${JSON.stringify(answerFile)}, JSON.stringify(answers));
  write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    if (msg.method === undefined && msg.id !== undefined && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg.error ? { error: msg.error } : { result: msg.result });
      continue;
    }
    const reply = (result) => write({ jsonrpc: '2.0', id: msg.id, result });
    if (msg.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: {} });
    else if (msg.method === 'session/new') reply({ sessionId: 'sess-1' });
    else if (msg.method === 'session/prompt') handlePrompt(msg);
    else if (msg.id !== undefined) reply({});
  }
});
`,
  );
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([{ id: 'writer', name: 'Writer', command: 'node', args: [agentPath] }]),
  );
}

async function writeThroughAcp(
  server: TestServer,
  writes: readonly FileWrite[],
  beforeClose: (threadId: string) => void = () => {},
): Promise<AgentAnswer[]> {
  const localDir = mkdtempSync(join(tmpdir(), 'acp-write-outcome-'));
  cleanups.push(() => rmSync(localDir, { recursive: true, force: true }));
  const answerFile = join(localDir, 'answers.json');
  writingAgent(localDir, writes, answerFile);
  const log = getLogger('acp-write-outcome-test');
  const manager = new AcpThreadManager({
    contentDir: server.contentDir,
    localDir,
    globalDir: null,
    registry: new AcpRegistry({
      localDir,
      log,
      fetchImpl: (async () => {
        throw new Error('offline test');
      }) as typeof fetch,
    }),
    permissions: new AcpPermissionStore(localDir, log),
    sessionManager: server.instance.sessionManager,
    localApi: server.instance.localApi,
    isExcludedPath: (rel) => server.instance.contentFilter.isExcluded(rel),
    isIgnoredPath: (rel) => server.instance.contentFilter.isPathIgnored(rel),
    log,
    resolveLoginShellPath: async () => null,
  });
  cleanups.push(() => manager.destroy());
  const info = await manager.createThread({ agent: { source: 'custom', id: 'writer' } });
  await manager.subscribe(info.threadId, 0, () => {});
  await pollUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 25, 'ready');
  manager.sendPrompt(info.threadId, 'write the files');
  await pollUntil(() => existsSync(answerFile), 60_000, 25, 'the agent to record its answers');
  beforeClose(info.threadId);
  await manager.closeThread(info.threadId);
  return JSON.parse(readFileSync(answerFile, 'utf-8')) as AgentAnswer[];
}

describe('an in-app agent Markdown write answers with its outcome', () => {
  test('a saved write returns the outcome under _meta, and closing the thread ends its session', async () => {
    const server = await boot();
    const docName = `acp-applied-${randomUUID()}`;
    const file = join(server.contentDir, `${docName}.md`);
    let writer = '';
    let sessionWhileOpen = false;

    const [answer] = await writeThroughAcp(
      server,
      [{ path: file, content: '# Alpha\n\nAlpha paragraph.\n' }],
      (id) => {
        writer = `agent-acp-${id}`;
        sessionWhileOpen = server.instance.sessionManager.hasSession(docName, writer);
      },
    );

    expect(answer).toEqual(applied());
    expect(readFileSync(file, 'utf-8')).toBe('# Alpha\n\nAlpha paragraph.\n');
    expect(sessionWhileOpen).toBe(true);
    expect(server.instance.sessionManager.hasSession(docName, writer)).toBe(false);
  }, 90_000);

  test('a replace refused by a recent edit keeps code -32009 and names the outcome', async () => {
    const server = await boot();
    const docName = `acp-refused-${randomUUID()}`;
    const { client, file } = await seedAndOpen(server, docName);
    client.doc.transact(() => {
      client.ytext.insert(client.ytext.length, '\ntyped by a person\n');
    });
    await pollUntil(() => liveText(server, docName).includes('typed by a person'));

    const [answer] = await writeThroughAcp(server, [{ path: file, content: '# Replacement\n' }]);

    expect(answer?.error?.code).toBe(-32009);
    expect(answer?.error?.data).toMatchObject({
      type: 'urn:ok:error:concurrent-overwrite-refused',
      retryable: true,
      outcome: 'refused',
      saved: false,
      nextStep: 'retry',
    });
    expect(readFileSync(file, 'utf-8')).not.toContain('Replacement');
  }, 90_000);

  test('a write whose save is held returns code -32010 with projection-held, not success', async () => {
    const server = await boot();
    const docName = `acp-held-${randomUUID()}`;
    const { file } = await seedAndOpen(server, docName);
    process.env.OK_TEST_COMPARE_READ_FAULT = `${docName}:EBUSY:1000`;

    const [answer] = await writeThroughAcp(server, [
      { path: file, content: `${SEED}\nAgent line.\n` },
    ]);

    expect(answer?.error?.code).toBe(-32010);
    expect(answer?.error?.message).toContain('Do not repeat this write');
    expect(answer?.error?.data).toEqual({
      type: 'urn:ok:error:save-held',
      file: `${docName}.md`,
      outcome: 'projection-held',
      saved: false,
      nextStep: 're-read',
    });
    expect(readFileSync(file, 'utf-8')).toBe(SEED);
  }, 90_000);

  test('a whole-file write over unsaved edits and an outside change keeps all three and answers merged-first', async () => {
    const server = await boot();
    const docName = `acp-merge-${randomUUID()}`;
    const { client, file } = await seedAndOpen(server, docName);
    client.doc.transact(() => {
      const at = client.ytext.toString().indexOf('Alpha paragraph.');
      client.ytext.insert(at + 'Alpha paragraph.'.length, ' Typed here.');
    });
    await pollUntil(() => liveText(server, docName).includes('Typed here.'));
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    writeFileSync(file, '# Doc\n\nAlpha paragraph.\n\nBeta paragraph. Changed outside.\n');

    const [answer] = await writeThroughAcp(server, [
      { path: file, content: `${liveText(server, docName)}\nAgent line.\n` },
    ]);

    expect(answer).toEqual(applied('merged-first', 're-read'));
    const saved = readFileSync(file, 'utf-8');
    expect(saved).toContain('Alpha paragraph. Typed here.');
    expect(saved).toContain('Beta paragraph. Changed outside.');
    expect(saved).toContain('Agent line.');
    expect(liveText(server, docName)).toBe(saved);
  }, 90_000);

  test('a document that already holds a control character can still be edited', async () => {
    const server = await boot();
    const docName = `acp-control-${randomUUID()}`;
    const file = join(server.contentDir, `${docName}.md`);
    const pasted = '# Log\n\n\u001b[31mred\u001b[0m output\n';
    writeFileSync(file, pasted);

    const [answer] = await writeThroughAcp(server, [
      { path: file, content: `${pasted}\nAgent line.\n` },
    ]);

    expect(answer).toEqual(applied());
    expect(readFileSync(file, 'utf-8')).toBe(`${pasted}\nAgent line.\n`);
  }, 90_000);
});

describe('an in-app agent write to a document under a dot folder', () => {
  test('writes and edits a project skill under .claude/skills', async () => {
    const contentDir = mkdtempSync(join(tmpdir(), 'acp-skill-content-'));
    cleanups.push(() => rmSync(contentDir, { recursive: true, force: true }));
    const skillDir = join(contentDir, '.claude', 'skills', 'acp-skill');
    mkdirSync(skillDir, { recursive: true });
    const file = join(skillDir, 'SKILL.md');
    const original = '---\nname: acp-skill\ndescription: Use when testing.\n---\n\n# Skill\n';
    writeFileSync(file, original);
    const server = await boot(contentDir);

    const written = `${original}\nFirst step.\n`;
    const edited = `${original}\nFirst step, edited.\n`;
    const answers = await writeThroughAcp(server, [
      { path: file, content: written },
      { path: file, content: edited },
    ]);

    expect(answers).toEqual([applied(), applied()]);
    expect(readFileSync(file, 'utf-8')).toBe(edited);
  }, 90_000);

  test('writes and edits a folder template', async () => {
    const server = await boot();
    const file = join(server.contentDir, 'meetings', '.ok', 'templates', 'weekly.md');

    const answers = await writeThroughAcp(server, [
      { path: file, content: '# Weekly\n\nAgenda.\n' },
      { path: file, content: '# Weekly\n\nAgenda and notes.\n' },
    ]);

    expect(answers).toEqual([applied(), applied()]);
    expect(readFileSync(file, 'utf-8')).toBe('# Weekly\n\nAgenda and notes.\n');
  }, 90_000);
});

describe('an in-app agent write that is not Markdown', () => {
  test('saves a Mermaid file through its document, and is merged first after an outside change', async () => {
    const server = await boot();
    const file = join(server.contentDir, `flow-${randomUUID()}.mmd`);
    const [first] = await writeThroughAcp(server, [{ path: file, content: 'graph TD\n  A-->B\n' }]);
    expect(first).toEqual(applied());
    writeFileSync(file, 'graph TD\n  A-->Outside\n');
    await new Promise((resolve) => setTimeout(resolve, 2_100));

    const [second] = await writeThroughAcp(server, [
      { path: file, content: 'graph TD\n  A-->Agent\n' },
    ]);

    expect(second).toEqual(applied('merged-first', 're-read'));
    expect(readFileSync(file, 'utf-8')).toBe('graph TD\n  A-->Agent\n');
  }, 90_000);

  test('saves an Excalidraw file and a text file through their documents', async () => {
    const server = await boot();
    const board = join(server.contentDir, `board-${randomUUID()}.excalidraw`);
    const notes = join(server.contentDir, `notes-${randomUUID()}.txt`);
    const boardJson = '{"type":"excalidraw","version":2,"elements":[]}\n';

    const answers = await writeThroughAcp(server, [
      { path: board, content: boardJson },
      { path: notes, content: 'plain notes\n' },
    ]);

    expect(answers).toEqual([applied(), applied()]);
    expect(readFileSync(board, 'utf-8')).toBe(boardJson);
    expect(readFileSync(notes, 'utf-8')).toBe('plain notes\n');
  }, 90_000);

  test('writes a file that is not a document as is, with an empty result', async () => {
    const server = await boot();
    const file = join(server.contentDir, 'assets', `logo-${randomUUID()}.png`);

    const [answer] = await writeThroughAcp(server, [{ path: file, content: 'not really a png' }]);

    expect(answer).toEqual({ result: {} });
    expect(readFileSync(file, 'utf-8')).toBe('not really a png');
  }, 90_000);
});
