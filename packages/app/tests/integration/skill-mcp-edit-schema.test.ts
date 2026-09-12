import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { connectMcpTestClient } from '../../../server/src/mcp/client.test-helper.ts';
import { createTestServer, HARNESS_BOOT_TIMEOUT_MS, type TestServer } from './test-harness.ts';

let server: TestServer;
let client: Awaited<ReturnType<typeof connectMcpTestClient>>;

function seedSkill(name: string, body: string): string {
  const dir = join(server.contentDir, '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Edit me\n---\n${body}`);
  return dir;
}

beforeAll(async () => {
  server = await createTestServer();
  client = await connectMcpTestClient(`${server.baseUrl}/mcp`);
  const { tools } = await client.listTools();
  expect(tools.find((tool) => tool.name === 'edit')?.outputSchema).toBeDefined();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await client?.close();
  await server?.cleanup();
});

describe('registered MCP edit output validates in an SDK client', () => {
  test('two authoring warnings survive the advertised output schema', async () => {
    const name = 'claude-edit-warnings';
    const dir = seedSkill(name, 'Replace this body.');
    const body = Array.from({ length: 601 }, (_, index) => `Line ${index}.`).join('\n');
    const result = await client.callTool({
      name: 'edit',
      arguments: { skill: { name, find: 'Replace this body.', replace: body } },
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      skill: {
        ok: true,
        created: false,
        warnings: [expect.stringContaining('"claude"'), expect.stringContaining('lines')],
        warningCodes: ['skill-name-vendor-word', 'skill-body-too-long'],
      },
    });
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain(body);
  });

  test('metadata edits with empty warning arrays survive the advertised output schema', async () => {
    const name = 'quiet-edit';
    const dir = seedSkill(name, 'Body stays.');
    const result = await client.callTool({
      name: 'edit',
      arguments: { skill: { name, description: 'Updated description' } },
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      skill: { ok: true, created: false, warnings: [], warningCodes: [] },
    });
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('Updated description');
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('Body stays.');
  });

  test('bundle-file edits still validate without SKILL.md warning fields', async () => {
    const name = 'bundle-edit';
    const dir = seedSkill(name, 'Unchanged skill body.');
    const original = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    mkdirSync(join(dir, 'references'));
    const file = 'references/guide.md';
    writeFileSync(join(dir, file), 'Original reference.');
    const result = await client.callTool({
      name: 'edit',
      arguments: { skill: { name, file, find: 'Original', replace: 'Updated' } },
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      skill: { ok: true, file: { path: file, created: false } },
    });
    expect(readFileSync(join(dir, file), 'utf8')).toBe('Updated reference.');
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe(original);
  });
});
