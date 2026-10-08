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
import { rawRequest } from './composition-rig.test-helper.ts';
import { __formatContributorsForTests } from './contributor-tracker.ts';
import { connectMcpTestClient } from './mcp/client.test-helper.ts';

type ArtifactKind = 'template' | 'skill';
const routes = [
  { label: 'PUT /api/template', kind: 'template', method: 'PUT' },
  { label: 'POST /api/template', kind: 'template', method: 'POST' },
  { label: 'PUT /api/skill', kind: 'skill', method: 'PUT' },
  { label: 'POST /api/skill', kind: 'skill', method: 'POST' },
] as const;
const allowed = 'Exact \t whitespace\r\nPrintable \\u0000 \\u001F 😀\u007f\u0080\u009f.\n';
const historical = `Historical ${String.fromCharCode(0, 31)} bytes stay.\r\n`;
const generatedPrefix = '---\ntitle: Generated\n---\nExpanded x😀';
let root: string;
let server: BootedServer;
let client: Client;
let sequence = 0;
const nextName = () => `body-admission-${++sequence}`;
const unsafe = (code: number) => `private-prefix😀${String.fromCharCode(code)}private-tail`;

function artifactPath(kind: ArtifactKind, name: string): string {
  return kind === 'template'
    ? join(root, 'templates', '.ok', 'templates', `${name}.md`)
    : join(root, '.agents', 'skills', name, 'SKILL.md');
}

function putBody(kind: ArtifactKind, name: string, body: string): object {
  return kind === 'template'
    ? { folder: 'templates', name, body, frontmatter: { title: 'Admission' } }
    : { scope: 'project', name, body, frontmatter: { name, description: 'Admission' } };
}

function moveBody(kind: ArtifactKind, fromName: string, toName: string): object {
  return kind === 'template'
    ? { fromFolder: 'templates', fromName, toFolder: 'templates', toName }
    : { scope: 'project', fromName, toName };
}

function editedMoveBody(kind: ArtifactKind, fromName: string, toName: string, body: string) {
  return {
    ...moveBody(kind, fromName, toName),
    body,
    ...(kind === 'template' ? { frontmatter: { title: 'Admission' } } : {}),
  };
}

function request(kind: ArtifactKind, method: string, body: object) {
  return rawRequest(server.port, `/api/${kind}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createArtifact(kind: ArtifactKind, name: string, body = 'Existing target.\n') {
  const response = await request(kind, 'PUT', putBody(kind, name, body));
  expect(response.status, response.body).toBe(200);
  const result = JSON.parse(response.body) as { path: string };
  expect(join(root, result.path)).toBe(artifactPath(kind, name));
  expect(existsSync(artifactPath(kind, name))).toBe(true);
}

function expectControlDetail(text: string, code: number) {
  expect.soft(text).toContain(`U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
  expect.soft(text).toMatch(/UTF-?16/i);
  expect.soft(text.length).toBeLessThan(2048);
  expect.soft(text).not.toContain('private-prefix');
  expect.soft(text).not.toContain('private-tail');
  expect.soft(text).not.toContain(String.fromCharCode(code));
}

function expectActionableRefusal(result: { isError?: boolean; content?: unknown }, code: number) {
  expect.soft(result.isError).toBe(true);
  const text = JSON.stringify(result.content);
  expectControlDetail(text, code);
  expect.soft(text).not.toMatch(/Error:\s*undefined/i);
  expect.soft(text).toMatch(/\bTAB\b/i);
  expect.soft(text).toMatch(/\bLF\b/i);
  expect.soft(text).toMatch(/\bCR\b/i);
  expect.soft(text).toMatch(/remove|replace/i);
  expect.soft(text).toMatch(/escap|printable/i);
  return text;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ok-artifact-body-admission-'));
  mkdirSync(join(root, 'templates'));
  for (const kind of ['template', 'skill'] as const) {
    for (const metadata of [false, true]) {
      const name = `historical-${kind}${metadata ? '-metadata' : ''}`;
      const path = artifactPath(kind, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        kind === 'template'
          ? `---\ntemplate:\n  title: Historical\n---\n${historical}`
          : `---\nname: ${name}\ndescription: Historical\n---\n${historical}`,
      );
    }
  }
  const builtin = artifactPath('skill', 'open-knowledge');
  mkdirSync(dirname(builtin), { recursive: true });
  writeFileSync(
    builtin,
    '---\nname: open-knowledge\ndescription: Project instructions\n---\nProject.\n',
  );
  const template = artifactPath('template', 'historical-generated');
  writeFileSync(
    template,
    `---\ntitle: Generator\n---\n${generatedPrefix}${String.fromCharCode(0)}private-tail\n`,
  );
  writeFileSync(
    artifactPath('template', 'legacy-edit'),
    '---\ntitle: Legacy\n---\nExisting target.\n',
  );
  server = await bootArtifactAdmissionRig(root);
  await server.ready;
  client = await connectMcpTestClient(`http://127.0.0.1:${server.port}/mcp`);
}, 60_000);

