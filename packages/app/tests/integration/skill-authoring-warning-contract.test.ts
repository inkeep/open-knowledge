import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { writeSkill } from '../../../server/src/mcp/tools/skill-target.ts';
import { createTestServer, HARNESS_BOOT_TIMEOUT_MS, type TestServer } from './test-harness.ts';

let server: TestServer;
let sourceRoot: string;
const codes = ['skill-name-vendor-word', 'skill-body-too-long'];
const body = (count: number) => Array.from({ length: count }, (_, i) => `Line ${i}.`).join('\n');
const request = async (path: string, input: Record<string, unknown>, method = 'POST') => {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  return result;
};

function seed(name: string, lines: number): string {
  const source = join(sourceRoot, name);
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Warnings\n---\n${body(lines)}`,
  );
  return source;
}

function expectWarnings(result: { warnings: string[]; warningCodes: string[] }): void {
  expect(result.warningCodes).toEqual(codes);
  expect(result.warnings).toEqual([
    expect.stringContaining('"claude"'),
    expect.stringContaining('lines'),
  ]);
}

beforeAll(async () => {
  sourceRoot = mkdtempSync(join(tmpdir(), 'ok-warning-contract-'));
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
  rmSync(sourceRoot, { recursive: true, force: true });
});

describe('authoring warning codes across skill entry points', () => {
  test('create and edit emit each authoring warning once with the matching code', async () => {
    const name = 'claude-write-warning';
    for (const lines of [601, 602]) {
      expectWarnings(
        await request(
          '/api/skill',
          { name, body: body(lines), frontmatter: { name, description: 'Warnings' } },
          'PUT',
        ),
      );
    }
  });

  test('single import and reimport retain warning codes and no-op responses return empty pairs', async () => {
    const name = 'claude-single-warning';
    const source = seed(name, 601);
    expectWarnings(await request('/api/skill/import', { source }));
    seed(name, 602);
    expectWarnings(await request('/api/skill/reimport', { name }));
    for (const input of [{ name }, { name, setAutoUpdate: true }]) {
      expect(await request('/api/skill/reimport', input)).toMatchObject({
        warnings: [],
        warningCodes: [],
      });
    }
  });

  test('bulk import and reimport retain warning codes on each result', async () => {
    const name = 'claude-bulk-warning';
    seed(name, 601);
    const imported = await request('/api/skills/import-bulk', {
      source: sourceRoot,
      skills: [name],
    });
    expectWarnings(imported.results[0]);
    seed(name, 602);
    const refreshed = await request('/api/skills/reimport-bulk', {
      names: [name, 'absent-warning-skill'],
    });
    expectWarnings(refreshed.results.find((row: { requested: string }) => row.requested === name));
    expect(
      refreshed.results.find((row: { requested: string }) => row.requested !== name),
    ).toMatchObject({ warnings: [], warningCodes: [] });
    const unchanged = await request('/api/skills/reimport-bulk', { names: [name] });
    expect(unchanged.results[0]).toMatchObject({ warnings: [], warningCodes: [] });
  });

  test('MCP skill writes expose warning codes alongside their display text', async () => {
    const result = await writeSkill(`http://127.0.0.1:${server.port}`, {
      name: 'claude-mcp-warning',
      description: 'Warnings',
      body: body(601),
    });
    expect(result.isError).toBeUndefined();
    expect(result).toMatchObject({
      structuredContent: {
        skill: {
          warningCodes: codes,
          warnings: [expect.stringContaining('"claude"'), expect.stringContaining('lines')],
        },
      },
    });
  });
});
