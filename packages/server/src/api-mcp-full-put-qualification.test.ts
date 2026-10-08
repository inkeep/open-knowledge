import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { instantiateDoc, stripFrontmatter } from '@inkeep/open-knowledge-core';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  bootArtifactAdmissionRig,
  settleArtifactContributors,
} from './artifact-admission-rig.test-helper.ts';
import type { BootedServer } from './boot.ts';
import { __formatContributorsForTests } from './contributor-tracker.ts';
import { connectMcpTestClient } from './mcp/client.test-helper.ts';

type Kind = 'template' | 'skill';
const historical = `private-history x😀${String.fromCharCode(0)} middle ${String.fromCharCode(31)} end.\n`;
const fullyClean = historical.replace('\u0000', '\\u0000').replace('\u001f', '\\u001F');
let root: string;
let server: BootedServer;
let client: Client;

function nameFor(kind: Kind, operation: string): string {
  return `qualification-${operation}-${kind}`;
}

function pathFor(kind: Kind, name: string): string {
  return kind === 'template'
    ? join(root, 'templates', '.ok', 'templates', `${name}.md`)
    : join(root, '.agents', 'skills', name, 'SKILL.md');
}

function expectFullFieldRefusal(
  result: { isError?: boolean; content?: unknown },
  code: number,
  offset: number,
) {
  expect.soft(result.isError).toBe(true);
  const text = JSON.stringify(result.content);
  expect.soft(text).toContain(`U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
  expect.soft(text).toMatch(/UTF-?16/i);
  expect.soft(text).toMatch(new RegExp(`offset\\D*${offset}\\b`, 'i'));
  expect.soft(text).toMatch(/body|markdown|content|compos|generat/i);
  expect.soft(text).toMatch(/\bTAB\b/i);
  expect.soft(text).toMatch(/\bLF\b/i);
  expect.soft(text).toMatch(/\bCR\b/i);
  expect.soft(text).toMatch(/remove|replace/i);
  expect.soft(text).toMatch(/escap|printable/i);
  expect.soft(text).not.toContain('private-history');
  expect.soft(text).not.toContain('private-batch');
  expect.soft(text).not.toContain('private-tail');
  expect.soft(text).not.toMatch(/Error:\s*undefined/i);
  expect.soft(text.length).toBeLessThan(2048);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ok-full-put-qualification-'));
  for (const kind of ['template', 'skill'] as const) {
    for (const operation of ['metadata', 'repair', 'clean']) {
      const name = nameFor(kind, operation);
      const path = pathFor(kind, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        kind === 'template'
          ? `---\ntitle: Legacy\n---\n${historical}`
          : `---\nname: ${name}\ndescription: Historical\n---\n${historical}`,
      );
    }
  }
  const builtin = pathFor('skill', 'open-knowledge');
  mkdirSync(dirname(builtin), { recursive: true });
  writeFileSync(builtin, '---\nname: open-knowledge\ndescription: Project\n---\nProject.\n');
  server = await bootArtifactAdmissionRig(root);
  client = await connectMcpTestClient(`http://127.0.0.1:${server.port}/mcp`);
}, 60_000);

afterAll(async () => {
  await client?.close();
  await server?.destroy();
  rmSync(root, { recursive: true, force: true });
});

describe.each(['template', 'skill'] as const)(
  '%s new full-PUT input-domain qualification',
  (kind) => {
    test('metadata-only and partial-repair MCP edits refuse resubmitted historical controls without mutation', async () => {
      for (const operation of ['metadata', 'repair']) {
        const name = nameFor(kind, operation);
        const path = pathFor(kind, name);
        const original = readFileSync(path);
        expect(original.toString('utf8')).toContain(historical);
        await settleArtifactContributors(server);
        const contributors = __formatContributorsForTests();
        const edit =
          operation === 'metadata'
            ? kind === 'template'
              ? { frontmatter: { description: 'Updated' } }
              : { description: 'Updated' }
            : { find: '\u0000', replace: '\\u0000' };
        const target =
          kind === 'template'
            ? { template: { path: `templates/${name}`, ...edit } }
            : { skill: { name, ...edit } };
        const result = await client.callTool({ name: 'edit', arguments: target });
        const fullBody =
          operation === 'metadata' ? historical : historical.replace('\u0000', '\\u0000');
        const code = operation === 'metadata' ? 0 : 31;
        expectFullFieldRefusal(result, code, fullBody.indexOf(String.fromCharCode(code)));
        expect.soft(readFileSync(path)).toEqual(original);
        expect.soft(__formatContributorsForTests()).toBe(contributors);
      }
    });

    test('fully clean full replacement of historical content succeeds byte-exact', async () => {
      const name = nameFor(kind, 'clean');
      const path = pathFor(kind, name);
      expect(readFileSync(path, 'utf8')).toContain(historical);
      const cleanTarget =
        kind === 'template'
          ? {
              template: {
                path: `templates/${name}`,
                content: fullyClean,
                frontmatter: { title: 'Clean' },
              },
            }
          : { skill: { name, description: 'Clean', body: fullyClean } };
      const clean = await client.callTool({ name: 'write', arguments: cleanTarget });
      expect(clean.isError, JSON.stringify(clean.content)).not.toBe(true);
      const raw = readFileSync(path, 'utf8');
      expect(kind === 'template' ? instantiateDoc(raw) : stripFrontmatter(raw).body).toBe(
        fullyClean,
      );
    });
  },
);

test('mixed MCP documents batch persists safe siblings before and after refusal without atomic rollback', async () => {
  const first = 'qualification-batch-safe-first';
  const unsafe = 'qualification-batch-unsafe';
  const last = 'qualification-batch-safe-last';
  const content = `private-batch x😀${String.fromCharCode(0)} private-tail`;
  const result = await client.callTool({
    name: 'write',
    arguments: {
      documents: [
        { path: first, content: '# First safe\n', position: 'replace' },
        { path: unsafe, content, position: 'replace' },
        { path: last, content: '# Last safe\n', position: 'replace' },
      ],
    },
  });
  expect(result.isError).toBe(true);
  const structured = result.structuredContent as
    | { documents?: Array<{ docName: string; ok: boolean; error?: string }> }
    | undefined;
  expect(structured?.documents?.map(({ docName, ok }) => ({ docName, ok }))).toEqual([
    { docName: first, ok: true },
    { docName: unsafe, ok: false },
    { docName: last, ok: true },
  ]);
  expect(readFileSync(join(root, `${first}.md`), 'utf8')).toBe('# First safe\n');
  expect(readFileSync(join(root, `${last}.md`), 'utf8')).toBe('# Last safe\n');
  expect(existsSync(join(root, `${unsafe}.md`))).toBe(false);
  const refusal = structured?.documents?.find((doc) => doc.docName === unsafe)?.error;
  expect(refusal).toBeDefined();
  expectFullFieldRefusal(
    { isError: result.isError, content: refusal },
    0,
    content.indexOf('\u0000'),
  );
});
