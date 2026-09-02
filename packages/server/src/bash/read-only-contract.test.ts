import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { createBashInstance, execBash } from './index.ts';
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

type Disposition = 'parse-blocked' | 'ran' | 'exec-threw';

interface Attempt {
  command: string;
  expect: Disposition;
  category?: string;
}

async function attempt(
  root: string,
  command: string,
): Promise<{ disposition: Disposition; category?: string }> {
  const parsed = parseCommand(command);
  if ('error' in parsed) return { disposition: 'parse-blocked', category: parsed.error.category };
  try {
    const effective = serializeStages(augmentStagesWithExcludes(parsed.stages));
    await execBash(createBashInstance(root), effective);
    return { disposition: 'ran' };
  } catch {
    return { disposition: 'exec-threw' };
  }
}

const WRITE_ATTEMPTS: Attempt[] = [
  { command: 'sort -o important.md other.md', expect: 'parse-blocked', category: 'write_blocked' },
  {
    command: 'sort --output important.md other.md',
    expect: 'parse-blocked',
    category: 'write_blocked',
  },
  {
    command: 'sort --output-file important.md other.md',
    expect: 'parse-blocked',
    category: 'write_blocked',
  },
  { command: 'sort -o=important.md other.md', expect: 'parse-blocked', category: 'write_blocked' },
  { command: 'sort -oimportant.md other.md', expect: 'parse-blocked', category: 'write_blocked' },
  {
    command: 'sort -r -o important.md other.md',
    expect: 'parse-blocked',
    category: 'write_blocked',
  },
  { command: 'sort -ro important.md other.md', expect: 'parse-blocked', category: 'write_blocked' },
  {
    command: 'sort -nro important.md other.md',
    expect: 'parse-blocked',
    category: 'write_blocked',
  },
  { command: 'sort -uo important.md other.md', expect: 'parse-blocked', category: 'write_blocked' },
  {
    command: 'sort -o important.md -r other.md',
    expect: 'parse-blocked',
    category: 'write_blocked',
  },
  { command: 'find . -delete', expect: 'parse-blocked', category: 'write_blocked' },
  { command: 'find . -name *.md -delete', expect: 'parse-blocked', category: 'write_blocked' },
  { command: 'find . -exec rm {} +', expect: 'parse-blocked', category: 'write_blocked' },
  { command: 'find . -execdir rm {} +', expect: 'parse-blocked', category: 'write_blocked' },
  { command: 'find . -ok rm {} +', expect: 'parse-blocked', category: 'write_blocked' },
  { command: 'find . -okdir rm {} +', expect: 'parse-blocked', category: 'write_blocked' },
  { command: 'find . -fprint important.md', expect: 'parse-blocked', category: 'write_blocked' },
  {
    command: 'find . -fprintf important.md %p',
    expect: 'parse-blocked',
    category: 'write_blocked',
  },
  { command: 'find . -fls important.md', expect: 'parse-blocked', category: 'write_blocked' },
  { command: 'find . -exec rm {} ;', expect: 'parse-blocked', category: 'shell_construct_blocked' },
  {
    command: 'find . -execdir rm {} ;',
    expect: 'parse-blocked',
    category: 'shell_construct_blocked',
  },
  { command: 'find . -ok rm {} ;', expect: 'parse-blocked', category: 'shell_construct_blocked' },
  { command: 'cat other.md > important.md', expect: 'parse-blocked', category: 'write_blocked' },
  { command: 'cat other.md >> important.md', expect: 'parse-blocked', category: 'write_blocked' },
  {
    command: 'cat other.md | tee important.md',
    expect: 'parse-blocked',
    category: 'unknown_command',
  },
  {
    command: 'cut -f1 other.md -o important.md',
    expect: 'parse-blocked',
    category: 'write_blocked',
  },
  {
    command: 'sort other.md `rm important.md`',
    expect: 'parse-blocked',
    category: 'shell_construct_blocked',
  },
  {
    command: 'sort other.md $(rm important.md)',
    expect: 'parse-blocked',
    category: 'shell_construct_blocked',
  },
  { command: 'find {*,-delete}', expect: 'ran' },
  { command: 'find {.,-delete}', expect: 'ran' },
  { command: 'find *', expect: 'ran' },
  { command: 'uniq other.md important.md', expect: 'ran' },
];

describe('exec is read-only — no allowlisted command may alter the tree', () => {
  test.each(
    WRITE_ATTEMPTS,
  )('$command is refused at the layer that owns it and changes nothing', async ({
    command,
    expect: expected,
    category,
  }) => {
    const root = build();
    const before = snapshot(root);
    const result = await attempt(root, command);
    expect(result.disposition).toBe(expected);
    if (category !== undefined) expect(result.category).toBe(category);
    expect(snapshot(root)).toEqual(before);
  });

  test('the write guard and the mtime backstop read an attached value the same way', () => {
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

describe('the write guard does not reach commands whose -o only reads', () => {
  test.each([
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
