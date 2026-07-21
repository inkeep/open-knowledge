/**
 * Persistence + reconcile coverage for the tag-index snapshot
 * (`.ok/local/cache/tags.json`): cold boot, warm boot on an unchanged tree,
 * warm boot across offline edits/adds/deletes/renames, the mtime+size
 * short-circuit, corrupt-snapshot fallback, and the branch-switch-shaped
 * wholesale content swap.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { TagIndex } from './tag-index.ts';

interface Rig {
  projectDir: string;
  contentDir: string;
  snapshotPath: string;
  cleanup: () => void;
}

function tempRig(): Rig {
  const projectDir = mkdtempSync(join(tmpdir(), 'ok-tag-persist-'));
  const contentDir = join(projectDir, 'content');
  mkdirSync(contentDir, { recursive: true });
  return {
    projectDir,
    contentDir,
    snapshotPath: join(projectDir, '.ok', 'local', 'cache', 'tags.json'),
    cleanup: () => rmSync(projectDir, { recursive: true, force: true }),
  };
}

/** Write a file and pin a deterministic mtime so cross-write mtime deltas
 * never depend on filesystem timestamp granularity. */
function writeDoc(contentDir: string, relPath: string, body: string, mtimeSec: number): void {
  const filePath = join(contentDir, relPath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, body);
  utimesSync(filePath, mtimeSec, mtimeSec);
}

function newIndex(rig: Rig): TagIndex {
  return new TagIndex({ projectDir: rig.projectDir, contentDir: rig.contentDir });
}

