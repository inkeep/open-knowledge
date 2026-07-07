import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nestedOkPath, parentFolderOf, readFolderFrontmatter } from './nested-folder-rules.ts';

describe('readFolderFrontmatter — self-only (no cascade)', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'folder-frontmatter-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  test('returns empty for project root when no .ok/frontmatter.yml exists there', () => {
    expect(readFolderFrontmatter(projectDir, '')).toEqual({});
    expect(readFolderFrontmatter(projectDir, '.')).toEqual({});
    expect(readFolderFrontmatter(projectDir, '/')).toEqual({});
  });

  test('returns empty when the folder has no .ok/frontmatter.yml', () => {
    expect(readFolderFrontmatter(projectDir, 'meetings')).toEqual({});
    expect(readFolderFrontmatter(projectDir, 'meetings/prep-notes')).toEqual({});
  });

  test("reads a folder's own .ok/frontmatter.yml", () => {
    mkdirSync(join(projectDir, 'meetings', '.ok'), { recursive: true });
    writeFileSync(
      join(projectDir, 'meetings', '.ok', 'frontmatter.yml'),
      'title: Meetings\ndescription: Meeting notes\ntags: [meeting]\n',
    );

    expect(readFolderFrontmatter(projectDir, 'meetings')).toEqual({
      title: 'Meetings',
      description: 'Meeting notes',
      tags: ['meeting'],
    });
  });

  test('does NOT inherit from ancestor folders (self-only)', () => {
    // Parent sets description + tags; child sets only title. With no cascade,
    // the child returns its OWN keys only — no inherited description/tags.
    mkdirSync(join(projectDir, 'a', '.ok'), { recursive: true });
    writeFileSync(
      join(projectDir, 'a', '.ok', 'frontmatter.yml'),
      'title: A\ndescription: A desc\ntags: [a]\n',
    );
    mkdirSync(join(projectDir, 'a', 'b', '.ok'), { recursive: true });
    writeFileSync(join(projectDir, 'a', 'b', '.ok', 'frontmatter.yml'), 'title: B\n');

    expect(readFolderFrontmatter(projectDir, 'a/b')).toEqual({ title: 'B' });
    // The ancestor still reports only its own keys.
    expect(readFolderFrontmatter(projectDir, 'a')).toEqual({
      title: 'A',
      description: 'A desc',
      tags: ['a'],
    });
  });

  test('a child with no .ok/frontmatter.yml returns empty even when an ancestor has one', () => {
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(join(projectDir, '.ok', 'frontmatter.yml'), 'title: Project\ntags: [kb]\n');

    // No inheritance: the child folder has nothing of its own.
    expect(readFolderFrontmatter(projectDir, 'meetings')).toEqual({});
    // The project root observes its own frontmatter.
    expect(readFolderFrontmatter(projectDir, '')).toEqual({ title: 'Project', tags: ['kb'] });
  });

  test('malformed YAML returns empty (read paths must not throw)', () => {
    mkdirSync(join(projectDir, 'broken', '.ok'), { recursive: true });
    writeFileSync(
      join(projectDir, 'broken', '.ok', 'frontmatter.yml'),
      'title: [malformed\nno closing\n',
    );

    expect(readFolderFrontmatter(projectDir, 'broken')).toEqual({});
  });

  test('non-string title dropped; non-string tags filtered (well-known narrowing)', () => {
    mkdirSync(join(projectDir, 'mixed', '.ok'), { recursive: true });
    writeFileSync(
      join(projectDir, 'mixed', '.ok', 'frontmatter.yml'),
      'title: 42\ndescription: ok\ntags: [a, 1, b, true]\n',
    );

    expect(readFolderFrontmatter(projectDir, 'mixed')).toEqual({
      description: 'ok',
      tags: ['a', 'b'],
    });
  });

  test('arbitrary (non-well-known) keys pass through with their natural types', () => {
    mkdirSync(join(projectDir, 'rfcs', '.ok'), { recursive: true });
    writeFileSync(
      join(projectDir, 'rfcs', '.ok', 'frontmatter.yml'),
      'title: RFCs\nstatus: draft\nreview_cycle: 30\nowners: [alice, bob]\n',
    );

    const own = readFolderFrontmatter(projectDir, 'rfcs');
    expect(own.title).toBe('RFCs');
    expect(own.status).toBe('draft');
    expect(own.review_cycle).toBe(30);
    expect(own.owners).toEqual(['alice', 'bob']);
  });
});

describe('parentFolderOf', () => {
  test('extracts parent dir from a file path', () => {
    expect(parentFolderOf('meetings/foo.md')).toBe('meetings');
    expect(parentFolderOf('meetings/prep-notes/foo.md')).toBe('meetings/prep-notes');
  });

  test('returns empty for a top-level file', () => {
    expect(parentFolderOf('foo.md')).toBe('');
  });
});

describe('nestedOkPath', () => {
  test('joins folder + .ok + member', () => {
    expect(nestedOkPath('/proj', 'meetings', 'frontmatter.yml')).toBe(
      '/proj/meetings/.ok/frontmatter.yml',
    );
    expect(nestedOkPath('/proj', 'meetings/prep-notes', 'templates')).toBe(
      '/proj/meetings/prep-notes/.ok/templates',
    );
  });

  test('treats empty / "." as project root', () => {
    expect(nestedOkPath('/proj', '', 'frontmatter.yml')).toBe('/proj/.ok/frontmatter.yml');
    expect(nestedOkPath('/proj', '.', 'frontmatter.yml')).toBe('/proj/.ok/frontmatter.yml');
  });
});
