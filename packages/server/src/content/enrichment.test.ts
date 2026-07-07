import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { commitWip, initShadowRepo, type WriterIdentity } from '@inkeep/open-knowledge-server';
import simpleGit from 'simple-git';
import { computeGraphRole, enrichDirectory, enrichPath } from './enrichment.ts';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-enrich-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function bootstrapProject(): Promise<string> {
  const project = resolve(tmpDir, 'project');
  mkdirSync(project, { recursive: true });
  const git = simpleGit(project);
  await git.init();
  await git.raw('config', 'user.name', 'Test');
  await git.raw('config', 'user.email', 't@t.test');
  writeFileSync(resolve(project, 'README.md'), '# root\n');
  await git.add('README.md');
  await git.commit('init');
  return project;
}

describe('enrichPath — slim (multi-path) shape', () => {
  test('rich fields are null when includeRichFields is false/absent', async () => {
    const project = await bootstrapProject();
    const contentDir = resolve(project, 'content');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(
      resolve(contentDir, 'auth.md'),
      '---\ntitle: Auth\ndescription: OAuth\ntags:\n  - auth\n  - oauth\n---\n\nBody\n',
    );

    const meta = await enrichPath('content/auth.md', { projectDir: project });

    expect(meta.path).toBe('content/auth.md');
    expect(meta.title).toBe('Auth');
    expect(meta.description).toBe('OAuth');
    expect(meta.tags).toEqual(['auth', 'oauth']);
    // Rich fields are null (slim shape)
    expect(meta.backlinkCount).toBe(null);
    expect(meta.history).toBe(null);
    expect(meta.historySource).toBe(null);
  });

  test('tolerates missing frontmatter — title/description undefined, tags empty', async () => {
    const project = await bootstrapProject();
    const contentDir = resolve(project, 'content');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(resolve(contentDir, 'plain.md'), 'Just body\n');

    const meta = await enrichPath('content/plain.md', { projectDir: project });

    expect(meta.title).toBeUndefined();
    expect(meta.description).toBeUndefined();
    expect(meta.tags).toEqual([]);
  });

  test('frontmatter under trailing-whitespace fences still enriches title/description/tags', async () => {
    // `--- ` / `---\t` fence lines are in-tolerance keystrokes away from
    // canonical fences; enrichment must keep recognizing the FM block
    // instead of degrading to "no frontmatter".
    const project = await bootstrapProject();
    const contentDir = resolve(project, 'content');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(
      resolve(contentDir, 'open-space.md'),
      '--- \ntitle: Auth\ndescription: OAuth\ntags:\n  - auth\n---\n\nBody\n',
    );
    writeFileSync(resolve(contentDir, 'close-tab.md'), '---\ntitle: Sessions\n---\t\n\nBody\n');

    const openSpace = await enrichPath('content/open-space.md', { projectDir: project });
    expect(openSpace.title).toBe('Auth');
    expect(openSpace.description).toBe('OAuth');
    expect(openSpace.tags).toEqual(['auth']);

    const closeTab = await enrichPath('content/close-tab.md', { projectDir: project });
    expect(closeTab.title).toBe('Sessions');
  });

  test('missing file still returns a slim shape with tags=[]', async () => {
    const project = await bootstrapProject();
    const meta = await enrichPath('does-not-exist.md', { projectDir: project });
    expect(meta.path).toBe('does-not-exist.md');
    expect(meta.tags).toEqual([]);
  });
});

