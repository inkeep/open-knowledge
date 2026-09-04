import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createTestClient,
  createTestServer,
  HARNESS_BOOT_TIMEOUT_MS,
  pollUntil,
  type TestServer,
  wait,
} from './test-harness.ts';

let server: TestServer | undefined;

afterEach(async () => {
  if (server) {
    await server.cleanup();
    server = undefined;
  }
});

function seedContentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-template-gate-'));
  mkdirSync(resolve(dir, '.ok'), { recursive: true });
  writeFileSync(resolve(dir, '.ok', 'config.yml'), '', 'utf-8');
  return dir;
}

function serverDoc(rig: TestServer, docName: string) {
  return rig.instance.hocuspocus.documents.get(docName);
}

function lifecycleStatus(rig: TestServer, docName: string): unknown {
  return serverDoc(rig, docName)?.getMap('lifecycle').get('status');
}

describe('template tombstone quarantine (FR3)', () => {
  test(
    'a stale __template__ doc opened live seeds nothing, no-ops on write, and creates no file',
    async () => {
      server = await createTestServer({ debounce: 100, maxDebounce: 400 });
      const rig = server;
      const folder = `notes-${randomUUID().slice(0, 8)}`;
      const name = `daily-${randomUUID().slice(0, 8)}`;
      const syntheticName = `__template__/${folder}/${name}`;

      const client = await createTestClient(rig.port, syntheticName, {
        skipInvariantWatcher: true,
      });
      expect(client.ytext.toString()).toBe('');

      client.doc.transact(() =>
        client.ytext.insert(client.ytext.length, 'stale synthetic write\n'),
      );
      await pollUntil(
        () =>
          serverDoc(rig, syntheticName)?.getText('source').toString().includes('stale synthetic') ??
          false,
        8000,
      );

      await wait(700);

      expect(existsSync(join(rig.contentDir, '__template__', folder, `${name}.md`))).toBe(false);
      expect(existsSync(join(rig.contentDir, folder, '.ok', 'templates', `${name}.md`))).toBe(
        false,
      );
      expect(existsSync(join(rig.contentDir, '__template__'))).toBe(false);

      await client.cleanup();
    },
    HARNESS_BOOT_TIMEOUT_MS + 30_000,
  );
});

describe('template live conflict gate (FR5)', () => {
  test(
    'conflict markers in a template file make the live gate refuse PUT, move, DELETE, and import (previously dead)',
    async () => {
      const name = `tpl-${randomUUID().slice(0, 8)}`;
      const docName = `.ok/templates/${name}`;
      const contentDir = seedContentDir();
      const tplFile = resolve(contentDir, '.ok', 'templates', `${name}.md`);
      const clean = '---\ntitle: T\ndescription: initial\n---\n\n# Template\n\nv1.\n';
      mkdirSync(resolve(tplFile, '..'), { recursive: true });
      writeFileSync(tplFile, clean, 'utf-8');

      const srcName = `imp-src-${randomUUID().slice(0, 8)}`;
      writeFileSync(resolve(contentDir, `${srcName}.md`), '# Source\n\nimport me.\n', 'utf-8');

      server = await createTestServer({ contentDir, debounce: 100, maxDebounce: 400 });
      const rig = server;

      const client = await createTestClient(rig.port, docName, { skipInvariantWatcher: true });
      await pollUntil(() => client.ytext.toString() === clean, 8000);

      const conflicted =
        '---\ntitle: T\ndescription: initial\n---\n\n# Template\n\n<<<<<<< HEAD\nours.\n=======\ntheirs.\n>>>>>>> branch\n';
      writeFileSync(tplFile, conflicted, 'utf-8');
      await pollUntil(() => lifecycleStatus(rig, docName) === 'conflict', 15000);

      const put = await fetch(`http://127.0.0.1:${rig.port}/api/template`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: '', name, body: '# clobber', frontmatter: { title: 'X' } }),
      });
      expect(put.status).toBe(409);
      expect(put.headers.get('content-type')).toBe('application/problem+json');
      expect(((await put.json()) as { type: string }).type).toBe('urn:ok:error:doc-in-conflict');

      const movedName = `${name}moved`;
      const move = await fetch(`http://127.0.0.1:${rig.port}/api/template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromFolder: '', fromName: name, toFolder: '', toName: movedName }),
      });
      expect(move.status).toBe(409);
      expect(((await move.json()) as { type: string }).type).toBe('urn:ok:error:doc-in-conflict');

      const del = await fetch(
        `http://127.0.0.1:${rig.port}/api/template?folder=&name=${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      );
      expect(del.status).toBe(409);
      expect(((await del.json()) as { type: string }).type).toBe('urn:ok:error:doc-in-conflict');

      const imp = await fetch(`http://127.0.0.1:${rig.port}/api/template/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath: srcName, name, targetFolder: '' }),
      });
      expect(imp.status).toBe(409);
      expect(((await imp.json()) as { type: string }).type).toBe('urn:ok:error:doc-in-conflict');

      expect(readFileSync(tplFile, 'utf-8')).toBe(conflicted);
      expect(existsSync(resolve(contentDir, '.ok', 'templates', `${movedName}.md`))).toBe(false);

      await client.cleanup();
    },
    HARNESS_BOOT_TIMEOUT_MS + 30_000,
  );
});
