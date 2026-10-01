import { getAgentCanonicalDescriptors } from '@inkeep/open-knowledge-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { ConfigSchema } from '../../config/schema.ts';
import { installJsonSchemaDialect } from '../json-schema-dialect.ts';
import { register as registerEdit } from './edit.ts';
import { register as registerInstall } from './install.ts';
import { register as registerMove } from './move.ts';
import { register as registerPalette } from './palette.ts';
import { register as registerRestoreVersion } from './restore-version.ts';
import { register as registerWrite } from './write.ts';

const names = ['write', 'edit', 'move', 'install', 'restore_version'];
const client = new Client({ name: 'mutation-contract-test', version: '1' });
let tools: Awaited<ReturnType<Client['listTools']>>['tools'];

beforeAll(async () => {
  const server = new McpServer({ name: 'mutation-contract-test', version: '1' });
  const deps = {
    config: ConfigSchema.parse({ content: { dir: '.' } }),
    resolveCwd: async () => process.cwd(),
    serverUrl: '',
  };
  for (const register of [
    registerWrite,
    registerEdit,
    registerMove,
    registerInstall,
    registerPalette,
    registerRestoreVersion,
  ]) {
    register(server, deps);
  }
  installJsonSchemaDialect(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  tools = (await client.listTools()).tools;
});

afterAll(async () => client.close());

function description(name: string): string {
  const tool = tools.find((item) => item.name === name);
  if (!tool?.description) throw new Error(`Missing served description for ${name}`);
  return tool.description;
}

test.each(names)(
  '%s serves its complete contract within the normalized description limit',
  (name) => {
    expect(description(name).normalize('NFKC').length, name).toBeLessThanOrEqual(2048);
  },
);

test.each(names)('%s preserves the transport-qualified cwd parameter', (name) => {
  const schema = tools.find((item) => item.name === name)?.inputSchema;
  expect(schema?.properties?.cwd).toMatchObject({
    description:
      'Absolute OK project/worktree path. Routed stdio: required until set unless one client root exists. Project-bound HTTP: optional, confined to its root.',
  });
});

test.each(['write', 'edit', 'move'])(
  '%s keeps persisted-summary privacy visible before action',
  (name) => {
    expect(description(name)).toContain('secrets or PII');
    expect(description(name)).toContain('≤80 chars');
    expect(description(name)).toContain('git history');
  },
);

test('move keeps its identity promise and default summary in the actual listing', () => {
  expect(description('move')).toMatch(
    /^For \.md\/\.mdx inspection before or after a move in a project with \.ok\/, use exec; native Read\/Grep\/Glob omit wiki context\./,
  );
  expect(description('move')).toContain(
    'Links to the moved document keep pointing to it. The old path stops existing; do not leave a redirect or stub.',
  );
  expect(description('move')).toContain('If omitted');
  expect(description('move')).toContain('Renamed X → Y');
  expect(description('move')).toContain('moveState');
  expect(description('move')).toContain('on SUCCESS only');
});

test('write retains critical guidance even if a client strips parameter descriptions', () => {
  const text = description('write');
  for (const pin of [
    'Nested paths such as `guides/overview` can be documents',
    'Use `folder` only for separate pages',
    'content and template are exclusive',
    'Existing docs require position',
    'frontmatter with literal content forces replace, even with append/prepend',
    'append/prepend/edit bypass this refusal',
    'Peers are per MCP connection',
    'top-level is ignored',
    'base64 content or local source path',
  ]) {
    expect(text).toContain(pin);
  }
});

test.each(['write', 'edit'])(
  '%s serves every canonical id and a reachable palette lookup',
  async (name) => {
    const text = description(name);
    const ids = getAgentCanonicalDescriptors().map((descriptor) => descriptor.name);
    const inventory = text.split('\n').find((line) => line.startsWith('Canonical ids:'));
    expect(inventory).toBeDefined();
    expect(inventory?.match(/^Canonical ids: ([^.]+)\./)?.[1].split(', ')).toEqual(ids);
    expect(inventory).not.toContain('MermaidFence');
    expect(inventory).toContain('palette({components:[ids]})');
    expect(inventory).toContain('Other JSX stays raw MDX when no canonical fits');
    const result = await client.callTool({ name: 'palette', arguments: { components: ids } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      componentDetails: ids.map((id) =>
        expect.objectContaining({ id, description: expect.any(String), params: expect.any(Array) }),
      ),
      notFound: [],
      components: expect.arrayContaining([
        expect.objectContaining({ id: 'Callout', example: expect.stringContaining('> [!NOTE]') }),
        expect.objectContaining({ id: 'Mermaid', example: expect.stringContaining('```mermaid') }),
      ]),
      embedPatterns: expect.arrayContaining([
        expect.objectContaining({ snippet: expect.stringContaining('```html preview') }),
      ]),
      tokens: expect.arrayContaining([expect.objectContaining({ name: '--chart-1' })]),
    });
  },
);

test('install teaches copy refresh and divergence behavior before parameter descriptions are stripped', () => {
  const text = description('install');
  for (const pin of [
    'link = live symlink for source updates',
    'copy = separate folder, refreshed on watcher/startup sync while unedited',
    'Hand-edited copies fork; differing copies are preserved and cannot be converted',
    'editor removal may succeed and leave them in place',
  ]) {
    expect(text).toContain(pin);
  }
  const schema = tools.find((item) => item.name === 'install')?.inputSchema;
  expect(schema?.properties?.mode).toMatchObject({
    description: expect.stringContaining('refreshed on watcher/startup sync while unedited'),
  });
  expect(schema?.properties?.remove).toMatchObject({
    description: expect.stringContaining(
      'differing copies are preserved and may remain after success',
    ),
  });
  expect(schema?.properties?.convert).toMatchObject({
    description: expect.stringContaining('a differing copy is refused'),
  });
  expect(JSON.stringify({ description: text, inputSchema: schema })).not.toMatch(
    /not refreshed after source edits|Hand-edited forks are refused/,
  );
});

test.each(['edit', 'restore_version'])('%s keeps skill copy expectations accurate', (name) => {
  expect(description(name)).toContain('unedited copies refresh');
  expect(description(name)).toContain('watcher/startup sync');
  expect(description(name)).toContain('Hand-edited copies are preserved');
});

test('install describes preserved differing copies without attributing an edit to the copy', () => {
  const schema = tools.find((item) => item.name === 'install')?.outputSchema;
  expect(schema?.properties?.warningCodes).toMatchObject({
    description: expect.stringContaining(
      '`place-fork-refused`: a copy differing from the current source was left alone rather than deleted.',
    ),
  });
});