describe('enrichPath — rich (single-path) shape', () => {
  test('populates history from shadow repo and backlinkCount=null when no serverUrl', async () => {
    const project = await bootstrapProject();
    const shadow = await initShadowRepo(project);
    const contentDir = resolve(project, 'content');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(resolve(contentDir, 'auth.md'), '---\ntitle: Auth\n---\nBody\n');
    const writer: WriterIdentity = { id: 'agent-x', name: 'X', email: 'x@t.test' };
    const branch = (await simpleGit(project).revparse(['--abbrev-ref', 'HEAD'])).trim();
    await commitWip(shadow, writer, contentDir, 'initial', branch);

    const meta = await enrichPath(
      'content/auth.md',
      { projectDir: project },
      { includeRichFields: true },
    );

    expect(meta.title).toBe('Auth');
    expect(meta.historySource).toBe('shadow-repo');
    expect(meta.history).not.toBeNull();
    expect(meta.history?.length).toBe(1);
    expect(meta.history?.[0].writerClassification).toBe('agent');
    expect(meta.history?.[0].message).toBe('initial');
    expect(meta.backlinkCount).toBe(null);
  });

  test('returns historySource="shadow-repo-absent" when no shadow repo exists', async () => {
    const project = await bootstrapProject();
    const contentDir = resolve(project, 'content');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(resolve(contentDir, 'auth.md'), '---\ntitle: Auth\n---\nBody\n');

    const meta = await enrichPath(
      'content/auth.md',
      { projectDir: project },
      { includeRichFields: true },
    );

    expect(meta.historySource).toBe('shadow-repo-absent');
    expect(meta.history).toEqual([]);
    expect(meta.backlinkCount).toBe(null);
  });
});

describe('enrichPath — folder frontmatter does NOT cascade into docs (self-only)', () => {
  test('a doc with no frontmatter, inside a folder whose .ok sets tags, returns {} / []', async () => {
    const project = await bootstrapProject();
    mkdirSync(resolve(project, 'specs/.ok'), { recursive: true });
    writeFileSync(resolve(project, 'specs/foo.md'), '# foo\n');
    writeFileSync(
      resolve(project, 'specs/.ok/frontmatter.yml'),
      'title: Specs\ndescription: Spec docs\ntags:\n  - spec\n',
    );

    const meta = await enrichPath('specs/foo.md', { projectDir: project });
    expect(meta.title).toBeUndefined();
    expect(meta.description).toBeUndefined();
    expect(meta.tags).toEqual([]);
    expect(meta.frontmatter).toEqual({});
  });

  test("a doc's own frontmatter is returned unmodified by the folder's .ok/frontmatter.yml", async () => {
    const project = await bootstrapProject();
    mkdirSync(resolve(project, 'specs/.ok'), { recursive: true });
    writeFileSync(
      resolve(project, 'specs/foo.md'),
      '---\ntitle: File\ntags:\n  - file-tag\n---\nBody\n',
    );
    writeFileSync(
      resolve(project, 'specs/.ok/frontmatter.yml'),
      'title: Nested\ndescription: Nested desc\ntags:\n  - nested-tag\n',
    );

    const meta = await enrichPath('specs/foo.md', { projectDir: project });
    // Exactly the file's own keys — no merge with the folder's frontmatter.
    expect(meta.title).toBe('File');
    expect(meta.description).toBeUndefined();
    expect(meta.tags).toEqual(['file-tag']);
    expect(meta.frontmatter).toEqual({ title: 'File', tags: ['file-tag'] });
  });

  test('a root doc does not inherit the project-root .ok/frontmatter.yml', async () => {
    const project = await bootstrapProject();
    mkdirSync(resolve(project, '.ok'), { recursive: true });
    writeFileSync(resolve(project, 'top.md'), '# top\n');
    writeFileSync(resolve(project, '.ok/frontmatter.yml'), 'title: Root Default\ntags:\n  - kb\n');

    const meta = await enrichPath('top.md', { projectDir: project });
    expect(meta.title).toBeUndefined();
    expect(meta.tags).toEqual([]);
    expect(meta.frontmatter).toEqual({});
  });
});