describe('TagIndex persistence', () => {
  test('cold boot: no snapshot on disk reports a cache miss; init + save writes one', async () => {
    const rig = tempRig();
    try {
      writeDoc(rig.contentDir, 'alpha.md', 'Note on #typescript.\n', 1_000);
      const idx = newIndex(rig);
      expect(await idx.loadFromDisk()).toBe(false);
      await idx.init();
      expect(idx.getDocsForTag('typescript')).toEqual(['alpha']);
      await idx.saveToDisk();
      expect(existsSync(rig.snapshotPath)).toBe(true);
      const snapshot = JSON.parse(await readFile(rig.snapshotPath, 'utf-8'));
      expect(snapshot.version).toBe(1);
      expect(snapshot.docs.alpha).toEqual(['typescript']);
      expect(snapshot.files.alpha.mtimeMs).toBeGreaterThan(0);
      expect(snapshot.files.alpha.size).toBeGreaterThan(0);
    } finally {
      rig.cleanup();
    }
  });

  test('warm boot on an unchanged tree: snapshot restores tags, reconcile re-parses nothing', async () => {
    const rig = tempRig();
    try {
      writeDoc(rig.contentDir, 'alpha.md', '---\ntags: [proj/team]\n---\nBody #extra.\n', 1_000);
      writeDoc(rig.contentDir, 'beta.md', 'No tags here.\n', 1_000);
      const first = newIndex(rig);
      await first.init();
      await first.saveToDisk();

      const second = newIndex(rig);
      expect(await second.loadFromDisk()).toBe(true);
      // Hierarchy expansion is re-derived from the persisted literals.
      expect(second.getDocsForTag('proj')).toEqual(['alpha']);
      expect(second.getDocsForTag('proj/team')).toEqual(['alpha']);
      expect(second.getDocsForTag('extra')).toEqual(['alpha']);
      const diff = await second.reconcileWithDisk();
      expect(diff).toEqual({ added: 0, updated: 0, deleted: 0 });
      expect(second.getDocsForTag('proj/team')).toEqual(['alpha']);
    } finally {
      rig.cleanup();
    }
  });

  test('warm boot with offline edits, adds, and deletes reconciles all three', async () => {
    const rig = tempRig();
    try {
      writeDoc(rig.contentDir, 'edited.md', 'Was #old-tag.\n', 1_000);
      writeDoc(rig.contentDir, 'gone.md', 'Carried #doomed.\n', 1_000);
      const first = newIndex(rig);
      await first.init();
      await first.saveToDisk();

      // Offline: edit one doc's tags, delete one doc, add one doc.
      writeDoc(rig.contentDir, 'edited.md', 'Now #new-tag.\n', 2_000);
      rmSync(join(rig.contentDir, 'gone.md'));
      writeDoc(rig.contentDir, 'fresh.md', 'Brand #minty.\n', 2_000);

      const second = newIndex(rig);
      expect(await second.loadFromDisk()).toBe(true);
      const diff = await second.reconcileWithDisk();
      expect(diff).toEqual({ added: 1, updated: 1, deleted: 1 });
      expect(second.getDocsForTag('old-tag')).toEqual([]);
      expect(second.getDocsForTag('new-tag')).toEqual(['edited']);
      expect(second.getDocsForTag('doomed')).toEqual([]);
      expect(second.getDocsForTag('minty')).toEqual(['fresh']);
    } finally {
      rig.cleanup();
    }
  });

  test('warm boot across an offline rename moves the doc under its tags', async () => {
    const rig = tempRig();
    try {
      writeDoc(rig.contentDir, 'before.md', 'Tagged #stable.\n', 1_000);
      const first = newIndex(rig);
      await first.init();
      await first.saveToDisk();

      // Offline rename = old path gone + new path present.
      rmSync(join(rig.contentDir, 'before.md'));
      writeDoc(rig.contentDir, 'after.md', 'Tagged #stable.\n', 2_000);

      const second = newIndex(rig);
      expect(await second.loadFromDisk()).toBe(true);
      const diff = await second.reconcileWithDisk();
      expect(diff).toEqual({ added: 1, updated: 0, deleted: 1 });
      expect(second.getDocsForTag('stable')).toEqual(['after']);
    } finally {
      rig.cleanup();
    }
  });

  test('mtime+size short-circuit: matching witnesses skip the re-parse', async () => {
    const rig = tempRig();
    try {
      writeDoc(rig.contentDir, 'alpha.md', 'Tag #before-x.\n', 1_000);
      const first = newIndex(rig);
      await first.init();
      await first.saveToDisk();

      // Rewrite with DIFFERENT tags but identical byte length, then pin the
      // mtime back — the witness pair matches, so reconcile must skip the
      // file and keep the snapshot's tags. This pins the short-circuit
      // actually short-circuiting (a full re-parse would surface #after-y).
      writeFileSync(join(rig.contentDir, 'alpha.md'), 'Tag #after-yy.\n');
      utimesSync(join(rig.contentDir, 'alpha.md'), 1_000, 1_000);

      const second = newIndex(rig);
      expect(await second.loadFromDisk()).toBe(true);
      const diff = await second.reconcileWithDisk();
      expect(diff).toEqual({ added: 0, updated: 0, deleted: 0 });
      expect(second.getDocsForTag('before-x')).toEqual(['alpha']);
      expect(second.getDocsForTag('after-yy')).toEqual([]);

      // A size change alone (same mtime) must break the short-circuit.
      writeFileSync(join(rig.contentDir, 'alpha.md'), 'Tag #after-y-longer.\n');
      utimesSync(join(rig.contentDir, 'alpha.md'), 1_000, 1_000);
      const diff2 = await second.reconcileWithDisk();
      expect(diff2).toEqual({ added: 0, updated: 1, deleted: 0 });
      expect(second.getDocsForTag('after-y-longer')).toEqual(['alpha']);
    } finally {
      rig.cleanup();
    }
  });

  test('corrupt snapshot (invalid JSON) reports a miss so callers full-rebuild', async () => {
    const rig = tempRig();
    try {
      writeDoc(rig.contentDir, 'alpha.md', 'Tag #real.\n', 1_000);
      mkdirSync(join(rig.projectDir, '.ok', 'local', 'cache'), { recursive: true });
      writeFileSync(rig.snapshotPath, '{ not json');

      const idx = newIndex(rig);
      expect(await idx.loadFromDisk()).toBe(false);
      await idx.init();
      expect(idx.getDocsForTag('real')).toEqual(['alpha']);
    } finally {
      rig.cleanup();
    }
  });

  test('off-shape snapshot (valid JSON, wrong structure) also reports a miss', async () => {
    const rig = tempRig();
    try {
      mkdirSync(join(rig.projectDir, '.ok', 'local', 'cache'), { recursive: true });
      for (const bad of [
        '[]',
        '{"version":2,"docs":{},"files":{}}',
        '{"version":1,"docs":{"a":"not-an-array"},"files":{}}',
        '{"version":1,"docs":{"a":[""]},"files":{}}',
        '{"version":1,"docs":{},"files":{"a":{"mtimeMs":"nan","size":1}}}',
      ]) {
        writeFileSync(rig.snapshotPath, bad);
        const idx = newIndex(rig);
        expect(await idx.loadFromDisk()).toBe(false);
      }
    } finally {
      rig.cleanup();
    }
  });

  test('snapshot restore refuses synthetic doc names', async () => {
    const rig = tempRig();
    try {
      mkdirSync(join(rig.projectDir, '.ok', 'local', 'cache'), { recursive: true });
      writeFileSync(
        rig.snapshotPath,
        JSON.stringify({
          version: 1,
          docs: { __system__: ['smuggled'], alpha: ['legit'] },
          files: {},
        }),
      );
      const idx = newIndex(rig);
      expect(await idx.loadFromDisk()).toBe(true);
      expect(idx.getDocsForTag('smuggled')).toEqual([]);
      expect(idx.getDocsForTag('legit')).toEqual(['alpha']);
    } finally {
      rig.cleanup();
    }
  });

  test('branch-switch-shaped swap: reconcile re-parses the rewritten corpus in place', async () => {
    const rig = tempRig();
    try {
      writeDoc(rig.contentDir, 'shared.md', 'On main: #main-only.\n', 1_000);
      writeDoc(rig.contentDir, 'main-doc.md', 'Tag #on-main.\n', 1_000);
      const idx = newIndex(rig);
      await idx.init();
      await idx.saveToDisk();

      // Simulate `git checkout feature`: shared file rewritten (new mtime),
      // a main-only file removed, a feature-only file added.
      writeDoc(rig.contentDir, 'shared.md', 'On feature: #feature-only.\n', 2_000);
      rmSync(join(rig.contentDir, 'main-doc.md'));
      writeDoc(rig.contentDir, 'feature-doc.md', 'Tag #on-feature.\n', 2_000);

      const diff = await idx.reconcileWithDisk();
      expect(diff).toEqual({ added: 1, updated: 1, deleted: 1 });
      expect(idx.getDocsForTag('main-only')).toEqual([]);
      expect(idx.getDocsForTag('on-main')).toEqual([]);
      expect(idx.getDocsForTag('feature-only')).toEqual(['shared']);
      expect(idx.getDocsForTag('on-feature')).toEqual(['feature-doc']);
    } finally {
      rig.cleanup();
    }
  });

  test('reconcile drops runtime-indexed docs whose file never existed on disk', async () => {
    const rig = tempRig();
    try {
      writeDoc(rig.contentDir, 'real.md', 'Tag #kept.\n', 1_000);
      const idx = newIndex(rig);
      await idx.init();
      // Live update for a doc that has no file (e.g. CRDT-only doc later
      // deleted on disk before persistence) — reconcile prunes it.
      idx.updateDocumentFromMarkdown('phantom', 'Tag #ghost.\n');
      expect(idx.getDocsForTag('ghost')).toEqual(['phantom']);
      const diff = await idx.reconcileWithDisk();
      expect(diff.deleted).toBe(1);
      expect(idx.getDocsForTag('ghost')).toEqual([]);
      expect(idx.getDocsForTag('kept')).toEqual(['real']);
    } finally {
      rig.cleanup();
    }
  });

  test('close() drains the chain and makes later persistence calls no-ops', async () => {
    const rig = tempRig();
    try {
      writeDoc(rig.contentDir, 'alpha.md', 'Tag #closing.\n', 1_000);
      const idx = newIndex(rig);
      await idx.init();
      await idx.close();
      // A save issued after close must not recreate anything under .ok/ —
      // callers rm -rf the state dir right after destroy.
      await idx.saveToDisk();
      expect(existsSync(rig.snapshotPath)).toBe(false);
      await expect(idx.reconcileWithDisk()).resolves.toEqual({
        added: 0,
        updated: 0,
        deleted: 0,
      });
      expect(await idx.loadFromDisk()).toBe(false);
    } finally {
      rig.cleanup();
    }
  });

  test('persistence disabled without projectDir: load misses, save is a no-op', async () => {
    const rig = tempRig();
    try {
      writeDoc(rig.contentDir, 'alpha.md', 'Tag #memory-only.\n', 1_000);
      const idx = new TagIndex({ contentDir: rig.contentDir });
      expect(await idx.loadFromDisk()).toBe(false);
      await idx.init();
      await idx.saveToDisk();
      expect(existsSync(rig.snapshotPath)).toBe(false);
      // Reconcile still works purely in-memory (branch-switch callers don't
      // need persistence wired to get the incremental pass).
      writeDoc(rig.contentDir, 'alpha.md', 'Tag #updated-now.\n', 2_000);
      const diff = await idx.reconcileWithDisk();
      expect(diff).toEqual({ added: 0, updated: 1, deleted: 0 });
      expect(idx.getDocsForTag('updated-now')).toEqual(['alpha']);
    } finally {
      rig.cleanup();
    }
  });
});
