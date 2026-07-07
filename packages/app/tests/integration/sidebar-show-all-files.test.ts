/**
 * Tests for `GET /api/documents?showAll=true` — Show All Files mode.
 *
 * Verifies the runtime-bypass path through ContentFilter:
 *   - `.gitignored` files surface
 *   - `.okignored` files surface
 *   - content-bearing `BUILTIN_SKIP_DIRS` (dist/, build/, coverage/) surface
 *   - the always-skip floor (.git/, node_modules/, .ok/) stays PRUNED even
 *     under bypass — these never hold user markdown and walking them on a
 *     repo-root content dir exhausts the heap (the Show All Files OOM)
 *   - Non-markdown/non-asset files (.ts, .py, .yaml) surface as kind='asset'
 *   - Folder entries appear for every walkable directory except the floor
 *   - STOP rule preserved: synthetic system + config doc names stay hidden
 *     even in bypass mode (CLAUDE.md `isSystemDoc()`/`isConfigDoc()` gates)
 *
 * Non-bypass requests (without the flag) MUST behave identically to today —
 * fileIndex stays populated with the filtered set; `?showAll=true` is
 * per-request only.
 */
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

  // Visible markdown
  writeFileSync(join(contentDir, 'README.md'), '# Readme\n');
  mkdirSync(join(contentDir, 'docs'), { recursive: true });
  writeFileSync(join(contentDir, 'docs', 'guide.md'), '# Guide\n');

  // .gitignore'd content
  writeFileSync(join(contentDir, '.gitignore'), 'secrets/\nbuild/\n*.log\n');
  mkdirSync(join(contentDir, 'secrets'), { recursive: true });
  writeFileSync(join(contentDir, 'secrets', 'api-key.md'), 'sk-test\n');
  mkdirSync(join(contentDir, 'build'), { recursive: true });
  writeFileSync(join(contentDir, 'build', 'compiled.md'), '# Compiled\n');
  writeFileSync(join(contentDir, 'debug.log'), 'debug output\n');

  // .okignore'd content
  writeFileSync(join(contentDir, '.okignore'), 'drafts/\n');
  mkdirSync(join(contentDir, 'drafts'), { recursive: true });
  writeFileSync(join(contentDir, 'drafts', 'wip.md'), '# WIP\n');

  // BUILTIN_SKIP_DIRS content
  mkdirSync(join(contentDir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(contentDir, 'node_modules', 'pkg', 'README.md'), '# Pkg\n');
  mkdirSync(join(contentDir, '.git'), { recursive: true });
  writeFileSync(join(contentDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(join(contentDir, '.ok'), { recursive: true });
  writeFileSync(join(contentDir, '.ok', 'config.yml'), 'content:\n  dir: .\n');

  // Non-markdown / non-asset files
  writeFileSync(join(contentDir, 'package.json'), '{"name":"test"}\n');
  mkdirSync(join(contentDir, 'src'), { recursive: true });
  writeFileSync(join(contentDir, 'src', 'index.ts'), 'export {}\n');
  writeFileSync(join(contentDir, 'analysis.py'), 'print("hi")\n');

  // Extensionless file → 'file' fallback for assetExt
  writeFileSync(join(contentDir, 'LICENSE'), 'MIT\n');

  // Synthetic system + config doc real-on-disk files (defense in depth — STOP
  // rule must keep these hidden even in bypass mode).
  writeFileSync(join(contentDir, '__system__.md'), '# Should not leak\n');
  mkdirSync(join(contentDir, '__config__'), { recursive: true });
  writeFileSync(join(contentDir, '__config__', 'project.md'), '# Should not leak\n');
  mkdirSync(join(contentDir, '__user__'), { recursive: true });
  writeFileSync(join(contentDir, '__user__', 'config.yml.md'), '# Should not leak\n');
  mkdirSync(join(contentDir, '__local__'), { recursive: true });
  writeFileSync(join(contentDir, '__local__', 'project.md'), '# Should not leak\n');

  server = await createTestServer({ contentDir, keepContentDir: false });
  // Wait for at least one indexed file so the readiness gate releases.
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

    // Visible markdown surfaces.
    expect(docNames).toContain('README');
    expect(docNames).toContain('docs/guide');

    // .gitignored / .okignored content stays hidden.
    expect(docNames).not.toContain('secrets/api-key');
    expect(docNames).not.toContain('build/compiled');
    expect(docNames).not.toContain('drafts/wip');

    // BUILTIN_SKIP_DIRS content stays hidden.
    expect(docNames).not.toContain('node_modules/pkg/README');
  });

  test('?showAll=true surfaces .gitignored / .okignored / content-bearing skip-dir markdown but prunes the always-skip floor', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents?showAll=true`);
    expect(res.ok).toBe(true);
    const body = DocumentListSuccessSchema.parse(await res.json());

    const docNames = body.documents.filter((e) => e.kind === 'document').map((e) => e.docName);

    // Today's visible markdown still present.
    expect(docNames).toContain('README');
    expect(docNames).toContain('docs/guide');

    // .gitignored markdown surfaces.
    expect(docNames).toContain('secrets/api-key');
    expect(docNames).toContain('build/compiled');

    // .okignored markdown surfaces.
    expect(docNames).toContain('drafts/wip');

    // `build/` is .gitignored AND in BUILTIN_SKIP_DIRS yet still surfaces
    // (asserted above) — proving the floor is a strict subset, not all of
    // BUILTIN_SKIP_DIRS.

    // Always-skip floor: `.git/`, `node_modules/`, `.ok/` stay pruned even
    // under bypass — Show All Files must never descend into them (OOM guard).
    expect(docNames).not.toContain('node_modules/pkg/README');
  });

  test('?showAll=true surfaces non-md / non-asset files as kind=asset', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents?showAll=true`);
    expect(res.ok).toBe(true);
    const body = DocumentListSuccessSchema.parse(await res.json());

    // package.json — extname '.json' → text-viewer dispatch (CodeMirror in
    // read-only mode via `TextViewer`). Was `mediaKind: null` before the
    // JSON/TOML sidebar viewers landed; the file is still treated as an
    // asset, just with a built-in preview branch now.
    const pkgJson = body.documents.find((e) => e.kind === 'asset' && e.path === 'package.json');
    expect(pkgJson).toBeTruthy();
    expect(pkgJson?.assetExt).toBe('json');
    expect(pkgJson?.mediaKind).toBe('text');
    expect(pkgJson?.referencedBy).toEqual([]);

    // src/index.ts — extname '.ts' (NOT in ASSET_EXTENSIONS, but recognized
    // as a code-language file → routes to the read-only TextViewer with
    // the JavaScript/TypeScript CodeMirror language pack).
    const indexTs = body.documents.find((e) => e.kind === 'asset' && e.path === 'src/index.ts');
    expect(indexTs).toBeTruthy();
    expect(indexTs?.assetExt).toBe('ts');
    expect(indexTs?.mediaKind).toBe('text');

    // analysis.py — extname '.py' (NOT in ASSET_EXTENSIONS)
    const analysisPy = body.documents.find((e) => e.kind === 'asset' && e.path === 'analysis.py');
    expect(analysisPy).toBeTruthy();
    expect(analysisPy?.assetExt).toBe('py');

    // LICENSE — no extension, no leading dot → 'file' fallback
    const license = body.documents.find((e) => e.kind === 'asset' && e.path === 'LICENSE');
    expect(license).toBeTruthy();
    expect(license?.assetExt).toBe('file');

    // .gitignore — dotfile with no extname → use name minus dot
    const gitignore = body.documents.find((e) => e.kind === 'asset' && e.path === '.gitignore');
    expect(gitignore).toBeTruthy();
    expect(gitignore?.assetExt).toBe('gitignore');
  });

  test('?showAll=true emits folder entries for content dirs but prunes the always-skip floor (.git / node_modules / .ok)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents?showAll=true`);
    expect(res.ok).toBe(true);
    const body = DocumentListSuccessSchema.parse(await res.json());

    const folderPaths = body.documents.filter((e) => e.kind === 'folder').map((e) => e.path);

    // Content-bearing dirs — including .gitignored (secrets/, build/) and
    // .okignored (drafts/) ones — still surface under Show All Files.
    expect(folderPaths).toContain('docs');
    expect(folderPaths).toContain('secrets');
    expect(folderPaths).toContain('build');
    expect(folderPaths).toContain('drafts');
    expect(folderPaths).toContain('src');

    // Always-skip floor: pruned even under bypass. Descending into these on a
    // repo-root content dir (multi-GB `.git`, thousands of `node_modules`) is
    // the unbounded walk that exhausts the heap — the OOM this floor fixes.
    expect(folderPaths).not.toContain('node_modules');
    expect(folderPaths).not.toContain('node_modules/pkg');
    expect(folderPaths).not.toContain('.git');
    expect(folderPaths).not.toContain('.ok');
  });

  test('STOP rule preserved — synthetic system + config docs stay hidden in bypass mode', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents?showAll=true`);
    expect(res.ok).toBe(true);
    const body = DocumentListSuccessSchema.parse(await res.json());

    // The on-disk files named after the synthetic doc namespace MUST NOT
    // appear, even though .gitignore/.okignore/BUILTIN_SKIP_DIRS are bypassed.
    const docNames = body.documents.filter((e) => e.kind === 'document').map((e) => e.docName);
    expect(docNames).not.toContain('__system__');
    expect(docNames).not.toContain('__config__/project');
    expect(docNames).not.toContain('__user__/config.yml');
    expect(docNames).not.toContain('__local__/project');

    // Defense in depth — also assert by scanning the full union for any path
    // matching the reserved namespace (handles a hypothetical regression
    // where the leak surfaces as kind='asset' rather than 'document').
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
    // Round 1: bypass call surfaces everything.
    const r1 = await fetch(`http://127.0.0.1:${server.port}/api/documents?showAll=true`);
    const b1 = DocumentListSuccessSchema.parse(await r1.json());
    expect(b1.documents.some((e) => e.kind === 'document' && e.docName === 'secrets/api-key')).toBe(
      true,
    );

    // Round 2: no flag — back to today's filtered view. fileIndex was NEVER
    // mutated by the bypass call (per-request only).
    const r2 = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
    const b2 = DocumentListSuccessSchema.parse(await r2.json());
    expect(b2.documents.some((e) => e.kind === 'document' && e.docName === 'secrets/api-key')).toBe(
      false,
    );
    expect(b2.documents.some((e) => e.kind === 'document' && e.docName === 'README')).toBe(true);
  });
});
