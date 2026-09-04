import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import simpleGit from 'simple-git';
import { afterAll, describe, expect, test } from 'vitest';
import { ConfigSchema } from '../config/schema.ts';
import { buildExecResult } from '../mcp/tools/exec.ts';

const CONFIG = ConfigSchema.parse({});
const created: string[] = [];

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

async function corpus(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'path-honesty-'));
  created.push(root);
  const git = simpleGit(root);
  await git.init();
  await git.raw('config', 'user.name', 'Test');
  await git.raw('config', 'user.email', 't@t.test');
  mkdirSync(join(root, 'specs'));
  mkdirSync(join(root, 'empty-dir'));
  writeFileSync(
    join(root, 'README.md'),
    '---\ntitle: Readme\n---\nalpha beta\nspecs/two.md: see also\n',
  );
  writeFileSync(join(root, 'my notes.md'), '---\ntitle: Spaced\n---\nalpha\n');
  writeFileSync(join(root, 'plain.txt'), 'not markdown\n');
  writeFileSync(join(root, 'two  spaces.md'), '---\ntitle: Spaced\n---\nalpha\n');
  writeFileSync(join(root, 'UPPER.MD'), '---\ntitle: Upper\n---\nalpha\n');
  writeFileSync(join(root, 'specs/one.md'), '---\ntitle: One\n---\nalpha ONE\n');
  writeFileSync(join(root, 'specs/two.md'), '---\ntitle: Two\n---\nTWO\n');
  await git.add('.');
  await git.commit('init');
  return root;
}

async function reported(root: string, command: string): Promise<string[]> {
  const result = (await buildExecResult(
    { command, cwd: root },
    { resolveCwd: async () => root, serverUrl: undefined, config: CONFIG },
  )) as { structuredContent?: { enrichedPaths?: Array<{ path: string }> } };
  return (result.structuredContent?.enrichedPaths ?? []).map((entry) => entry.path);
}

const COMMANDS = [
  'ls',
  'ls -l',
  'ls -la',
  'ls -A',
  'ls -a',
  'ls specs/',
  'ls specs/*.md',
  'ls README.md specs/one.md',
  'cat README.md',
  'cat specs/*.md',
  'cat README.md specs/one.md',
  'head -n 1 README.md',
  'tail -n 1 README.md',
  'wc -l README.md',
  'wc -l specs/*.md',
  'sort README.md',
  'uniq README.md',
  'cut -d" " -f1 README.md',
  'grep alpha README.md',
  'grep -rn alpha .',
  'grep -l alpha specs/*.md',
  'cat README.md | grep also',
  'cat README.md | grep -l also',
  'cat README.md | grep -r also',
  "find . -name '*.md'",
  'find . -type f',
  'find . -type d',
  'grep -rn alpha . | head -3',
  'ls | sort',
  'cat README.md | sort -k 2',
  'cat README.md | cut -d " " -f 1',
  'cat README.md | uniq -f 1',
  'cat README.md | sort plain.txt',
  'cat plain.txt',
  'ls empty-dir/',
];

describe('exec never reports a path that does not exist', () => {
  test.each(COMMANDS)('%s', async (command) => {
    const root = await corpus();
    for (const path of await reported(root, command)) {
      expect(
        () => statSync(resolve(root, path)),
        `${command} reported a nonexistent path: ${path}`,
      ).not.toThrow();
    }
  });

  test('the assertion can fail, so a passing run means something', async () => {
    const root = await corpus();
    expect(() => statSync(resolve(root, 'ghost.md'))).toThrow();
  });

  test.each([
    'cat README.md',
    'ls -l',
    'ls -la',
    'sort README.md',
    'uniq README.md',
    'wc -l README.md',
    'cut -d" " -f1 README.md',
    'head -n 1 README.md',
    'tail -n 1 README.md',
    'grep alpha README.md',
    'grep -rn alpha .',
    'cat README.md | sort -k 2',
    'cat README.md | cut -d " " -f 1',
    'cat README.md | uniq -f 1',
  ])('%s still reports the file it read, so honesty is not silence', async (command) => {
    const root = await corpus();
    expect(await reported(root, command)).toContain('README.md');
  });
});

describe('a long listing reports the name as written', () => {
  test('consecutive whitespace in a filename survives', async () => {
    const root = await corpus();
    expect(await reported(root, 'ls -l')).toContain('two  spaces.md');
  });

  test('an uppercase extension is still a document', async () => {
    const root = await corpus();
    expect(await reported(root, 'ls -l')).toContain('UPPER.MD');
    expect(await reported(root, 'ls')).toContain('UPPER.MD');
  });
});

describe('the reported set is the set the command was about', () => {
  test('grep -l reports only the file that matched', async () => {
    const root = await corpus();
    expect(await reported(root, 'grep -l alpha specs/*.md')).toEqual(['specs/one.md']);
  });

  test('a wiki-shaped grep pattern is the needle, not a file that was read', async () => {
    const root = await corpus();
    expect(await reported(root, 'grep specs/two.md README.md')).toEqual(['README.md']);
  });

  test('ls -a does not report the dot entries', async () => {
    const root = await corpus();
    const paths = await reported(root, 'ls -a');
    expect(paths).not.toContain('.');
    expect(paths).not.toContain('..');
  });

  test('a matched line that starts with a wiki path and a colon is content, not a filename', async () => {
    const root = await corpus();
    expect(await reported(root, 'grep "see also" README.md')).toEqual(['README.md']);
  });

  test('a grep with no search operand in a pipe defers to the file upstream', async () => {
    const root = await corpus();
    expect(await reported(root, 'cat README.md | grep also')).toEqual(['README.md']);
  });

  test('a grep with only an output-shaping flag in a pipe defers to the file upstream', async () => {
    const root = await corpus();
    expect(await reported(root, 'cat README.md | grep -l also')).toEqual(['README.md']);
  });

  test('a recursive grep with no operand reads stdin and defers to the file upstream', async () => {
    const root = await corpus();
    expect(await reported(root, 'cat README.md | grep -r also')).toEqual(['README.md']);
  });

  test('a non-wiki operand downstream does not hijack the producer', async () => {
    const root = await corpus();
    expect(await reported(root, 'cat README.md | sort plain.txt')).toEqual(['README.md']);
  });
});
