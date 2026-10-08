import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, rawRequest } from './composition-rig.test-helper.ts';
import { __formatContributorsForTests, dropPendingDocs } from './contributor-tracker.ts';
import { connectMcpTestClient } from './mcp/client.test-helper.ts';

const unsafe = `secret-prefix😀${String.fromCharCode(0, 31)}secret-suffix`;
const polluted = `# Historical\n\nBefore ${String.fromCharCode(0, 31)} after.\n`;
const allowed = '# Allowed\r\n\r\nPrintable \\u0000, tab\t, DEL\u007f, C1\u0080\u009f.\r\n';
const routes = [
  { path: '/api/agent-write', body: (docName: string) => ({ docName, content: unsafe }) },
  {
    path: '/api/agent-write-md',
    body: (docName: string) => ({ docName, markdown: unsafe, position: 'replace' }),
  },
  {
    path: '/api/agent-patch',
    body: (docName: string) => ({ docName, find: 'target', replace: unsafe }),
  },
  {
    path: '/api/agent-write-batch',
    body: (docName: string) => ({ docs: [{ docName, markdown: unsafe, position: 'replace' }] }),
  },
];
let root: string;
let server: BootedServer;
let sequence = 0;
const ownedNames = new Set<string>(['historical', 'historical-append']);

function nextName(): string {
  const name = `admission-${++sequence}`;
  ownedNames.add(name);
  return name;
}

