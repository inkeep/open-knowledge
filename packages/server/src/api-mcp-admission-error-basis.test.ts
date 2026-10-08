import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const historical = 'private-history x😀\u0000 middle \u001f tail.\n';
const clean = historical.replace('\u0000', '\\u0000').replace('\u001f', '\\u001F');
let root: string;
let server: BootedServer;
let client: Client;

function artifactPath(kind: 'template' | 'skill', name: string) {
  return kind === 'template'
    ? join(root, 'templates', '.ok', 'templates', `${name}.md`)
    : join(root, '.agents', 'skills', name, 'SKILL.md');
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>) {
  return JSON.stringify(result.content);
}

function expectAdmission(text: string, code: number, offset: number) {
  expect.soft(text).toContain(`U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
  expect.soft(text).toMatch(/UTF-?16/i);
  expect.soft(text).toMatch(new RegExp(`offset\\D*${offset}\\b`, 'i'));
  expect.soft(text).not.toContain('private-history');
  expect.soft(text).not.toContain('private-tail');
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ok-mcp-basis-'));
  for (const kind of ['template', 'skill'] as const) {
    for (const operation of ['metadata', 'partial']) {
      const name = `basis-${kind}-${operation}`;
      const path = artifactPath(kind, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        kind === 'template'
          ? `---\ntitle: Historical\n---\n${historical}`
          : `---\nname: ${name}\ndescription: Historical\n---\n${historical}`,
      );
    }
  }
  const builtin = artifactPath('skill', 'open-knowledge');
  mkdirSync(dirname(builtin), { recursive: true });
  writeFileSync(builtin, '---\nname: open-knowledge\ndescription: Project\n---\nProject.\n');
  const bundle = artifactPath('skill', 'basis-skill-bundle');
  mkdirSync(join(dirname(bundle), 'references'), { recursive: true });
  writeFileSync(bundle, '---\nname: basis-skill-bundle\ndescription: Project\n---\nProject.\n');
  writeFileSync(
    join(dirname(bundle), 'references', 'historical.md'),
    '---\ntitle: Historical\n---\nprivate-history x😀\u0001 middle \u001f tail.\n',
  );
  server = await bootArtifactAdmissionRig(root);
  client = await connectMcpTestClient(`http://127.0.0.1:${server.port}/mcp`);
}, 60_000);

afterAll(async () => {
  await client?.close();
  await server?.destroy();
  rmSync(root, { recursive: true, force: true });
});

