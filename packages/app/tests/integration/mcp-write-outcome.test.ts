import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { connectMcpTestClient } from '../../../server/src/mcp/client.test-helper.ts';
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

type Mcp = Awaited<ReturnType<typeof connectMcpTestClient>>;

async function rig(): Promise<{ server: TestServer; mcp: Mcp }> {
  const server = await createTestServer({
    gitEnabled: true,
    watcherBackend: createWatcherDouble().backend,
    debounce: 300_000,
    maxDebounce: 600_000,
  });
  cleanups.push(() => server.cleanup());
  const mcp = await connectMcpTestClient(`${server.baseUrl}/mcp`, { name: 'outcome-reader' });
  cleanups.push(() => mcp.close());
  await mcp.listTools();
  return { server, mcp };
}

async function seedAndOpen(
  server: TestServer,
  docName: string,
): Promise<{ client: TestClient; file: string }> {
  const file = join(server.contentDir, `${docName}.md`);
  await agentWriteMd(server.port, SEED, { docName, position: 'replace' });
  await pollUntil(() => existsSync(file) && readFileSync(file, 'utf-8') === SEED, 10_000, 25);
  const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
  cleanups.push(() => client.cleanup());
  await pollUntil(() => client.ytext.toString() === SEED, 10_000, 25, 'the client to load');
  return { client, file };
}

function liveText(server: TestServer, docName: string): string {
  return server.instance.hocuspocus.documents.get(docName)?.getText('source').toString() ?? '';
}

function textOf(result: { content: unknown }): string {
  return (result.content as Array<{ text?: string }>)[0]?.text ?? '';
}

function appendWith(mcp: Mcp, path: string, content: string) {
  return mcp.callTool({
    name: 'write',
    arguments: { document: { path, content, position: 'append' } },
  });
}

describe('an MCP client that has listed the tools reads the outcome on every write result', () => {
  test('applied and refused write results carry the same three fields', async () => {
    const { server, mcp } = await rig();
    const docName = `mcp-outcome-${randomUUID()}`;
    const applied = await mcp.callTool({
      name: 'write',
      arguments: { document: { path: docName, content: '# Applied\n\nAlpha.\n' } },
    });
    expect(applied.isError).toBeFalsy();
    expect(applied.structuredContent).toMatchObject({
      outcome: 'applied',
      saved: true,
      nextStep: 'none',
    });

    const { client } = await seedAndOpen(server, `${docName}-refused`);
    client.doc.transact(() => client.ytext.insert(client.ytext.length, '\ntyped here\n'));
    await pollUntil(() => liveText(server, `${docName}-refused`).includes('typed here'));
    const refused = await mcp.callTool({
      name: 'write',
      arguments: {
        document: { path: `${docName}-refused`, content: '# Replacement\n', position: 'replace' },
      },
    });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({
      outcome: 'refused',
      saved: false,
      nextStep: 'retry',
    });
    expect(textOf(refused)).toContain('Outcome: refused; saved: no; next step: retry.');
  }, 60_000);

  test('a both-kept write is not a plain success, and its text says it landed and is not to be retried', async () => {
    const { server, mcp } = await rig();
    const docName = `mcp-both-${randomUUID()}`;
    const { client, file } = await seedAndOpen(server, docName);
    client.doc.transact(() => {
      const at = client.ytext.toString().indexOf('first paragraph');
      client.ytext.insert(at + 'first paragraph'.length, ', edited here');
    });
    await pollUntil(() => liveText(server, docName).includes('edited here'));
    writeFileSync(file, '# Doc\n\nfirst paragraph, edited outside\n\nsecond paragraph\n');

    const result = await appendWith(mcp, docName, '\nagent line\n');
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      outcome: 'both-kept',
      saved: true,
      nextStep: 're-read',
    });
    const text = textOf(result);
    expect(text).toContain('The write landed and is saved; do not retry it.');
    expect(text).not.toMatch(/^Error/);
  }, 60_000);

  test('a write whose save is held says it is in the document and not to be retried', async () => {
    const { server, mcp } = await rig();
    const docName = `mcp-held-${randomUUID()}`;
    await seedAndOpen(server, docName);
    process.env.OK_TEST_COMPARE_READ_FAULT = `${docName}:EBUSY:1000`;

    const result = await appendWith(mcp, docName, '\nagent line\n');
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      outcome: 'projection-held',
      saved: false,
      nextStep: 're-read',
    });
    expect(result.structuredContent).not.toHaveProperty('document');
    expect(textOf(result)).toContain('Do not retry it.');
  }, 60_000);

  test('an edit over an outside change to another block reads as merged first', async () => {
    const { server, mcp } = await rig();
    const docName = `mcp-merged-${randomUUID()}`;
    const { file } = await seedAndOpen(server, docName);
    writeFileSync(file, '# Doc\n\nfirst paragraph\n\nsecond paragraph, edited outside\n');

    const result = await mcp.callTool({
      name: 'edit',
      arguments: {
        document: { path: docName, find: 'first paragraph', replace: 'first paragraph, edited' },
      },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      outcome: 'merged-first',
      saved: true,
      nextStep: 're-read',
    });
  }, 60_000);

  test('each entry of a batch write carries its own outcome', async () => {
    const { server, mcp } = await rig();
    const fresh = `mcp-batch-fresh-${randomUUID()}`;
    const busy = `mcp-batch-busy-${randomUUID()}`;
    const { client } = await seedAndOpen(server, busy);
    client.doc.transact(() => client.ytext.insert(client.ytext.length, '\ntyped here\n'));
    await pollUntil(() => liveText(server, busy).includes('typed here'));

    const result = await mcp.callTool({
      name: 'write',
      arguments: {
        documents: [
          { path: fresh, content: '# Fresh\n' },
          { path: busy, content: '# Replacement\n', position: 'replace' },
        ],
      },
    });
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as {
      outcome?: string;
      documents: Array<{ docName: string; outcome?: string; nextStep?: string }>;
    };
    expect(structured.outcome).toBeUndefined();
    expect(structured.documents.map((entry) => [entry.outcome, entry.nextStep])).toEqual([
      ['applied', 'none'],
      ['refused', 'retry'],
    ]);
  }, 60_000);
});
