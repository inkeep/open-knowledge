import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTestClient, createTestServer, type TestServer } from './test-harness.ts';

describe('skill + template CRDT docs — end to end', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await createTestServer();
  });
  afterEach(async () => {
    await server.cleanup();
  });

  async function pollFor(path: string, timeoutMs = 3000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (existsSync(path)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return existsSync(path);
  }

  test('editing a project skill content doc persists Y.Text verbatim to .ok/skills/<n>/SKILL.md', async () => {
    const docName = '.ok/skills/demo-skill/SKILL';
    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });

    const src = '---\nname: demo-skill\ndescription: a demo\n---\n\n# Demo\n\nBody.\n';
    client.doc.transact(() => client.ytext.insert(0, src));

    const skillFile = resolve(server.contentDir, '.ok', 'skills', 'demo-skill', 'SKILL.md');
    expect(await pollFor(skillFile)).toBe(true);
    expect(readFileSync(skillFile, 'utf-8')).toBe(src);

    await client.cleanup();
  });

  test('a project skill on disk loads its content into a fresh client', async () => {
    const docName = '.ok/skills/roundtrip/SKILL';
    const src = '---\nname: roundtrip\ndescription: rt\n---\n\nHello.\n';

    const skillFile = resolve(server.contentDir, '.ok', 'skills', 'roundtrip', 'SKILL.md');
    mkdirSync(resolve(skillFile, '..'), { recursive: true });
    writeFileSync(skillFile, src, 'utf-8');

    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    const start = Date.now();
    while (Date.now() - start < 3000 && client.ytext.toString() !== src) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(client.ytext.toString()).toBe(src);
    await client.cleanup();
  });

  test('an external SKILL.md disk edit reconciles into the open project skill doc', async () => {
    await server.cleanup();
    const seedDir = mkdtempSync(join(tmpdir(), 'ok-skill-reconcile-'));
    mkdirSync(resolve(seedDir, '.ok'), { recursive: true });
    writeFileSync(resolve(seedDir, '.ok', 'config.yml'), '', 'utf-8');
    const skillFile = resolve(seedDir, '.ok', 'skills', 'watched', 'SKILL.md');
    const src = '---\nname: watched\ndescription: initial\n---\n\n# Watched\n\nv1.\n';
    mkdirSync(resolve(skillFile, '..'), { recursive: true });
    writeFileSync(skillFile, src, 'utf-8');
    server = await createTestServer({ contentDir: seedDir });

    const docName = '.ok/skills/watched/SKILL';
    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    const loadStart = Date.now();
    while (Date.now() - loadStart < 5000 && client.ytext.toString() !== src) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(client.ytext.toString()).toBe(src);

    const edited = '---\nname: watched\ndescription: edited externally\n---\n\n# Watched\n\nv2.\n';
    const start = Date.now();
    while (Date.now() - start < 15000 && client.ytext.toString() !== edited) {
      writeFileSync(skillFile, edited, 'utf-8');
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(client.ytext.toString()).toBe(edited);

    await client.cleanup();
  }, 30_000);

  test('PUT /api/skill creates IN-PLACE, then routes edits through the open real doc', async () => {
    const createRes = await fetch(`http://127.0.0.1:${server.port}/api/skill`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'put-routed',
        body: '# Routed\n\nVia CRDT.\n',
        frontmatter: { name: 'put-routed', description: 'Use when proving the CRDT write path.' },
      }),
    });
    expect(createRes.status).toBe(200);
    const createBody = (await createRes.json()) as { path: string; created: boolean };
    expect(createBody.created).toBe(true);
    expect(createBody.path.startsWith('.ok/skills/')).toBe(false);
    const skillFile = resolve(server.contentDir, createBody.path);
    expect(await pollFor(skillFile)).toBe(true);

    const docName = createBody.path.replace(/\.md$/i, '');
    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    const editRes = await fetch(`http://127.0.0.1:${server.port}/api/skill`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'put-routed',
        body: '# Routed\n\nEdited via CRDT.\n',
        frontmatter: { name: 'put-routed', description: 'Use when proving the CRDT write path.' },
      }),
    });
    expect(editRes.status).toBe(200);

    const expected =
      '---\nname: put-routed\ndescription: Use when proving the CRDT write path.\n---\n# Routed\n\nEdited via CRDT.\n';
    const start = Date.now();
    while (Date.now() - start < 5000 && client.ytext.toString() !== expected) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(client.ytext.toString()).toBe(expected);
    expect(readFileSync(skillFile, 'utf-8')).toBe(expected);

    await client.cleanup();
  });

  test('a template content doc persists to <folder>/.ok/templates/<name>.md', async () => {
    const docName = '.ok/templates/daily-note';
    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });

    const src = '---\ntitle: Daily Note\ndescription: a daily note\n---\n\n# {{date}}\n\nNotes.\n';
    client.doc.transact(() => client.ytext.insert(0, src));

    const tplFile = resolve(server.contentDir, '.ok', 'templates', 'daily-note.md');
    expect(await pollFor(tplFile)).toBe(true);
    expect(readFileSync(tplFile, 'utf-8')).toBe(src);

    await client.cleanup();
  });

  test('PUT /api/template routes the body through the open CRDT doc (Slice E)', async () => {
    const docName = 'notes/.ok/templates/meeting';
    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });

    const res = await fetch(`http://127.0.0.1:${server.port}/api/template`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folder: 'notes',
        name: 'meeting',
        body: '# Agenda\n\n- item\n',
        frontmatter: { title: 'Meeting', description: 'Use for meeting notes.' },
      }),
    });
    expect(res.status).toBe(200);

    const expected =
      '---\ntemplate:\n  title: Meeting\n  description: Use for meeting notes.\n---\n# Agenda\n\n- item\n';
    const start = Date.now();
    while (Date.now() - start < 5000 && client.ytext.toString() !== expected) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(client.ytext.toString()).toBe(expected);

    const tplFile = resolve(server.contentDir, 'notes', '.ok', 'templates', 'meeting.md');
    expect(await pollFor(tplFile)).toBe(true);
    expect(readFileSync(tplFile, 'utf-8')).toBe(expected);

    await client.cleanup();
  });

  test('an external template .md disk edit reconciles into the open doc', async () => {
    await server.cleanup();
    const seedDir = mkdtempSync(join(tmpdir(), 'ok-template-reconcile-'));
    mkdirSync(resolve(seedDir, '.ok'), { recursive: true });
    writeFileSync(resolve(seedDir, '.ok', 'config.yml'), '', 'utf-8');
    const tplFile = resolve(seedDir, '.ok', 'templates', 'daily.md');
    const src = '---\ntitle: Daily\ndescription: initial\n---\n\n# {{date}}\n';
    mkdirSync(resolve(tplFile, '..'), { recursive: true });
    writeFileSync(tplFile, src, 'utf-8');
    server = await createTestServer({ contentDir: seedDir });

    const docName = '.ok/templates/daily';
    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    const loadStart = Date.now();
    while (Date.now() - loadStart < 5000 && client.ytext.toString() !== src) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(client.ytext.toString()).toBe(src);

    const edited =
      '---\ntitle: Daily\ndescription: edited externally\n---\n\n# {{date}}\n\nMore.\n';
    const start = Date.now();
    while (Date.now() - start < 15000 && client.ytext.toString() !== edited) {
      writeFileSync(tplFile, edited, 'utf-8');
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(client.ytext.toString()).toBe(edited);

    await client.cleanup();
  }, 30_000);
});