function post(path: string, body: object) {
  return rawRequest(server.port, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function write(docName: string, markdown: string, agentId: string) {
  const response = await post('/api/agent-write-md', {
    docName,
    markdown,
    agentId,
    position: 'replace',
  });
  expect(response.status, response.body).toBe(200);
}

function expectRefusal(status: number, body: string) {
  expect.soft(status).toBe(400);
  expect.soft(body).toContain('U+0000');
  expect.soft(body).toMatch(/UTF-?16/i);
  expect.soft(body).toMatch(/offset\D*15\b/i);
  expect.soft(body.length).toBeLessThan(2048);
  expect.soft(body).not.toContain('secret-prefix');
  expect.soft(body).not.toContain('secret-suffix');
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ok-control-admission-'));
  writeFileSync(join(root, 'historical.md'), polluted);
  writeFileSync(join(root, 'historical-append.md'), polluted);
  server = await bootCompositionRig(root);
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  dropPendingDocs(ownedNames);
  rmSync(root, { recursive: true, force: true });
});

describe.each(routes)('$path decoded control admission', ({ path, body }) => {
  test('refuses before allocating a missing document or agent session', async () => {
    const docName = nextName();
    const agentId = `new-${docName}`;
    const contributors = __formatContributorsForTests();
    const documents = [...server.serverInstance.hocuspocus.documents.keys()].sort();
    const response = await post(path, { ...body(docName), agentId });
    expectRefusal(response.status, response.body);
    expect.soft(existsSync(join(root, `${docName}.md`))).toBe(false);
    expect
      .soft(server.serverInstance.sessionManager.hasSession(docName, `agent-${agentId}`))
      .toBe(false);
    expect.soft([...server.serverInstance.hocuspocus.documents.keys()].sort()).toEqual(documents);
    expect.soft(__formatContributorsForTests()).toBe(contributors);
  });

  test('refuses without changing existing source, disk, attribution, or undo', async () => {
    const docName = nextName();
    const agentId = `existing-${docName}`;
    const original = '# Existing\n\nA target stays unchanged.\n';
    await write(docName, original, agentId);
    const session = await server.serverInstance.sessionManager.getSession(
      docName,
      `agent-${agentId}`,
    );
    session.um.stopCapturing();
    expect(session.um.undoStack.length).toBeGreaterThan(0);
    const document = Y.encodeStateAsUpdate(session.dc.document);
    const undo = [...session.um.undoStack];
    const contributors = __formatContributorsForTests();
    const response = await post(path, { ...body(docName), agentId, summary: 'Rejected write' });
    expectRefusal(response.status, response.body);
    expect.soft(session.dc.document.getText('source').toString()).toBe(original);
    expect.soft(Y.encodeStateAsUpdate(session.dc.document)).toEqual(document);
    expect.soft(readFileSync(join(root, `${docName}.md`), 'utf8')).toBe(original);
    expect.soft(session.um.undoStack).toEqual(undo);
    expect.soft(__formatContributorsForTests()).toBe(contributors);
  });
});

test('mixed batch refuses atomically before touching its clean entries', async () => {
  const existing = nextName();
  const cleanNew = nextName();
  const badNew = nextName();
  const agentId = `batch-${existing}`;
  const original = '# Batch target\n';
  await write(existing, original, agentId);
  const contributors = __formatContributorsForTests();
  const response = await post('/api/agent-write-batch', {
    agentId,
    docs: [
      { docName: existing, markdown: '# Must not replace\n', position: 'replace' },
      { docName: cleanNew, markdown: '# Must not create\n', position: 'replace' },
      { docName: badNew, markdown: unsafe, position: 'replace' },
    ],
  });
  expectRefusal(response.status, response.body);
  expect.soft(readFileSync(join(root, `${existing}.md`), 'utf8')).toBe(original);
  for (const docName of [cleanNew, badNew]) {
    expect.soft(existsSync(join(root, `${docName}.md`))).toBe(false);
    expect
      .soft(server.serverInstance.sessionManager.hasSession(docName, `agent-${agentId}`))
      .toBe(false);
  }
  expect.soft(__formatContributorsForTests()).toBe(contributors);
});

test('allowed markdown, patch replacements and batch entries remain byte-exact on disk', async () => {
  const docName = nextName();
  const batchName = nextName();
  const agentId = `allowed-${docName}`;
  await write(docName, allowed, agentId);
  expect(readFileSync(join(root, `${docName}.md`), 'utf8')).toBe(allowed);
  const replacement = 'Printable \\u001F\t\u007f\u0080\u009f';
  const patched = await post('/api/agent-patch', {
    docName,
    agentId,
    find: 'Printable \\u0000',
    replace: replacement,
  });
  expect(patched.status, patched.body).toBe(200);
  expect(readFileSync(join(root, `${docName}.md`), 'utf8')).toBe(
    allowed.replace('Printable \\u0000', replacement),
  );
  const batch = await post('/api/agent-write-batch', {
    agentId,
    docs: [{ docName: batchName, markdown: allowed, position: 'replace' }],
  });
  expect(batch.status, batch.body).toBe(200);
  expect(readFileSync(join(root, `${batchName}.md`), 'utf8')).toBe(allowed);
});

test('historical pollution loads, permits clean deltas and partial repair, and survives undo and rollback', async () => {
  const docName = 'historical';
  const agentId = 'historical-repair';
  const session = await server.serverInstance.sessionManager.getSession(
    docName,
    `agent-${agentId}`,
  );
  expect(session.dc.document.getText('source').toString()).toBe(polluted);
  expect(readFileSync(join(root, `${docName}.md`), 'utf8')).toBe(polluted);
  const saved = await post('/api/save-version', { agentId, summary: 'Preserve historical bytes' });
  expect(saved.status, saved.body).toBe(200);
  const version = (JSON.parse(saved.body) as { checkpointRef: string }).checkpointRef
    .split('/')
    .at(-1);
  expect(version).toMatch(/^[a-f0-9]{40}$/);
  const cleanDelta = await post('/api/agent-patch', {
    docName,
    agentId,
    find: 'Before',
    replace: 'Edited before',
  });
  expect(cleanDelta.status, cleanDelta.body).toBe(200);
  const edited = polluted.replace('Before', 'Edited before');
  expect(readFileSync(join(root, `${docName}.md`), 'utf8')).toBe(edited);
  session.um.stopCapturing();
  const repaired = await post('/api/agent-patch', {
    docName,
    agentId,
    find: String.fromCharCode(0),
    replace: '\\u0000',
  });
  expect(repaired.status, repaired.body).toBe(200);
  expect(readFileSync(join(root, `${docName}.md`), 'utf8')).toBe(
    edited.replace(String.fromCharCode(0), '\\u0000'),
  );
  const undone = await post('/api/agent-undo', {
    docName,
    agentId,
    connectionId: `agent-${agentId}`,
    scope: 'last',
  });
  expect(undone.status, undone.body).toBe(200);
  expect(JSON.parse(undone.body)).toMatchObject({ undone: true });
  expect(readFileSync(join(root, `${docName}.md`), 'utf8')).toBe(edited);
  const rollback = await post('/api/rollback', {
    docName,
    agentId,
    commitSha: version,
    summary: 'Restore historical bytes',
  });
  expect(rollback.status, rollback.body).toBe(200);
  expect(readFileSync(join(root, `${docName}.md`), 'utf8')).toBe(polluted);
  expect(session.dc.document.getText('source').toString()).toBe(polluted);
});

test('clean append and prepend do not revalidate polluted composed source', async () => {
  const docName = 'historical-append';
  const session = await server.serverInstance.sessionManager.getSession(
    docName,
    'agent-clean-delta',
  );
  expect(session.dc.document.getText('source').toString()).toBe(polluted);
  for (const [position, markdown] of [
    ['append', '\nClean suffix.\n'],
    ['prepend', '# Clean prefix\n\n'],
  ] as const) {
    const before = session.dc.document.getText('source').toString();
    const response = await post('/api/agent-write-md', {
      docName,
      agentId: 'clean-delta',
      markdown,
      position,
    });
    expect(response.status, response.body).toBe(200);
    const expected = position === 'append' ? before + markdown : markdown + before;
    expect(session.dc.document.getText('source').toString()).toBe(expected);
    expect(readFileSync(join(root, `${docName}.md`), 'utf8')).toBe(expected);
  }
});

test('MCP clients receive a safe actionable write refusal without a created file', async () => {
  const client = await connectMcpTestClient(`http://127.0.0.1:${server.port}/mcp`);
  const docName = nextName();
  try {
    const result = await client.callTool({
      name: 'write',
      arguments: { document: { path: docName, content: unsafe, position: 'replace' } },
    });
    expect.soft(result.isError).toBe(true);
    const content = JSON.stringify(result.content);
    expect.soft(content).toContain('U+0000');
    expect.soft(content).toMatch(/UTF-?16/i);
    expect.soft(content).not.toContain('secret-prefix');
    expect.soft(content).not.toContain('secret-suffix');
    expect.soft(content.length).toBeLessThan(2048);
    expect.soft(existsSync(join(root, `${docName}.md`))).toBe(false);
  } finally {
    await client.close();
  }
});
