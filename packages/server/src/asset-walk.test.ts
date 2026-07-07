import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBasenameIndex } from '@inkeep/open-knowledge-core';
import { seedBasenameIndex } from './asset-walk.ts';
import { createContentFilter } from './content-filter.ts';

let baseDir: string;
let contentDir: string;

function write(rel: string, body = 'bytes'): void {
  const full = join(contentDir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body, 'utf-8');
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'asset-walk-'));
  contentDir = join(baseDir, 'vault');
  mkdirSync(contentDir, { recursive: true });
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('seedBasenameIndex — initial walk (no filter)', () => {
  // When no ContentFilter is provided, seedBasenameIndex admits every file
  // with a LINKABLE_ASSET_EXTENSIONS extension regardless of sibling-markdown
  // presence. Production uses the filter.
  test('admits asset extensions; ignores markdown and unknown', async () => {
    write('docs/meeting.md');
    write('docs/photo.png');
    write('docs/diagram.svg');
    // Genuinely unknown extension (outside LINKABLE_ASSET_EXTENSIONS). `.txt` is now
    // in the widened asset set, so use `.xyz` as a
    // novel-extension placeholder.
    write('docs/arbitrary.xyz');
    write('archive/old.png');

    const idx = createBasenameIndex();
    await seedBasenameIndex({ contentDir, basenameIndex: idx });

    expect(idx.resolveEmbed('photo.png', 'docs/meeting.md')).toBe('docs/photo.png');
    expect(idx.resolveEmbed('diagram.svg', 'docs/meeting.md')).toBe('docs/diagram.svg');
    expect(idx.resolveEmbed('old.png', 'archive/anything.md')).toBe('archive/old.png');
    expect(idx.resolveEmbed('meeting.md', 'docs/meeting.md')).toBeNull();
    expect(idx.resolveEmbed('arbitrary.xyz', 'docs/meeting.md')).toBeNull();
  });

  test('admits .base and .canvas files into the basename index', async () => {
    write('vault/note.md');
    write('vault/Characters.base', 'fields:\n  - name\n');
    write('vault/Board.canvas', '{"nodes":[],"edges":[]}\n');

    const idx = createBasenameIndex();
    await seedBasenameIndex({ contentDir, basenameIndex: idx });

    expect(idx.resolveEmbed('Characters.base', 'vault/note.md')).toBe('vault/Characters.base');
    expect(idx.resolveEmbed('Board.canvas', 'vault/note.md')).toBe('vault/Board.canvas');
  });

  test('empty contentDir produces empty index without throwing', async () => {
    const idx = createBasenameIndex();
    await seedBasenameIndex({ contentDir, basenameIndex: idx });
    expect(idx.size()).toBe(0);
  });
});

describe('seedBasenameIndex — initial walk (with ContentFilter sibling-asset admission)', () => {
  // Production wiring: `startWatcher` populates ContentFilter's dirCount
  // (via incrementMdDir) during its own startup walk, so by the time
  // seedBasenameIndex runs the filter admits asset files in dirs that
  // have markdown siblings. We simulate that ordering in the test.
  test('admits assets only in markdown-neighbored directories', async () => {
    write('docs/meeting.md');
    write('docs/photo.png');
    write('no-md-here/orphan.png'); // no sibling .md → excluded

    const idx = createBasenameIndex();
    const contentFilter = createContentFilter({
      projectDir: baseDir,
      contentDir,
    });
    // Prime dirCount the same way the file-watcher does for every .md found.
    contentFilter.incrementMdDir('docs');
    await seedBasenameIndex({ contentDir, contentFilter, basenameIndex: idx });

    expect(idx.resolveEmbed('photo.png', 'docs/meeting.md')).toBe('docs/photo.png');
    expect(idx.resolveEmbed('orphan.png', 'docs/meeting.md')).toBeNull();
  });

  test('respects .okignore exclusion patterns', async () => {
    write('docs/meeting.md');
    write('docs/photo.png');
    write('secret/hidden.png');
    writeFileSync(join(contentDir, '.okignore'), 'secret/\n', 'utf-8');

    const idx = createBasenameIndex();
    const contentFilter = createContentFilter({
      projectDir: baseDir,
      contentDir,
    });
    contentFilter.incrementMdDir('docs');
    // 'secret/' doesn't have a markdown doc, AND the .okignore exclusion
    // wins regardless.
    await seedBasenameIndex({ contentDir, contentFilter, basenameIndex: idx });

    expect(idx.resolveEmbed('photo.png', 'docs/meeting.md')).toBe('docs/photo.png');
    expect(idx.resolveEmbed('hidden.png', 'docs/meeting.md')).toBeNull();
  });
});

describe('seedBasenameIndex — symlink safety', () => {
  test('follows symlinks inside contentDir but rejects escapes', async () => {
    write('docs/meeting.md');
    write('docs/real.png');
    const outside = join(baseDir, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'evil.png'), 'bytes', 'utf-8');
    // Symlink INSIDE contentDir pointing OUTSIDE — the walker must refuse.
    symlinkSync(outside, join(contentDir, 'docs', 'linked-outside'));
    // Symlink pointing to a sibling path INSIDE contentDir — walker follows.
    mkdirSync(join(contentDir, 'alias-target'), { recursive: true });
    writeFileSync(join(contentDir, 'alias-target', 'aliased.png'), 'bytes', 'utf-8');
    symlinkSync(join(contentDir, 'alias-target'), join(contentDir, 'docs', 'alias'));

    const idx = createBasenameIndex();
    await seedBasenameIndex({ contentDir, basenameIndex: idx });

    expect(idx.resolveEmbed('real.png', 'docs/meeting.md')).toBe('docs/real.png');
    expect(idx.resolveEmbed('aliased.png', 'docs/meeting.md')).not.toBeNull();
    // evil.png must NOT land in the index.
    expect(idx.resolveEmbed('evil.png', 'docs/meeting.md')).toBeNull();
  });
});
