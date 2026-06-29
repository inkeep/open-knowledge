import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentListSuccessSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { awaitFileWatcherIndexed, createTestServer, type TestServer } from './test-harness';

let server: TestServer;

beforeAll(async () => {
  const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-show-all-')));

  writeFileSync(join(contentDir, 'README.md'), '# Readme\n');
  mkdirSync(join(contentDir, 'docs'), { recursive: true });
  writeFileSync(join(contentDir, 'docs', 'guide.md'), '# Guide\n');

  writeFileSync(join(contentDir, '.gitignore'), 'secrets/\nbuild/\n*.log\n');
  mkdirSync(join(contentDir, 'secrets'), { recursive: true });
  writeFileSync(join(contentDir, 'secrets', 'api-key.md'), 'sk-test\n');
  mkdirSync(join(contentDir, 'build'), { recursive: true });
  writeFileSync(join(contentDir, 'build', 'compiled.md'), '# Compiled\n');
  writeFileSync(join(contentDir, 'debug.log'), 'debug output\n');

  writeFileSync(join(contentDir, '.okignore'), 'drafts/\n');
  mkdirSync(join(contentDir, 'drafts'), { recursive: true });
  writeFileSync(join(contentDir, 'drafts', 'wip.md'), '# WIP\n');

  mkdirSync(join(contentDir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(contentDir, 'node_modules', 'pkg', 'README.md'), '# Pkg\n');
  mkdirSync(join(contentDir, '.git'), { recursive: true });
  writeFileSync(join(contentDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(join(contentDir, '.ok'), { recursive: true });
  writeFileSync(join(contentDir, '.ok', 'config.yml'), 'content:\n  dir: .\n');

  writeFileSync(join(contentDir, 'package.json'), '{"name":"test"}\n');
  mkdirSync(join(contentDir, 'src'), { recursive: true });
  writeFileSync(join(contentDir, 'src', 'index.ts'), 'export {}\n');
  writeFileSync(join(contentDir, 'analysis.py'), 'print("hi")\n');

  writeFileSync(join(contentDir, 'LICENSE'), 'MIT\n');

  writeFileSync(join(contentDir, '__system__.md'), '# Should not leak\n');
  mkdirSync(join(contentDir, '__config__'), { recursive: true });
  writeFileSync(join(contentDir, '__config__', 'project.md'), '# Should not leak\n');
  mkdirSync(join(contentDir, '__user__'), { recursive: true });
  writeFileSync(join(contentDir, '__user__', 'config.yml.md'), '# Should not leak\n');
  mkdirSync(join(contentDir, '__local__'), { recursive: true });
  writeFileSync(join(contentDir, '__local__', 'project.md'), '# Should not leak\n');

  server = await createTestServer({ contentDir, keepContentDir: false });
  await awaitFileWatcherIndexed(server, 'README');
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('/api/documents?showAll=true', () => {
  test("non-bypass request returns today's filtered view (no .gitignored / .okignored / BUILTIN_SKIP_DIRS)", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
    expect(res.ok).toBe(true);
    const body = DocumentListSuccessSchema.parse(await res.json());

    const docNames = body.documents.filter((e) => e.kind === 'document').map((e) => e.docName);

    expect(docNames).toContain('README');
    expect(docNames).toContain('docs/guide');

    expect(docNames).not.toContain('secrets/api-key');
    expect(docNames).not.toContain('build/compiled');
    expect(docNames).not.toContain('drafts/wip');

    expect(docNames).not.toContain('node_modules/pkg/README');
  });

  test('?showAll=true surfaces .gitignored / .okignored / content-bearing skip-dir markdown but prunes the always-skip floor', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents?showAll=true`);
    expect(res.ok).toBe(true);
    const body = DocumentListSuccessSchema.parse(await res.json());

    const docNames = body.documents.filter((e) => e.kind === 'document').map((e) => e.docName);

    expect(docNames).toContain('README');
    expect(docNames).toContain('docs/guide');

    expect(docNames).toContain('secrets/api-key');
    expect(docNames).toContain('build/compiled');

    expect(docNames).toContain('drafts/wip');

    expect(docNames).not.toContain('node_modules/pkg/README');
  });

  test('?showAll=true surfaces non-md / non-asset files as kind=asset', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents?showAll=true`);
    expect(res.ok).toBe(true);
    const body = DocumentListSuccessSchema.parse(await res.json());

    const pkgJson = body.documents.find((e) => e.kind === 'asset' && e.path === 'package.json');
    expect(pkgJson).toBeTruthy();
    expect(pkgJson?.assetExt).toBe('json');
    expect(pkgJson?.mediaKind).toBe('text');
    expect(pkgJson?.referencedBy).toEqual([]);

    const indexTs = body.documents.find((e) => e.kind === 'asset' && e.path === 'src/index.ts');
    expect(indexTs).toBeTruthy();
    expect(indexTs?.assetExt).toBe('ts');
    expect(indexTs?.mediaKind).toBe('text');

    const analysisPy = body.documents.find((e) => e.kind === 'asset' && e.path === 'analysis.py');
    expect(analysisPy).toBeTruthy();
    expect(analysisPy?.assetExt).toBe('py');

    const license = body.documents.find((e) => e.kind === 'asset' && e.path === 'LICENSE');
    expect(license).toBeTruthy();
    expect(license?.assetExt).toBe('file');

    const gitignore = body.documents.find((e) => e.kind === 'asset' && e.path === '.gitignore');
    expect(gitignore).toBeTruthy();
    expect(gitignore?.assetExt).toBe('gitignore');
  });

  test('?showAll=true emits folder entries for content dirs but prunes the always-skip floor (.git / node_modules / .ok)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents?showAll=true`);
    expect(res.ok).toBe(true);
    const body = DocumentListSuccessSchema.parse(await res.json());

    const folderPaths = body.documents.filter((e) => e.kind === 'folder').map((e) => e.path);

    expect(folderPaths).toContain('docs');
    expect(folderPaths).toContain('secrets');
    expect(folderPaths).toContain('build');
    expect(folderPaths).toContain('drafts');
    expect(folderPaths).toContain('src');

    expect(folderPaths).not.toContain('node_modules');
    expect(folderPaths).not.toContain('node_modules/pkg');
    expect(folderPaths).not.toContain('.git');
    expect(folderPaths).not.toContain('.ok');
  });

  test('STOP rule preserved — synthetic system + config docs stay hidden in bypass mode', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents?showAll=true`);
    expect(res.ok).toBe(true);
    const body = DocumentListSuccessSchema.parse(await res.json());

    const docNames = body.documents.filter((e) => e.kind === 'document').map((e) => e.docName);
    expect(docNames).not.toContain('__system__');
    expect(docNames).not.toContain('__config__/project');
    expect(docNames).not.toContain('__user__/config.yml');
    expect(docNames).not.toContain('__local__/project');

    for (const entry of body.documents) {
      const ref = (entry.kind === 'folder' ? entry.path : (entry.docName ?? entry.path)) ?? '';
      expect(ref).not.toBe('__system__');
      expect(ref).not.toBe('__system__.md');
      expect(ref).not.toBe('__config__/project');
      expect(ref).not.toBe('__config__/project.md');
      expect(ref).not.toBe('__user__/config.yml');
      expect(ref).not.toBe('__user__/config.yml.md');
      expect(ref).not.toBe('__local__/project');
      expect(ref).not.toBe('__local__/project.md');
    }
  });

  test('?showAll=true is per-request only — non-bypass call after bypass call still returns filtered view', async () => {
    const r1 = await fetch(`http://127.0.0.1:${server.port}/api/documents?showAll=true`);
    const b1 = DocumentListSuccessSchema.parse(await r1.json());
    expect(b1.documents.some((e) => e.kind === 'document' && e.docName === 'secrets/api-key')).toBe(
      true,
    );

    const r2 = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
    const b2 = DocumentListSuccessSchema.parse(await r2.json());
    expect(b2.documents.some((e) => e.kind === 'document' && e.docName === 'secrets/api-key')).toBe(
      false,
    );
    expect(b2.documents.some((e) => e.kind === 'document' && e.docName === 'README')).toBe(true);
  });
});
