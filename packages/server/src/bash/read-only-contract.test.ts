import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { expandGlobStages } from './expand-globs.ts';
import { createBashInstance, erofsTarget, execBash } from './index.ts';
import { deriveScanRoots } from './mtime-scan.ts';
import { augmentStagesWithExcludes, parseCommand, serializeStages } from './parse-command.ts';

const built: string[] = [];
afterAll(() => {
  for (const dir of built) rmSync(dir, { recursive: true, force: true });
});

function build(): string {
  const root = mkdtempSync(join(tmpdir(), 'read-only-contract-'));
  built.push(root);
  mkdirSync(join(root, 'specs'));
  writeFileSync(join(root, 'important.md'), '# Important\nDo not lose this\n');
  writeFileSync(join(root, 'other.md'), 'zzz\naaa\n');
  writeFileSync(join(root, 'specs/one.md'), 'ONE\n');
  writeFileSync(join(root, '-delete'), 'flag-shaped filename\n');
  writeFileSync(join(root, '-o'), 'flag-shaped filename\n');
  return root;
}

function snapshot(dir: string, root = dir): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      return entry.isDirectory()
        ? snapshot(full, root)
        : [`${relative(root, full)}=${readFileSync(full, 'utf8')}`];
    })
    .sort();
}

type Disposition = 'parse-blocked' | 'fs-refused' | 'engine-rejected' | 'ran' | 'exec-threw';

async function attempt(
  root: string,
  command: string,
): Promise<{ disposition: Disposition; category?: string; stderr?: string }> {
  const parsed = parseCommand(command);
  if ('error' in parsed) return { disposition: 'parse-blocked', category: parsed.error.category };
  const expanded = await expandGlobStages(parsed.stages, root);
  if ('error' in expanded)
    return { disposition: 'parse-blocked', category: expanded.error.category };
  try {
    const effective = serializeStages(augmentStagesWithExcludes(expanded.stages));
    const result = await execBash(createBashInstance(root), effective);
    if (erofsTarget(result.stderr).blocked) return { disposition: 'fs-refused' };
    if (result.exitCode !== 0) return { disposition: 'engine-rejected', stderr: result.stderr };
    return { disposition: 'ran' };
  } catch (error) {
    return { disposition: erofsTarget(error).blocked ? 'fs-refused' : 'exec-threw' };
  }
}

const PARSER_MUST_REFUSE: Array<[string, string]> = [
  ['find . -exec rm {} +', 'shell_construct_blocked'],
  ['find . -execdir rm {} +', 'shell_construct_blocked'],
  ['find . -ok rm {} +', 'shell_construct_blocked'],
  ['find . -okdir rm {} +', 'shell_construct_blocked'],
  ['find . -exec rm {} ;', 'shell_construct_blocked'],
  ['find . -execdir rm {} ;', 'shell_construct_blocked'],
  ['find . -ok rm {} ;', 'shell_construct_blocked'],
  ['cat other.md > important.md', 'write_blocked'],
  ['cat other.md >> important.md', 'write_blocked'],
  ['cat other.md > /tmp/escaped.md', 'write_blocked'],
  ['cat other.md | tee important.md', 'unknown_command'],
  ['sort other.md `rm important.md`', 'shell_construct_blocked'],
  ['sort other.md $(rm important.md)', 'shell_construct_blocked'],
];

const FILESYSTEM_MUST_REFUSE: string[] = [
  'sort -o important.md other.md',
  'sort --output important.md other.md',
  'sort -o=important.md other.md',
  'sort -oimportant.md other.md',
  'sort -r -o important.md other.md',
  'sort -o important.md -r other.md',
  'sort -o /tmp/escaped.md other.md',
  'sort -o ../escaped.md other.md',
  'find . -delete',
  'find . -name *.md -delete',
  'find / -delete',
  'find *',
];