describe('enrichDirectory — self-only folder frontmatter', () => {
  test('no nested .ok/frontmatter.yml → DirectoryMeta has no title/description/tags', async () => {
    const project = await bootstrapProject();
    mkdirSync(resolve(project, 'specs'), { recursive: true });
    writeFileSync(resolve(project, 'specs/foo.md'), '---\ntitle: Foo\n---\nBody\n');

    const meta = await enrichDirectory('specs', { projectDir: project });
    expect(meta.type).toBe('directory');
    expect(meta.title).toBeUndefined();
    expect(meta.description).toBeUndefined();
    expect(meta.tags).toBeUndefined();
    expect(meta.recursiveMdCount).toBe(1);
  });

  test("the folder's own .ok/frontmatter.yml attaches title/description/tags to the directory", async () => {
    const project = await bootstrapProject();
    mkdirSync(resolve(project, 'specs/.ok'), { recursive: true });
    writeFileSync(resolve(project, 'specs/foo.md'), '---\ntitle: Foo\n---\nBody\n');
    writeFileSync(
      resolve(project, 'specs/.ok/frontmatter.yml'),
      'title: Specs\ndescription: Spec docs\ntags:\n  - spec\n',
    );

    const meta = await enrichDirectory('specs', { projectDir: project });
    expect(meta.title).toBe('Specs');
    expect(meta.description).toBe('Spec docs');
    expect(meta.tags).toEqual(['spec']);
    expect(meta.recursiveMdCount).toBe(1);
  });

  test('does NOT inherit folder frontmatter from ancestor directories', async () => {
    const project = await bootstrapProject();
    mkdirSync(resolve(project, 'a/.ok'), { recursive: true });
    mkdirSync(resolve(project, 'a/b/.ok'), { recursive: true });
    writeFileSync(resolve(project, 'a/.ok/frontmatter.yml'), 'description: A desc\ntags:\n  - a\n');
    writeFileSync(resolve(project, 'a/b/.ok/frontmatter.yml'), 'title: B\n');
    writeFileSync(resolve(project, 'a/b/foo.md'), '# foo\n');

    const meta = await enrichDirectory('a/b', { projectDir: project });
    // b's OWN frontmatter only — no description / tags inherited from a.
    expect(meta.title).toBe('B');
    expect(meta.description).toBeUndefined();
    expect(meta.tags).toBeUndefined();
  });
});

describe('enrichPath/enrichDirectory — defense-in-depth path containment', () => {
  test('enrichPath rejects `../` escape from projectDir', async () => {
    const project = await bootstrapProject();
    await expect(enrichPath('../etc/passwd', { projectDir: project })).rejects.toThrow(
      /escapes the configured root/,
    );
  });

  test('enrichPath rejects absolute path outside projectDir', async () => {
    const project = await bootstrapProject();
    await expect(enrichPath('/etc/passwd', { projectDir: project })).rejects.toThrow(
      /escapes the configured root/,
    );
  });

  test('enrichDirectory rejects `../` escape from projectDir', async () => {
    const project = await bootstrapProject();
    await expect(enrichDirectory('../', { projectDir: project })).rejects.toThrow(
      /escapes the configured root/,
    );
  });

  test('enrichDirectory rejects absolute path outside projectDir', async () => {
    const project = await bootstrapProject();
    await expect(enrichDirectory('/etc', { projectDir: project })).rejects.toThrow(
      /escapes the configured root/,
    );
  });
});

describe('computeGraphRole', () => {
  test('null when neither count is known', () => {
    expect(computeGraphRole(null, null)).toBe(null);
  });
  test('null on partial data (one count unknown)', () => {
    expect(computeGraphRole(null, 3)).toBe(null);
    expect(computeGraphRole(3, null)).toBe(null);
  });
  test('orphan when there are no links', () => {
    expect(computeGraphRole(0, 0)).toBe('orphan');
  });
  test('hub at or above the inbound floor', () => {
    expect(computeGraphRole(5, 0)).toBe('hub');
    expect(computeGraphRole(9, 2)).toBe('hub');
  });
  test('connector with links in and out below the hub floor', () => {
    expect(computeGraphRole(2, 3)).toBe('connector');
  });
  test('one below the hub floor is a connector, not a hub', () => {
    expect(computeGraphRole(4, 1)).toBe('connector');
  });
  test('leaf with a few links in one direction only', () => {
    expect(computeGraphRole(0, 2)).toBe('leaf');
    expect(computeGraphRole(2, 0)).toBe('leaf');
  });
});