afterAll(async () => {
  await client?.close();
  await server?.destroy();
  rmSync(root, { recursive: true, force: true });
});

describe.each(routes)('$label incoming body over real HTTP', ({ kind, method }) => {
  test.each([0, 31])(
    'rejects decoded control %i before existing-body or destination mutation',
    async (code) => {
      const name = nextName();
      const destination = nextName();
      await createArtifact(kind, name);
      const path = artifactPath(kind, name);
      const original = readFileSync(path);
      await settleArtifactContributors(server);
      const contributors = __formatContributorsForTests();
      const payload =
        method === 'PUT'
          ? putBody(kind, name, unsafe(code))
          : editedMoveBody(kind, name, destination, unsafe(code));
      const response = await request(kind, method, {
        ...payload,
        agentId: nextName(),
        summary: 'Must not land',
      });
      expect.soft(response.status, response.body).toBe(400);
      expect.soft(response.headers['content-type']).toContain('application/problem+json');
      expectControlDetail(response.body, code);
      expect.soft(existsSync(path)).toBe(true);
      if (existsSync(path)) expect.soft(readFileSync(path)).toEqual(original);
      expect.soft(existsSync(artifactPath(kind, destination))).toBe(false);
      expect.soft(__formatContributorsForTests()).toBe(contributors);
    },
  );

  test('preserves admitted whitespace, printable escapes, DEL and C1 bytes', async () => {
    const name = nextName();
    const destination = nextName();
    await createArtifact(kind, name);
    const payload =
      method === 'PUT'
        ? putBody(kind, name, allowed)
        : editedMoveBody(kind, name, destination, allowed);
    const response = await request(kind, method, payload);
    expect(response.status, response.body).toBe(200);
    const finalName = method === 'PUT' ? name : destination;
    const raw = readFileSync(artifactPath(kind, finalName), 'utf8');
    expect(kind === 'template' ? instantiateDoc(raw) : stripFrontmatter(raw).body).toBe(allowed);
    const query = kind === 'template' ? '?folder=templates&name=' : '?scope=project&name=';
    const read = await rawRequest(server.port, `/api/${kind}${query}${finalName}`);
    expect(read.status, read.body).toBe(200);
    const data = JSON.parse(read.body) as { template?: { body: string }; skill?: { body: string } };
    expect(data[kind]?.body).toBe(allowed);
  });
});