const ENGINE_DOES_NOT_IMPLEMENT: string[] = [
  'sort --output-file important.md other.md',
  'sort -ro important.md other.md',
  'sort -nro important.md other.md',
  'sort -uo important.md other.md',
  'find . -fprint important.md',
  'find . -fprintf important.md %p',
  'find . -fls important.md',
  'cut -f1 other.md -o important.md',
  'find {*,-delete}',
  'find {.,-delete}',
  'sort *',
];

const INERT_UNDER_THIS_ENGINE: string[] = [
  'sort *.md',
  'uniq *.md',
  'uniq other.md important.md',
  'uniq -- -delete important.md',
];

describe('exec is read-only — no allowlisted command may alter the tree', () => {
  test('the filesystem refuses a write the parser never sees', async () => {
    const root = build();
    const before = snapshot(root);
    const bash = createBashInstance(root);
    await expect(execBash(bash, 'cat other.md > important.md')).rejects.toThrow(/EROFS/);
    expect(snapshot(root)).toEqual(before);
  });

  test.each(PARSER_MUST_REFUSE)('%s is refused by the parser as %s', async (command, category) => {
    const root = build();
    const before = snapshot(root);
    expect(await attempt(root, command)).toEqual({ disposition: 'parse-blocked', category });
    expect(snapshot(root)).toEqual(before);
  });

  test.each(FILESYSTEM_MUST_REFUSE)('%s reaches the filesystem and it refuses', async (command) => {
    const root = build();
    const before = snapshot(root);
    expect(await attempt(root, command)).toEqual({ disposition: 'fs-refused' });
    expect(snapshot(root)).toEqual(before);
  });

  test.each(
    ENGINE_DOES_NOT_IMPLEMENT,
  )('%s dies on an option just-bash does not implement, which is not the mount', async (command) => {
    const root = build();
    const before = snapshot(root);
    const result = await attempt(root, command);
    expect(result.disposition).toBe('engine-rejected');
    expect(result.stderr).toMatch(
      /invalid option|unrecognized option|unknown predicate|No such file/,
    );
    expect(snapshot(root)).toEqual(before);
  });

  test.each(
    INERT_UNDER_THIS_ENGINE,
  )('%s runs to completion because this engine never writes for it', async (command) => {
    const root = build();
    const before = snapshot(root);
    expect(await attempt(root, command)).toEqual({ disposition: 'ran' });
    expect(snapshot(root)).toEqual(before);
  });

  test('expansion can hand sort a genuine -o, and the filesystem refuses it', async () => {
    const root = build();
    rmSync(join(root, '-delete'));
    rmSync(join(root, 'specs'), { recursive: true });
    const before = snapshot(root);
    expect(await attempt(root, 'sort *')).toEqual({ disposition: 'fs-refused' });
    expect(snapshot(root)).toEqual(before);
  });

  test('the mtime backstop reads an attached value as a path', () => {
    const roots = deriveScanRoots([{ command: 'sort', args: ['sort', '-onotes', 'other.md'] }]);
    expect(roots).toContain('notes');
  });

  test('the corpus itself would register a change, so the assertion is not vacuous', () => {
    const root = build();
    const before = snapshot(root);
    writeFileSync(join(root, 'important.md'), 'clobbered\n');
    expect(snapshot(root)).not.toEqual(before);
  });

  test('a read-only command that names an output-shaped flag still works', () => {
    const parsed = parseCommand('cut -f1 --output-delimiter=x other.md');
    expect('error' in parsed).toBe(false);
  });
});

describe('a read-only -o parses for every command that has one', () => {
  test.each([
    'grep -o needle other.md',
    'find . -name a.md -o -name b.md',
    'grep -oE PRD-[0-9]+ other.md',
    'grep -on needle other.md',
    'grep -orn needle .',
    'grep -oh needle other.md',
    'find . -name a.md -or -name b.md',
    'cut -f1 --output-delimiter=x other.md',
    'sort -r other.md',
    'sort -n other.md',
  ])('%s parses', (command) => {
    const parsed = parseCommand(command);
    if ('error' in parsed) {
      throw new Error(`expected '${command}' to parse, got: ${parsed.error.message}`);
    }
    expect('error' in parsed).toBe(false);
  });
});
