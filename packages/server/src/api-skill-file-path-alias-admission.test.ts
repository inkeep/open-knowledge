import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  bootArtifactAdmissionRig,
  settleArtifactContributors,
} from './artifact-admission-rig.test-helper.ts';
import type { BootedServer } from './boot.ts';
import { rawRequest } from './composition-rig.test-helper.ts';
import { __formatContributorsForTests } from './contributor-tracker.ts';
import { connectMcpTestClient } from './mcp/client.test-helper.ts';

const aliases = [
  ['references/notes.md/', 'references/notes.md'],
  ['references/notes.md/.', 'references/notes.md'],
  ['references\\notes.md\\', 'references/notes.md'],
  ['references//./notes.MDX/./', 'references/notes.MDX'],
] as const;
const allowed = 'Exact\tline\r\nPrintable \\u0000 😀\u007f\u0080\u009f.\n';
let root: string;
let server: BootedServer;
let client: Client;
let sequence = 0;

function put(name: string, path: string, content: string) {
  return rawRequest(server.port, '/api/skill-file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'project', name, path, content }),
  });
}

async function seedSkill() {
  const name = `alias-admission-${++sequence}`;
  const response = await rawRequest(server.port, '/api/skill', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      body: 'Project instructions.\n',
      frontmatter: { name, description: 'Path admission' },
    }),
  });
  expect(response.status, response.body).toBe(200);
  return name;
}

async function read(name: string, path: string) {
  return rawRequest(
    server.port,
    `/api/skill-file?${new URLSearchParams({ name, scope: 'project', path })}`,
  );
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ok-skill-path-alias-'));
  const builtin = join(root, '.agents', 'skills', 'open-knowledge');
  mkdirSync(builtin, { recursive: true });
  writeFileSync(
    join(builtin, 'SKILL.md'),
    '---\nname: open-knowledge\ndescription: Project\n---\nProject.\n',
  );
  server = await bootArtifactAdmissionRig(root);
  client = await connectMcpTestClient(`http://127.0.0.1:${server.port}/mcp`);
}, 60_000);

afterAll(async () => {
  await client?.close();
  await server?.destroy();
  rmSync(root, { recursive: true, force: true });
});

describe.each(['HTTP', 'MCP'] as const)('%s normalized skill file admission', (transport) => {
  test.each(aliases)(
    'refuses controls through %s without changing the canonical file %s',
    async (alias, canonical) => {
      const name = await seedSkill();
      const seeded = await put(name, canonical, allowed);
      expect(seeded.status, seeded.body).toBe(200);
      const path = join(root, '.agents', 'skills', name, canonical);
      const original = readFileSync(path);
      await settleArtifactContributors(server);
      const contributors = __formatContributorsForTests();
      const content = 'x😀\u0000private-tail';
      let detail: string;
      if (transport === 'HTTP') {
        const response = await put(name, alias, content);
        expect.soft(response.status, response.body).toBe(400);
        detail = response.body;
      } else {
        const result = await client.callTool({
          name: 'write',
          arguments: { skill: { name, files: [{ path: alias, content }] } },
        });
        expect.soft(result.isError, JSON.stringify(result.content)).toBe(true);
        detail = JSON.stringify(result.content);
      }
      expect.soft(detail).toContain('U+0000');
      expect.soft(detail).toMatch(/UTF-?16/i);
      expect.soft(detail).toMatch(/offset\D*3\b/i);
      expect.soft(detail).not.toContain('private-tail');
      expect.soft(readFileSync(path)).toEqual(original);
      expect.soft(__formatContributorsForTests()).toBe(contributors);
      const loaded = await read(name, canonical);
      expect.soft(loaded.status, loaded.body).toBe(200);
      expect.soft(JSON.parse(loaded.body).text).toBe(allowed);
    },
  );

  test.each(aliases)('accepts admitted bytes through %s at %s', async (alias, canonical) => {
    const name = await seedSkill();
    if (transport === 'HTTP') {
      const response = await put(name, alias, allowed);
      expect(response.status, response.body).toBe(200);
    } else {
      const result = await client.callTool({
        name: 'write',
        arguments: { skill: { name, files: [{ path: alias, content: allowed }] } },
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    }
    expect(readFileSync(join(root, '.agents', 'skills', name, canonical), 'utf8')).toBe(allowed);
    const loaded = await read(name, canonical);
    expect(loaded.status, loaded.body).toBe(200);
    expect(JSON.parse(loaded.body).text).toBe(allowed);
  });

  test.each([
    ['scripts/fixture.sh/.', 'scripts/fixture.sh'],
    ['assets/fixture.svg/', 'assets/fixture.svg'],
    ['references/notes.md.bak/', 'references/notes.md.bak'],
  ])('preserves opaque control bytes through %s at %s', async (alias, canonical) => {
    const name = await seedSkill();
    const content = 'opaque\u0000\u001f\n';
    if (transport === 'HTTP') {
      const response = await put(name, alias, content);
      expect(response.status, response.body).toBe(200);
    } else {
      const result = await client.callTool({
        name: 'write',
        arguments: { skill: { name, files: [{ path: alias, content }] } },
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    }
    expect(readFileSync(join(root, '.agents', 'skills', name, canonical), 'utf8')).toBe(content);
  });
});