describe.each(['template', 'skill'] as const)(
  '%s body admission through registered MCP tools',
  (kind) => {
    test.each([0, 31])('refuses decoded control %i before creating an artifact', async (code) => {
      const name = nextName();
      await settleArtifactContributors(server);
      const contributors = __formatContributorsForTests();
      const response = await request(kind, 'PUT', {
        ...putBody(kind, name, unsafe(code)),
        agentId: name,
      });
      expect.soft(response.status, response.body).toBe(400);
      expectControlDetail(response.body, code);
      expect.soft(existsSync(artifactPath(kind, name))).toBe(false);
      expect.soft(__formatContributorsForTests()).toBe(contributors);
    });

    test.each([false, true])(
      'body-omitted moves preserve historical raw body bytes (metadata=%s)',
      async (metadata) => {
        const name = `historical-${kind}${metadata ? '-metadata' : ''}`;
        const path = artifactPath(kind, name);
        const original = readFileSync(path, 'utf8');
        expect(original).toContain(historical);
        const destination = nextName();
        const response = await request(kind, 'POST', {
          ...moveBody(kind, name, destination),
          ...(metadata
            ? {
                frontmatter:
                  kind === 'template'
                    ? { title: 'Updated' }
                    : { name: destination, description: 'Updated' },
              }
            : {}),
        });
        expect(response.status, response.body).toBe(200);
        expect(existsSync(path)).toBe(false);
        const raw = readFileSync(artifactPath(kind, destination), 'utf8');
        expect(kind === 'template' ? instantiateDoc(raw) : stripFrontmatter(raw).body).toBe(
          historical,
        );
        if (kind === 'template' && !metadata) expect(raw).toBe(original);
      },
    );

    test('write returns the actionable control detail without creating an artifact', async () => {
      const name = nextName();
      const target =
        kind === 'template'
          ? {
              template: {
                path: `templates/${name}`,
                content: unsafe(0),
                frontmatter: { title: 'Admission' },
              },
            }
          : { skill: { name, description: 'Admission', body: unsafe(0) } };
      const result = await client.callTool({ name: 'write', arguments: target });
      const text = expectActionableRefusal(result, 0);
      expect.soft(text).toMatch(/\bbody\b|\bcontent\b/i);
      expect.soft(text).toMatch(new RegExp(`offset\\D*${'private-prefix😀'.length}\\b`, 'i'));
      expect.soft(existsSync(artifactPath(kind, name))).toBe(false);
    });

    test('edit returns the actionable control detail without changing the existing body', async () => {
      const name = kind === 'template' ? 'legacy-edit' : nextName();
      if (kind === 'skill') await createArtifact(kind, name);
      const original = readFileSync(artifactPath(kind, name));
      const target =
        kind === 'template'
          ? { template: { path: `templates/${name}`, find: 'target', replace: unsafe(31) } }
          : { skill: { name, find: 'target', replace: unsafe(31) } };
      const result = await client.callTool({ name: 'edit', arguments: target });
      const text = expectActionableRefusal(result, 31);
      const bodyCoordinate = /\bbody\b/i.test(text) && /offset\D*25\b/i.test(text);
      const replacementCoordinate = /replace/i.test(text) && /offset\D*16\b/i.test(text);
      expect.soft(bodyCoordinate || replacementCoordinate, text).toBe(true);
      expect.soft(readFileSync(artifactPath(kind, name))).toEqual(original);
    });
  },
);

test('MCP frontmatter-composed write identifies the offset basis and remedy', async () => {
  const name = nextName();
  const content = `x😀${String.fromCharCode(0)}private-tail`;
  const result = await client.callTool({
    name: 'write',
    arguments: { document: { path: name, content, frontmatter: { title: 'Coordinates' } } },
  });
  const text = expectActionableRefusal(result, 0);
  const sourceCoordinate =
    /document\.content|`content`|\bcontent\s*:|\bcontent (?:argument|parameter)/i.test(text) &&
    /offset\D*3\b/i.test(text);
  const composedOffset = '---\ntitle: Coordinates\n---\nx😀'.length;
  const composedCoordinate =
    /compos|generat/i.test(text) &&
    /frontmatter/i.test(text) &&
    new RegExp(`offset\\D*${composedOffset}\\b`, 'i').test(text);
  expect.soft(sourceCoordinate || composedCoordinate, text).toBe(true);
  expect.soft(existsSync(join(root, `${name}.md`))).toBe(false);
});

test('non-Markdown skill scripts and assets retain opaque control bytes', async () => {
  const name = nextName();
  await createArtifact('skill', name);
  const content = `Opaque ${String.fromCharCode(0, 31)} bytes.\n`;
  for (const path of ['scripts/fixture.py', 'assets/data.bin']) {
    const response = await rawRequest(server.port, '/api/skill-file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'project', name, path, content }),
    });
    expect(response.status, response.body).toBe(200);
    expect(readFileSync(join(dirname(artifactPath('skill', name)), path), 'utf8')).toBe(content);
  }
});

test('MCP template-expanded write identifies generated Markdown coordinates and remedy', async () => {
  const name = nextName();
  const result = await client.callTool({
    name: 'write',
    arguments: { document: { path: `templates/${name}`, template: 'historical-generated' } },
  });
  const text = expectActionableRefusal(result, 0);
  expect.soft(text).toMatch(/compos|generat|expan|resolved template|template body/i);
  expect.soft(text).toMatch(/template/i);
  expect.soft(text).toMatch(new RegExp(`offset\\D*${generatedPrefix.length}\\b`, 'i'));
  expect.soft(existsSync(join(root, 'templates', `${name}.md`))).toBe(false);
});
