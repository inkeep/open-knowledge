import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, rawRequest } from './composition-rig.test-helper.ts';
import { connectMcpTestClient } from './mcp/client.test-helper.ts';

let root: string;
let server: BootedServer;
let client: Client;
const templatePath = () => join(root, 'templates', '.ok', 'templates', 'existing.md');
const skillPath = () => join(root, '.agents', 'skills', 'existing', 'SKILL.md');

function skillFile(path: string, content: string) {
  return rawRequest(server.port, '/api/skill-file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'existing', path, content }),
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ok-admission-cause-'));
  for (const [path, content] of [
    [templatePath(), '---\ntitle: Existing\n---\nExisting target.\n'],
    [skillPath(), '---\nname: existing\ndescription: Existing\n---\nExisting target.\n'],
    [
      join(root, '.agents', 'skills', 'open-knowledge', 'SKILL.md'),
      '---\nname: open-knowledge\ndescription: Project\n---\nProject.\n',
    ],
    [
      join(dirname(skillPath()), 'references', 'existing.md'),
      '---\ntitle: Existing\n---\nExisting target.\n',
    ],
  ]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  server = await bootCompositionRig(root);
  await server.ready;
  client = await connectMcpTestClient(`http://127.0.0.1:${server.port}/mcp`);
}, 60_000);

afterAll(async () => {
  await client?.close();
  await server?.destroy();
  rmSync(root, { recursive: true, force: true });
});

test.each(['template', 'skill', 'file'] as const)(
  'real %s edit admission leaves supplied replace open as the control source',
  async (kind) => {
    const path =
      kind === 'template'
        ? templatePath()
        : kind === 'skill'
          ? skillPath()
          : join(dirname(skillPath()), 'references', 'existing.md');
    const original = readFileSync(path);
    const edit = { find: 'target', replace: 'x😀\u0000private-tail' };
    const args =
      kind === 'template'
        ? { template: { path: 'templates/existing', ...edit } }
        : {
            skill: {
              name: 'existing',
              ...(kind === 'file' ? { file: 'references/existing.md' } : {}),
              ...edit,
            },
          };
    const result = await client.callTool({ name: 'edit', arguments: args });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect.soft(text).toContain('U+0000');
    expect.soft(text).toMatch(/UTF-?16/i);
    expect.soft(text).toMatch(/full[^.]*resubmit|resubmit[^.]*full/i);
    expect
      .soft(text)
      .toMatch(
        /supplied[^.]*replace|replace[^.]*supplied|replacement[^.]*submitted|submitted[^.]*replacement/i,
      );
    expect.soft(text).not.toContain('private-tail');
    expect.soft(readFileSync(path)).toEqual(original);
  },
);

test('real hidden .md bundle file is writable and its refusal has the same whole-content advice', async () => {
  const path = 'references/.md';
  const allowed = 'Exact\tline\r\nPrintable \\u0000 😀\u007f\u0080\u009f.\n';
  const seeded = await skillFile(path, allowed);
  expect(seeded.status, seeded.body).toBe(200);
  const abs = join(dirname(skillPath()), path);
  expect(readFileSync(abs, 'utf8')).toBe(allowed);
  const raw = await skillFile(path, 'x😀\u0000private-tail');
  expect(raw.status, raw.body).toBe(400);
  expect(raw.body).toContain('U+0000');
  const result = await client.callTool({
    name: 'write',
    arguments: { skill: { name: 'existing', files: [{ path, content: 'x😀\u0000private-tail' }] } },
  });
  expect(result.isError).toBe(true);
  const text = JSON.stringify(result.content);
  expect.soft(text).toContain('U+0000');
  expect.soft(text).toMatch(/offset[^.]*whole submitted file content[^.]*frontmatter/i);
  expect.soft(readFileSync(abs, 'utf8')).toBe(allowed);
});

test('real ordinary Markdown refusal keeps actionable advice for a submitted full file', async () => {
  const result = await client.callTool({
    name: 'write',
    arguments: {
      skill: {
        name: 'existing',
        files: [{ path: 'references/ordinary.md', content: 'x😀\u0000private-tail' }],
      },
    },
  });
  expect(result.isError).toBe(true);
  const text = JSON.stringify(result.content);
  expect(text).toContain('U+0000');
  expect(text).toMatch(/offset[^.]*whole submitted file content[^.]*frontmatter/i);
  expect(text).toMatch(/TAB[^.]*LF[^.]*CR/i);
  expect(text).toMatch(/Remove[^.]*replace[^.]*printable escape/i);
});

test('real invalid skill description returns only its actual problem title and detail', async () => {
  const description = 'x'.repeat(2048);
  const response = await rawRequest(server.port, '/api/skill', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'existing',
      body: 'Existing target.\n',
      frontmatter: { name: 'existing', description },
    }),
  });
  expect(response.status, response.body).toBe(400);
  const problem = JSON.parse(response.body) as { title: string; detail: string };
  expect(problem.detail).toBe('DESCRIPTION_TOO_LONG');
  const original = readFileSync(skillPath());
  const result = await client.callTool({
    name: 'edit',
    arguments: { skill: { name: 'existing', description } },
  });
  expect(result.isError).toBe(true);
  expect
    .soft(result.content)
    .toEqual([{ type: 'text', text: `Error: ${problem.title} (${problem.detail})` }]);
  expect.soft(readFileSync(skillPath())).toEqual(original);
});
