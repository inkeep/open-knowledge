/**
 * Integration tests for the write-time `brokenLinks` validation contract,
 * exercised end-to-end through the real MCP tool surface
 * (tool → HTTP handler → BacklinkIndex/extractors → response).
 *
 * Broken outbound links are surfaced in the SAME write/edit response, computed
 * synchronously from the just-written bytes — NOT the 100ms-debounced
 * BacklinkIndex — so the assertions deliberately read the write response
 * directly with no quiescence flush (freshness).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { awaitFileWatcherIndexed, createTestServer, type TestServer } from './test-harness.ts';

const MCP_PROTOCOL_VERSION = '2025-06-18';

interface InitializedSession {
  sessionId: string;
  protocolVersion: string;
}

// Mirrors the core `BrokenLink` type but is defined locally ON PURPOSE: this
// test asserts the actual MCP wire shape the agent receives, independent of the
// declared core types. Importing the core type would let a silent type↔wire
// drift pass unnoticed — the literal expectations below are the contract, not
// the TypeScript declarations.
interface BrokenLink {
  href: string;
  resolvedTo: string | null;
  reason: 'no-such-doc' | 'no-such-file' | 'unresolvable';
}

async function openMcpSession(port: number): Promise<InitializedSession> {
  const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'Claude', version: '1.0.0' },
      },
    }),
  });
  expect(init.status).toBe(200);
  const sessionId = init.headers.get('mcp-session-id');
  expect(sessionId).toBeTruthy();
  const initBody = (await init.json()) as { result?: { protocolVersion?: string } };
  const protocolVersion = initBody.result?.protocolVersion ?? MCP_PROTOCOL_VERSION;

  const initialized = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-session-id': sessionId as string,
      'mcp-protocol-version': protocolVersion,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  expect(initialized.status).toBe(202);
  return { sessionId: sessionId as string, protocolVersion };
}

let nextId = 100;

async function callTool(
  port: number,
  session: InitializedSession,
  name: string,
  args: Record<string, unknown>,
  cwd: string,
): Promise<{ isError?: boolean; structuredContent?: Record<string, unknown> }> {
  nextId += 1;
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-session-id': session.sessionId,
      'mcp-protocol-version': session.protocolVersion,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: nextId,
      method: 'tools/call',
      params: { name, arguments: { ...args, cwd } },
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    error?: unknown;
  };
  if (body.error) throw new Error(`tools/call error: ${JSON.stringify(body.error)}`);
  return body.result ?? {};
}

function docResult(structured: Record<string, unknown> | undefined): Record<string, unknown> {
  expect(structured).toBeDefined();
  const doc = structured?.document as Record<string, unknown> | undefined;
  expect(doc).toBeDefined();
  return doc as Record<string, unknown>;
}

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ debounce: 50, maxDebounce: 200 });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

// ── R2 — write-time brokenLinks validation ────────────────────────────────────

test('write surfaces broken outbound links (doubling + escape-root + broken wiki) in the same response', async () => {
  const session = await openMcpSession(server.port);
  const folder = `wiki-${randomUUID().slice(0, 8)}`;
  const docName = `${folder}/OVERVIEW`;
  // Authored from inside `${folder}/`, so `./${folder}/...` doubles. The escape
  // walks above the content root, and the wiki target doesn't exist.
  const content = [
    '# Wiki Overview',
    '',
    `See [tasks](./${folder}/modules/tasks) for the task module.`,
    'A bad [escape](../../../way-out.md) link.',
    'And a [[Ghost Page]] wiki reference.',
    '',
  ].join('\n');

  const result = await callTool(
    server.port,
    session,
    'write',
    { document: { path: docName, content, position: 'replace' } },
    server.contentDir,
  );
  expect(result.isError ?? false).toBe(false);

  // read brokenLinks straight off the write response, with NO
  // awaitDocQuiescence / pollUntil flush first. The index is still debounced;
  // a correct implementation computed these from the just-written bytes.
  const doc = docResult(result.structuredContent);
  const broken = doc.brokenLinks as BrokenLink[];
  expect(broken).toEqual([
    {
      href: `./${folder}/modules/tasks`,
      resolvedTo: `${folder}/${folder}/modules/tasks`,
      reason: 'no-such-doc',
    },
    { href: '../../../way-out.md', resolvedTo: null, reason: 'unresolvable' },
    { href: '[[Ghost Page]]', resolvedTo: 'Ghost Page', reason: 'no-such-doc' },
  ]);

  // stored bytes are exactly as authored: no auto-correct of the
  // doubling, and the write still succeeded.
  const stored = readFileSync(join(server.contentDir, `${docName}.md`), 'utf-8');
  expect(stored).toContain(`[tasks](./${folder}/modules/tasks)`);
  expect(stored).toContain('[escape](../../../way-out.md)');
  expect(stored).toContain('[[Ghost Page]]');
});

test('a write whose links all resolve returns brokenLinks: [] (positive confirmation)', async () => {
  const session = await openMcpSession(server.port);
  const docName = `clean-${randomUUID().slice(0, 8)}`;
  // A self-link and an anchor/external link — none are broken doc links.
  const content = [
    '# Clean',
    '',
    `Back to [self](./${docName.split('/').pop()}.md).`,
    'An [external](https://example.com) site and an [anchor](#clean).',
    '',
  ].join('\n');

  const result = await callTool(
    server.port,
    session,
    'write',
    { document: { path: docName, content, position: 'replace' } },
    server.contentDir,
  );
  expect(result.isError ?? false).toBe(false);
  const doc = docResult(result.structuredContent);
  expect(doc.brokenLinks).toEqual([]);
});

test('write validates links to any file on disk, not just docs (source-file depth)', async () => {
  const session = await openMcpSession(server.port);
  const uid = randomUUID().slice(0, 8);
  // A real source file on disk under the content root — not a CRDT doc.
  const relFile = `src/probe-${uid}.py`;
  mkdirSync(join(server.contentDir, 'src'), { recursive: true });
  writeFileSync(join(server.contentDir, relFile), 'def probe(): ...\n');

  // Authored from `wiki-${uid}/modules/`, so the content root is `../../`.
  // This is the exact codebase-wiki break: a correct-depth source link is
  // clean, one extra `../` overshoots the root (404s silently in the editor +
  // is invisible to the .md-only link graph), and an in-root path with no file
  // is a distinct miss.
  const docName = `wiki-${uid}/modules/m`;
  const content = [
    '# Module',
    '',
    `Correct depth: [probe](../../${relFile}).`,
    `Over-deep: [probe again](../../../${relFile}).`,
    `Missing: [gone](../../src/missing-${uid}.py).`,
    '',
  ].join('\n');

  const result = await callTool(
    server.port,
    session,
    'write',
    { document: { path: docName, content, position: 'replace' } },
    server.contentDir,
  );
  expect(result.isError ?? false).toBe(false);
  const broken = docResult(result.structuredContent).brokenLinks as BrokenLink[];
  // The correct-depth link is absent (it resolves to the real file); only the
  // overshoot and the missing-file links are reported.
  expect(broken).toEqual([
    { href: `../../../${relFile}`, resolvedTo: null, reason: 'unresolvable' },
    {
      href: `../../src/missing-${uid}.py`,
      resolvedTo: `src/missing-${uid}.py`,
      reason: 'no-such-file',
    },
  ]);
});

test('edit (body find/replace) reports a broken link introduced by the edit', async () => {
  const session = await openMcpSession(server.port);
  const docName = `edited-${randomUUID().slice(0, 8)}`;
  await callTool(
    server.port,
    session,
    'write',
    { document: { path: docName, content: '# Edited\n\nPlaceholder.\n', position: 'replace' } },
    server.contentDir,
  );

  const edited = await callTool(
    server.port,
    session,
    'edit',
    {
      document: {
        path: docName,
        find: 'Placeholder.',
        replace: 'See [gone](./does-not-exist.md).',
      },
    },
    server.contentDir,
  );
  expect(edited.isError ?? false).toBe(false);
  const doc = docResult(edited.structuredContent);
  expect(doc.brokenLinks).toEqual([
    { href: './does-not-exist.md', resolvedTo: 'does-not-exist', reason: 'no-such-doc' },
  ]);
});

test('the HTTP /api/agent-write-md response carries brokenLinks directly', async () => {
  const docName = `http-${randomUUID().slice(0, 8)}`;
  const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      docName,
      position: 'replace',
      markdown: 'Broken [ref](./nope.md) here.\n',
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { brokenLinks?: BrokenLink[] };
  expect(body.brokenLinks).toEqual([
    { href: './nope.md', resolvedTo: 'nope', reason: 'no-such-doc' },
  ]);
});

test('a link to a doc that actually exists is not flagged (admitted-set membership)', async () => {
  const session = await openMcpSession(server.port);
  const suffix = randomUUID().slice(0, 8);
  const target = `guides-${suffix}/install`;
  const sourceDoc = `guides-${suffix}/index`;

  await callTool(
    server.port,
    session,
    'write',
    { document: { path: target, content: '# Install\n\nSteps.\n', position: 'replace' } },
    server.contentDir,
  );
  // The membership check reads the live file index, populated by the watcher.
  await awaitFileWatcherIndexed(server, target);

  const result = await callTool(
    server.port,
    session,
    'write',
    {
      document: {
        path: sourceDoc,
        content: `# Index\n\nSee [install](./install.md).\n`,
        position: 'replace',
      },
    },
    server.contentDir,
  );
  expect(result.isError ?? false).toBe(false);
  const doc = docResult(result.structuredContent);
  expect(doc.brokenLinks).toEqual([]);
});
