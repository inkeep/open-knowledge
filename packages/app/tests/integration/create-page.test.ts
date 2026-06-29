import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

async function createPage(path: string) {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/create-page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const body = (await res.json()) as {
    docName?: string;
    type?: string;
    title?: string;
  };
  return { status: res.status, body };
}

describe('/api/create-page — simple file', () => {
  test('creates a file at root and returns docName', async () => {
    const { status, body } = await createPage('qa-simple-root.md');
    expect(status).toBe(200);
    expect(body.docName).toBe('qa-simple-root');
    expect(existsSync(join(server.contentDir, 'qa-simple-root.md'))).toBe(true);
    expect(readFileSync(join(server.contentDir, 'qa-simple-root.md'), 'utf-8')).toBe('');
  });

  test('creates a file in an existing subdirectory', async () => {
    await createPage('qa-pre/seed.md');
    const { status, body } = await createPage('qa-pre/child.md');
    expect(status).toBe(200);
    expect(body.docName).toBe('qa-pre/child');
    expect(existsSync(join(server.contentDir, 'qa-pre/child.md'))).toBe(true);
  });
});

describe('/api/create-page — composite folder create (mkdirSync recursive)', () => {
  test('creates a new folder with an initial file in one round-trip', async () => {
    const { status, body } = await createPage('qa-new-folder/index.md');
    expect(status).toBe(200);
    expect(body.docName).toBe('qa-new-folder/index');
    expect(existsSync(join(server.contentDir, 'qa-new-folder'))).toBe(true);
    expect(existsSync(join(server.contentDir, 'qa-new-folder/index.md'))).toBe(true);
  });

  test('creates deep, multi-level folder path that did not previously exist (QA-012)', async () => {
    const { status, body } = await createPage('deep/nested/folders/that/are/new/home.md');
    expect(status).toBe(200);
    expect(body.docName).toBe('deep/nested/folders/that/are/new/home');
    expect(existsSync(join(server.contentDir, 'deep/nested/folders/that/are/new/home.md'))).toBe(
      true,
    );
  });
});

describe('/api/create-page — 409 EEXIST (QA-008)', () => {
  test('second create at the same path returns 409 with structured error', async () => {
    const path = 'qa-conflict.md';
    const first = await createPage(path);
    expect(first.status).toBe(200);
    expect(first.body.docName).toBe('qa-conflict');

    const second = await createPage(path);
    expect(second.status).toBe(409);
    expect(second.body.type).toBe('urn:ok:error:doc-already-exists');
    expect(second.body.title).toMatch(/already exists/i);
  });
});

describe('/api/create-page — path rejection (QA-009)', () => {
  test('rejects ".." traversal', async () => {
    const { status, body } = await createPage('docs/../escape.md');
    expect(status).toBe(400);
    expect(body.type).toBe('urn:ok:error:path-escape');
  });

  test('rejects leading /', async () => {
    const { status, body } = await createPage('/etc/passwd.md');
    expect(status).toBe(400);
    expect(body.type).toBe('urn:ok:error:path-escape');
  });

  test('rejects backslashes', async () => {
    const { status, body } = await createPage('docs\\winpath.md');
    expect(status).toBe(400);
    expect(body.type).toBe('urn:ok:error:path-escape');
  });

  test('rejects null byte', async () => {
    const { status, body } = await createPage('docs/\0nul.md');
    expect(status).toBe(400);
    expect(body.type).toBe('urn:ok:error:path-escape');
  });

  test('rejects missing .md extension', async () => {
    const { status, body } = await createPage('no-extension');
    expect(status).toBe(400);
    expect(body.type).toBe('urn:ok:error:invalid-request');
    expect(body.title).toMatch(/\.md/i);
  });
});

describe('/api/create-page — reserved name (QA-010)', () => {
  test('rejects __system__ with 400', async () => {
    const { status, body } = await createPage('__system__.md');
    expect(status).toBe(400);
    expect(body.type).toBe('urn:ok:error:reserved-doc-name');
    expect(body.title).toMatch(/reserved/i);
  });
});

describe('/api/create-page — template seeding', () => {
  async function createPageWithTemplate(path: string, template: string) {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/create-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, template }),
    });
    const body = (await res.json()) as { docName?: string; type?: string; title?: string };
    return { status: res.status, body };
  }

  function seedRootTemplate(name: string, contents: string) {
    const dir = join(server.contentDir, '.ok', 'templates');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), contents, 'utf-8');
  }

  test('seeds the new file from the resolved template body (frontmatter stripped, {{date}} substituted)', async () => {
    seedRootTemplate(
      'seeded-tpl',
      '---\ntitle: Meeting\n---\n# Meeting Notes\n\nCreated on {{date}}.\n',
    );
    const { status, body } = await createPageWithTemplate('from-template.md', 'seeded-tpl');
    expect(status).toBe(200);
    expect(body.docName).toBe('from-template');

    const created = readFileSync(join(server.contentDir, 'from-template.md'), 'utf-8');
    expect(created).toContain('# Meeting Notes');
    expect(created).toContain('Created on ');
    expect(created).not.toContain('title: Meeting');
    expect(created).not.toContain('{{date}}');
    expect(created).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  test('single-block template: strips `template:` identity, keeps doc-frontmatter, substitutes tokens', async () => {
    seedRootTemplate(
      'research-tpl',
      '---\ntemplate:\n  title: Research Log\n  description: provisional\ntype: research-note\nstatus: provisional\ncreated: {{date}}\ntags: [research]\n---\n\n## Question\n',
    );
    const { status } = await createPageWithTemplate('from-single-block.md', 'research-tpl');
    expect(status).toBe(200);

    const created = readFileSync(join(server.contentDir, 'from-single-block.md'), 'utf-8');
    expect(created).toContain('type: research-note');
    expect(created).toContain('status: provisional');
    expect(created).toContain('## Question');
    expect(created).not.toContain('template:');
    expect(created).not.toContain('title: Research Log');
    expect(created).not.toContain('{{date}}');
    expect(created).toMatch(/created: \d{4}-\d{2}-\d{2}/);
  });

  test('returns 400 when the template name does not resolve', async () => {
    const { status, body } = await createPageWithTemplate('no-such-tpl.md', 'does-not-exist');
    expect(status).toBe(400);
    expect(body.type).toBe('urn:ok:error:invalid-request');
    expect(body.title).toMatch(/does not resolve/i);
    expect(existsSync(join(server.contentDir, 'no-such-tpl.md'))).toBe(false);
  });

  test('returns 400 when the template name has invalid characters', async () => {
    const { status, body } = await createPageWithTemplate('bad-tpl-name.md', 'bad name!');
    expect(status).toBe(400);
    expect(body.type).toBe('urn:ok:error:invalid-request');
    expect(body.title).toMatch(/must match/i);
  });
});