describe.each(['template', 'skill'] as const)('%s real admission error basis', (kind) => {
  test('full writes name the submitted field without claiming a replace argument', async () => {
    const name = `basis-new-${kind}`;
    const content = 'x😀\u0000private-tail';
    const target =
      kind === 'template'
        ? { template: { path: `templates/${name}`, content, frontmatter: { title: 'Basis' } } }
        : { skill: { name, description: 'Basis', body: content } };
    const result = await client.callTool({ name: 'write', arguments: target });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expectAdmission(text, 0, 3);
    expect
      .soft(text)
      .toMatch(
        kind === 'template'
          ? /offset[^.]*full submitted template\.content/i
          : /offset[^.]*full submitted skill body/i,
      );
    expect.soft(text).not.toMatch(/not just replace/i);
  });

  test.each(['metadata', 'partial'] as const)(
    '%s edits identify the resubmitted stored body and cleaned full-write repair',
    async (operation) => {
      const name = `basis-${kind}-${operation}`;
      const path = artifactPath(kind, name);
      const original = readFileSync(path);
      await settleArtifactContributors(server);
      const contributors = __formatContributorsForTests();
      const edit =
        operation === 'partial'
          ? { find: '\u0000', replace: '\\u0000' }
          : kind === 'template'
            ? { frontmatter: { description: 'Updated' } }
            : { description: 'Updated' };
      const target =
        kind === 'template'
          ? { template: { path: `templates/${name}`, ...edit } }
          : { skill: { name, ...edit } };
      const result = await client.callTool({ name: 'edit', arguments: target });
      expect(result.isError).toBe(true);
      const text = textOf(result);
      const resubmitted =
        operation === 'partial' ? historical.replace('\u0000', '\\u0000') : historical;
      const code = operation === 'partial' ? 31 : 0;
      expectAdmission(text, code, resubmitted.indexOf(String.fromCharCode(code)));
      expect
        .soft(text)
        .toMatch(/full[^.]*stored[^.]*body[^.]*resubmit|resubmit[^.]*full[^.]*stored[^.]*body/i);
      expect.soft(text).toMatch(/clean[^.]*full[^.]*replac/i);
      expect.soft(text).toMatch(/write\s*\(/i);
      expect.soft(text).toContain(kind);
      if (operation === 'metadata') expect.soft(text).not.toMatch(/not just replace/i);
      expect.soft(readFileSync(path)).toEqual(original);
      expect.soft(__formatContributorsForTests()).toBe(contributors);
      const cleanedTarget =
        kind === 'template'
          ? {
              template: {
                path: `templates/${name}`,
                content: clean,
                frontmatter: { title: 'Clean' },
              },
            }
          : { skill: { name, description: 'Clean', body: clean } };
      const repaired = await client.callTool({ name: 'write', arguments: cleanedTarget });
      expect.soft(repaired.isError, textOf(repaired)).not.toBe(true);
      const raw = readFileSync(path, 'utf8');
      expect
        .soft(kind === 'template' ? instantiateDoc(raw) : stripFrontmatter(raw).body)
        .toBe(clean);
    },
  );
});

test('real Markdown bundle admission names the whole submitted content', async () => {
  const result = await client.callTool({
    name: 'write',
    arguments: {
      skill: {
        name: 'basis-skill-metadata',
        files: [
          { path: 'references/basis.md', content: '---\ntitle: Basis\n---\nx😀\u0000private-tail' },
        ],
      },
    },
  });
  expect(result.isError).toBe(true);
  const text = textOf(result);
  expectAdmission(text, 0, '---\ntitle: Basis\n---\nx😀'.length);
  expect.soft(text).toMatch(/offset[^.]*whole submitted file content[^.]*frontmatter/i);
});

test.each(['references/absent.md', 'scripts/absent.sh', 'assets/absent.svg'])(
  'real missing-skill failure has no admission offset advice for %s',
  async (path) => {
    const result = await client.callTool({
      name: 'write',
      arguments: { skill: { name: 'basis-does-not-exist', files: [{ path, content: 'Safe.' }] } },
    });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect.soft(text).toMatch(/not found/i);
    expect.soft(text).not.toMatch(/(?:body|content) offset|full submitted|whole submitted/i);
  },
);

test('real Markdown bundle edit identifies the resubmitted stored file and clean full-write repair', async () => {
  const path = join(
    dirname(artifactPath('skill', 'basis-skill-bundle')),
    'references',
    'historical.md',
  );
  const original = readFileSync(path, 'utf8');
  const result = await client.callTool({
    name: 'edit',
    arguments: {
      skill: {
        name: 'basis-skill-bundle',
        file: 'references/historical.md',
        find: '\u0001',
        replace: '\\u0001',
      },
    },
  });
  expect(result.isError).toBe(true);
  const text = textOf(result);
  const resubmitted = original.replace('\u0001', '\\u0001');
  expectAdmission(text, 31, resubmitted.indexOf('\u001f'));
  expect
    .soft(text)
    .toMatch(
      /full[^.]*stored[^.]*(?:file|content)[^.]*resubmit|resubmit[^.]*full[^.]*stored[^.]*(?:file|content)/i,
    );
  expect.soft(text).toMatch(/clean[^.]*full[^.]*replac/i);
  expect.soft(text).toMatch(/write\s*\(/i);
  expect.soft(readFileSync(path, 'utf8')).toBe(original);
  const cleaned = resubmitted.replace('\u001f', '\\u001F');
  const repaired = await client.callTool({
    name: 'write',
    arguments: {
      skill: {
        name: 'basis-skill-bundle',
        files: [{ path: 'references/historical.md', content: cleaned }],
      },
    },
  });
  expect.soft(repaired.isError, textOf(repaired)).not.toBe(true);
  expect.soft(readFileSync(path, 'utf8')).toBe(cleaned);
});
