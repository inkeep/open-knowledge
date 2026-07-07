import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  createEphemeralProjectDir,
  prepareSingleFileOpen,
  SingleFileNotAFileError,
  SingleFileNotFoundError,
  SingleFileNotMarkdownError,
} from './single-file-open.ts';

const cleanups: string[] = [];
function tmp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(dir);
  return dir;
}
function makeProject(root: string, contentDir = '.'): void {
  mkdirSync(join(root, '.ok'), { recursive: true });
  writeFileSync(join(root, '.ok', 'config.yml'), `content:\n  dir: ${contentDir}\n`, 'utf-8');
}

afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('prepareSingleFileOpen', () => {
  test('standalone markdown file → ephemeral mode scoped to the file', () => {
    const dir = tmp('sfo-loose-');
    writeFileSync(join(dir, 'notes.md'), '# Notes\n');
    const plan = prepareSingleFileOpen(join(dir, 'notes.md'));
    expect(plan.mode).toBe('ephemeral');
    if (plan.mode !== 'ephemeral') throw new Error('unreachable');
    expect(plan.contentDir).toBe(dir);
    expect(plan.singleDocRelPath).toBe('notes.md');
    expect(plan.canonicalFilePath).toBe(join(dir, 'notes.md'));
  });

  test('file inside a project → project mode focused on the ext-less doc', () => {
    const root = tmp('sfo-proj-');
    makeProject(root);
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'sub', 'spec.md'), '# Spec\n');
    const plan = prepareSingleFileOpen(join(root, 'sub', 'spec.md'));
    expect(plan.mode).toBe('project');
    if (plan.mode !== 'project') throw new Error('unreachable');
    expect(plan.projectRoot).toBe(root);
    expect(plan.docName).toBe('sub/spec');
  });

  test('project with content.dir=docs → docName relative to the content dir', () => {
    const root = tmp('sfo-proj-docs-');
    makeProject(root, 'docs');
    mkdirSync(join(root, 'docs', 'guides'), { recursive: true });
    writeFileSync(join(root, 'docs', 'guides', 'intro.md'), '# Intro\n');
    const plan = prepareSingleFileOpen(join(root, 'docs', 'guides', 'intro.md'));
    if (plan.mode !== 'project') throw new Error('expected project mode');
    expect(plan.projectRoot).toBe(root);
    expect(plan.docName).toBe('guides/intro');
  });

  // the load-bearing case. A symlink in a non-project dir whose
  // realpath lives in a real project MUST route to project mode (detection runs
  // on the realpath), not ephemeral mode (which would clobber the project's
  // file on the same inode through a second server).
  test('symlink whose realpath is inside a project → project mode (realpath before detection)', () => {
    const root = tmp('sfo-real-proj-');
    makeProject(root);
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'sub', 'notes.md'), '# Notes\n');

    const loose = tmp('sfo-loose-link-');
    symlinkSync(join(root, 'sub', 'notes.md'), join(loose, 'notes.md'));

    const plan = prepareSingleFileOpen(join(loose, 'notes.md'));
    expect(plan.mode).toBe('project');
    if (plan.mode !== 'project') throw new Error('unreachable');
    expect(plan.projectRoot).toBe(root);
    expect(plan.docName).toBe('sub/notes');
    expect(plan.canonicalFilePath).toBe(join(root, 'sub', 'notes.md'));
  });

  test('symlink whose realpath is standalone → ephemeral scoped to the real parent', () => {
    const real = tmp('sfo-real-loose-');
    writeFileSync(join(real, 'notes.md'), '# Notes\n');
    const loose = tmp('sfo-loose-link2-');
    symlinkSync(join(real, 'notes.md'), join(loose, 'link.md'));

    const plan = prepareSingleFileOpen(join(loose, 'link.md'));
    if (plan.mode !== 'ephemeral') throw new Error('expected ephemeral mode');
    // contentDir + singleDocRelPath follow the REALPATH (where write-back lands).
    expect(plan.contentDir).toBe(real);
    expect(plan.singleDocRelPath).toBe('notes.md');
  });

  test('missing file → SingleFileNotFoundError', () => {
    const dir = tmp('sfo-missing-');
    expect(() => prepareSingleFileOpen(join(dir, 'nope.md'))).toThrow(SingleFileNotFoundError);
  });

  test('non-markdown file → SingleFileNotMarkdownError', () => {
    const dir = tmp('sfo-txt-');
    writeFileSync(join(dir, 'notes.txt'), 'plain');
    expect(() => prepareSingleFileOpen(join(dir, 'notes.txt'))).toThrow(SingleFileNotMarkdownError);
  });

  test('directory with a markdown-looking name → SingleFileNotAFileError', () => {
    const dir = tmp('sfo-dir-');
    mkdirSync(join(dir, 'weird.md'));
    expect(() => prepareSingleFileOpen(join(dir, 'weird.md'))).toThrow(SingleFileNotAFileError);
  });
});

describe('createEphemeralProjectDir', () => {
  test('synthesizes a throwaway projectDir with a valid .ok/config.yml + .gitignore', () => {
    const contentDir = tmp('sfo-content-');
    const projectDir = createEphemeralProjectDir(contentDir);
    cleanups.push(projectDir);

    expect(existsSync(join(projectDir, '.ok', 'config.yml'))).toBe(true);
    expect(existsSync(join(projectDir, '.ok', '.gitignore'))).toBe(true);
    const cfg = readFileSync(join(projectDir, '.ok', 'config.yml'), 'utf-8');
    // content.dir records the real parent (honesty); JSON-quoted so paths with
    // spaces are valid YAML.
    expect(cfg).toContain(JSON.stringify(contentDir));
    // The throwaway dir is an `ok-ephemeral-*` mkdtemp under os.tmpdir, NOT the
    // user's content dir.
    expect(basename(projectDir).startsWith('ok-ephemeral-')).toBe(true);
    expect(projectDir).not.toBe(contentDir);
  });
});
