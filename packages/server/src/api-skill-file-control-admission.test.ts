import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const name = 'reference-admission';
const original = '---\ntitle: Existing\n---\nExisting target.\n';
const allowed = 'Exact \t whitespace\r\nPrintable \\u0000 \\u001F 😀\u007f\u0080\u009f.\n';
const unsafe = (code: number) => `x😀${String.fromCharCode(code)}private-tail`;
let root: string;
let server: BootedServer;
let client: Client;
let sequence = 0;
const nextPath = (extension: string) => `references/admission-${++sequence}${extension}`;
const diskPath = (path: string) => join(root, '.agents', 'skills', name, path);

function put(path: string, content: string, agentId = 'reference-writer') {
  return rawRequest(server.port, '/api/skill-file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'project', name, path, content, agentId }),
  });
}

async function seed(path: string, content = original) {
  const response = await put(path, content);
  expect(response.status, response.body).toBe(200);
  expect(readFileSync(diskPath(path), 'utf8')).toBe(content);
}

function expectDetail(text: string, code: number, offset: number) {
  expect.soft(text).toContain(`U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
  expect.soft(text).toMatch(/UTF-?16/i);
  expect.soft(text).toMatch(new RegExp(`offset\\D*${offset}\\b`, 'i'));
  expect.soft(text.length).toBeLessThan(2048);
  expect.soft(text).not.toContain('private-tail');
}

function toolError(result: { isError?: boolean; content?: unknown }, code: number) {
  expect.soft(result.isError).toBe(true);
  const text = JSON.stringify(result.content);
  expect.soft(text).toContain(`U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
  expect.soft(text).toMatch(/UTF-?16/i);
  expect.soft(text).toMatch(/\bTAB\b/i);
  expect.soft(text).toMatch(/\bLF\b/i);
  expect.soft(text).toMatch(/\bCR\b/i);
  expect.soft(text).toMatch(/remove|replace/i);
  expect.soft(text).toMatch(/escap|printable/i);
  expect.soft(text).not.toMatch(/Error:\s*undefined/i);
  expect.soft(text).not.toContain('private-tail');
  expect.soft(text.length).toBeLessThan(2048);
  return text;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ok-reference-admission-'));
  for (const skill of [name, 'open-knowledge']) {
    const directory = join(root, '.agents', 'skills', skill);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'SKILL.md'),
      `---\nname: ${skill}\ndescription: Admission\n---\nGuidance.\n`,
    );
  }
  server = await bootArtifactAdmissionRig(root);
  client = await connectMcpTestClient(`http://127.0.0.1:${server.port}/mcp`);
}, 60_000);

afterAll(async () => {
  await client?.close();
  await server?.destroy();
  rmSync(root, { recursive: true, force: true });
});

describe.each(['.md', '.mdx'])(
  '%s reference content over real HTTP and registered MCP',
  (extension) => {
    test.each([0, 31])(
      'refuses decoded control %i before creating or overwriting a reference',
      async (code) => {
        for (const existing of [false, true]) {
          const path = nextPath(extension);
          if (existing) await seed(path);
          await settleArtifactContributors(server);
          const contributors = __formatContributorsForTests();
          const response = await put(path, unsafe(code), `rejected-reference-${++sequence}`);
          expect.soft(response.status, response.body).toBe(400);
          expect.soft(response.headers['content-type']).toContain('application/problem+json');
          expectDetail(response.body, code, 3);
          expect.soft(existsSync(diskPath(path))).toBe(existing);
          if (existing) expect.soft(readFileSync(diskPath(path), 'utf8')).toBe(original);
          expect.soft(__formatContributorsForTests()).toBe(contributors);
        }
      },
    );

    test('preserves admitted bytes on disk and through the public file read', async () => {
      const path = nextPath(extension);
      await seed(path, allowed);
      const response = await rawRequest(
        server.port,
        `/api/skill-file?${new URLSearchParams({ scope: 'project', name, path })}`,
      );
      expect(response.status, response.body).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ path, kind: 'reference', text: allowed });
    });

    test('MCP file write returns an actionable content-coordinate refusal without creation', async () => {
      const path = nextPath(extension);
      const result = await client.callTool({
        name: 'write',
        arguments: { skill: { name, files: [{ path, content: unsafe(0) }] } },
      });
      const text = toolError(result, 0);
      expectDetail(text, 0, 3);
      expect.soft(text).toMatch(/\bcontent\b/i);
      expect.soft(existsSync(diskPath(path))).toBe(false);
    });

    test('MCP file edit names whole-file content or replacement coordinates without mutation', async () => {
      const path = nextPath(extension);
      await seed(path);
      const result = await client.callTool({
        name: 'edit',
        arguments: { skill: { name, file: path, find: 'target', replace: unsafe(31) } },
      });
      const text = toolError(result, 31);
      const fullOffset = original.indexOf('target') + 3;
      const contentCoordinate =
        /\bcontent\b/i.test(text) && new RegExp(`offset\\D*${fullOffset}\\b`, 'i').test(text);
      const replacementCoordinate = /replace/i.test(text) && /offset\D*3\b/i.test(text);
      expect.soft(contentCoordinate || replacementCoordinate, text).toBe(true);
      expect.soft(readFileSync(diskPath(path), 'utf8')).toBe(original);
    });

    test('MCP file write and edit preserve admitted Markdown bytes', async () => {
      const path = nextPath(extension);
      const written = await client.callTool({
        name: 'write',
        arguments: { skill: { name, files: [{ path, content: allowed }] } },
      });
      expect(written.isError, JSON.stringify(written.content)).not.toBe(true);
      expect(readFileSync(diskPath(path), 'utf8')).toBe(allowed);
      const edited = await client.callTool({
        name: 'edit',
        arguments: { skill: { name, file: path, find: 'Exact', replace: 'Updated' } },
      });
      expect(edited.isError, JSON.stringify(edited.content)).not.toBe(true);
      expect(readFileSync(diskPath(path), 'utf8')).toBe(allowed.replace('Exact', 'Updated'));
    });
  },
);
