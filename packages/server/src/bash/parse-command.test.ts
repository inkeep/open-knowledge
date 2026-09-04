import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { expandGlobStages, GLOB_EXPANSION_CAP } from './expand-globs.ts';
import { extractReferencedPaths } from './extract-paths.ts';
import { createBashInstance, execBash } from './index.ts';
import { augmentStagesWithExcludes, parseCommand, serializeStages } from './parse-command.ts';

function expectOk(
  cmd: string,
  assertion?: (stages: Array<{ command: string; args: string[] }>) => void,
): void {
  const result = parseCommand(cmd);
  if ('error' in result) {
    throw new Error(
      `Expected '${cmd}' to parse, got error: ${result.error.category} — ${result.error.message}`,
    );
  }
  assertion?.(result.stages);
}

function expectError(cmd: string, category: string): void {
  const result = parseCommand(cmd);
  if (!('error' in result)) {
    throw new Error(`Expected '${cmd}' to error with ${category}, but it parsed`);
  }
  expect(result.error.category).toBe(category);
}

describe('parseCommand — allow-list positives', () => {
  test('cat with path', () =>
    expectOk('cat articles/auth.md', (stages) => {
      expect(stages.length).toBe(1);
      expect(stages[0].command).toBe('cat');
      expect(stages[0].args).toEqual(['cat', 'articles/auth.md']);
    }));

  test('ls with flag', () =>
    expectOk('ls -la articles/', (stages) => {
      expect(stages[0].command).toBe('ls');
    }));

  test('grep with quoted arg + glob', () =>
    expectOk("grep 'oauth' *.md", (stages) => {
      expect(stages[0].command).toBe('grep');
      expect(stages[0].args).toContain('oauth');
      expect(stages[0].args).toContain('*.md');
    }));

  test('pipe between allowlisted stages', () =>
    expectOk('grep foo articles/ | head -5', (stages) => {
      expect(stages.length).toBe(2);
      expect(stages[0].command).toBe('grep');
      expect(stages[1].command).toBe('head');
    }));

  test('find with safe flags', () =>
    expectOk('find . -name "*.md"', (stages) => {
      expect(stages[0].command).toBe('find');
    }));

  test('multi-stage pipe', () =>
    expectOk('grep x articles/ | head -20 | wc -l', (stages) => {
      expect(stages.length).toBe(3);
    }));
});

describe('parseCommand — unknown_command', () => {
  test('awk first-token is blocked', () => expectError("awk '{print}' file.md", 'unknown_command'));
  test('sed first-token is blocked', () => expectError('sed s/a/b/ file.md', 'unknown_command'));
  test('xargs first-token is blocked', () => expectError('xargs -I echo', 'unknown_command'));
  test('rm first-token is blocked', () => expectError('rm file.md', 'unknown_command'));
  test('mv first-token is blocked', () => expectError('mv a b', 'unknown_command'));
  test('chmod first-token is blocked', () => expectError('chmod 755 file', 'unknown_command'));
  test('pipe with disallowed second stage', () =>
    expectError('cat file.md | awk {}', 'unknown_command'));
});

describe('parseCommand — write_blocked (redirection and write flags)', () => {
  test('`>` redirection', () => expectError('grep foo > out.txt', 'write_blocked'));
  test('`>>` append', () => expectError('cat a >> b', 'write_blocked'));
  test('`<` input redirection', () => expectError('cat < file', 'shell_construct_blocked'));

  test.each([
    '||',
    '&&',
    ';;',
    '|&',
    '<(',
    '<<<',
    '>>',
    '>&',
    '<&',
    '&',
    ';',
    '(',
    ')',
    '<',
    '>',
  ])('%s is classified, not left to the generic operator message', (op) => {
    const result = parseCommand(`cat a.md ${op} b.md`);
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.message).not.toMatch(/^Operator /);
  });
  test('find -exec rejected (via ; op token)', () =>
    expectError('find . -exec rm {} ;', 'shell_construct_blocked'));
  test('find -execdir rejected (via ; op token)', () =>
    expectError('find . -execdir echo {} ;', 'shell_construct_blocked'));
  test('find -ok rejected (via ; op token)', () =>
    expectError('find . -ok rm {} ;', 'shell_construct_blocked'));
});

describe('parseCommand — shell_construct_blocked', () => {
  test('subshell `$(...)` splits into `(` op — rejected', () =>
    expectError('echo $(whoami)', 'shell_construct_blocked'));
  test('backticks in arg', () => expectError('cat `ls`', 'shell_construct_blocked'));
  test('sequencing `&&`', () => expectError('cat file && rm file', 'shell_construct_blocked'));
  test('sequencing `;`', () => expectError('cat a ; cat b', 'shell_construct_blocked'));
  test('sequencing `||`', () => expectError('cat a || cat b', 'shell_construct_blocked'));
  test('background `&`', () => expectError('cat file &', 'shell_construct_blocked'));
  test('explicit subshell `( cmd )`', () => expectError('( cat a )', 'shell_construct_blocked'));
  test('empty command', () => expectError('', 'unknown_command'));
  test('empty pipeline stage', () => expectError('cat file |', 'shell_construct_blocked'));
  test('process substitution `<(cmd)`', () =>
    expectError('cat <(grep x file)', 'shell_construct_blocked'));
  test('process substitution `>(cmd)` — `>` fires first', () =>
    expectError('tee >(cat)', 'write_blocked'));
});

describe('parseCommand — env/var expansions pass-through (handled at runtime)', () => {
  test('$IFS strips to empty — parser accepts', () => {
    const result = parseCommand('cat $IFS/etc/passwd');
    if ('error' in result) {
      throw new Error('expected parse to succeed (runtime guard handles traversal)');
    }
    expect(result.stages[0].command).toBe('cat');
  });
  test('$-brace env refs strip to empty — parser accepts', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literally tests ${HOME} env-ref parsing, not a template literal
    const result = parseCommand('cat ${HOME}/file');
    if ('error' in result) throw new Error('expected parse to succeed');
    expect(result.stages[0].command).toBe('cat');
  });
});

describe('augmentStagesWithExcludes — grep', () => {
  function parse(cmd: string) {
    const r = parseCommand(cmd);
    if ('error' in r) throw new Error(`parse error: ${r.error.message}`);
    return r.stages;
  }

  test('injects --exclude-dir on recursive grep', () => {
    const stages = augmentStagesWithExcludes(parse('grep -rn oauth .'));
    expect(stages[0].args).toContain('--exclude-dir=node_modules');
    expect(stages[0].args).toContain('--exclude-dir=.git');
    expect(stages[0].args).toContain('--exclude-dir=.claude');
    expect(stages[0].args.indexOf('--exclude-dir=node_modules')).toBeGreaterThan(0);
  });

  test('injects on -R (dereference-recursive)', () => {
    const stages = augmentStagesWithExcludes(parse('grep -Rn oauth .'));
    expect(stages[0].args).toContain('--exclude-dir=node_modules');
  });

  test('injects on --recursive long form', () => {
    const stages = augmentStagesWithExcludes(parse('grep --recursive oauth .'));
    expect(stages[0].args).toContain('--exclude-dir=node_modules');
  });

  test('injects on combined short flags regardless of order', () => {
    for (const cmd of ['grep -inr oauth .', 'grep -nr oauth .', 'grep -nRi oauth .']) {
      const stages = augmentStagesWithExcludes(parse(cmd));
      expect(stages[0].args).toContain('--exclude-dir=node_modules');
    }
  });

  test('skips non-recursive grep', () => {
    const stages = augmentStagesWithExcludes(parse('grep oauth README.md'));
    expect(stages[0].args).not.toContain('--exclude-dir=node_modules');
  });

  test('respects user-provided --exclude-dir', () => {
    const stages = augmentStagesWithExcludes(parse('grep -rn --exclude-dir=my-dir oauth .'));
    expect(stages[0].args).toContain('--exclude-dir=my-dir');
    expect(stages[0].args.filter((a) => a.startsWith('--exclude-dir=')).length).toBe(1);
  });

  test('serializeStages round-trips the augmented command', () => {
    const stages = augmentStagesWithExcludes(parse('grep -rn oauth .'));
    const cmd = serializeStages(stages);
    expect(cmd).toMatch(/^grep /);
    expect(cmd).toContain('--exclude-dir=node_modules');
    expect(cmd).toContain('oauth');
  });
});

describe('augmentStagesWithExcludes — find', () => {
  function parse(cmd: string) {
    const r = parseCommand(cmd);
    if ('error' in r) throw new Error(`parse error: ${r.error.message}`);
    return r.stages;
  }

  test('injects -not -path on find with expression', () => {
    const stages = augmentStagesWithExcludes(parse('find . -name "*.md"'));
    const joined = stages[0].args.join(' ');
    expect(joined).toContain('-not -path */node_modules/*');
    expect(stages[0].args.indexOf('-not')).toBeLessThan(stages[0].args.indexOf('-name'));
  });

  test('injects when no path arg given', () => {
    const stages = augmentStagesWithExcludes(parse('find -name "*.md"'));
    expect(stages[0].args).toContain('-not');
    expect(stages[0].args.indexOf('-not')).toBe(1);
  });

  test('skips when user already passed -not', () => {
    const stages = augmentStagesWithExcludes(parse('find . -not -path "*/foo/*" -name "*.md"'));
    expect(stages[0].args.filter((a) => a === '-not').length).toBe(1);
  });

  test('still injects when user passes -path for inclusion (not exclusion)', () => {
    const stages = augmentStagesWithExcludes(parse('find . -path "docs/*.md"'));
    expect(stages[0].args).toContain('-not');
    expect(stages[0].args.join(' ')).toContain('-not -path */node_modules/*');
  });

  test('skips when user already passed -prune', () => {
    const stages = augmentStagesWithExcludes(
      parse('find . -path "*/node_modules" -prune -name "*.md"'),
    );
    expect(stages[0].args.filter((a) => a === '-not').length).toBe(0);
  });
});

describe('augmentStagesWithExcludes — pass-through', () => {
  function parse(cmd: string) {
    const r = parseCommand(cmd);
    if ('error' in r) throw new Error(`parse error: ${r.error.message}`);
    return r.stages;
  }

  test('cat / ls / head / tail unchanged', () => {
    for (const cmd of ['cat a.md', 'ls docs/', 'head -n5 a.md', 'tail -n5 a.md']) {
      const before = parse(cmd);
      const after = augmentStagesWithExcludes(before);
      expect(after[0].args).toEqual(before[0].args);
    }
  });

  test('pipeline: only recursive grep stage is augmented', async () => {
    const stages = augmentStagesWithExcludes(parse('grep -rn oauth . | head -5'));
    expect(stages[0].args).toContain('--exclude-dir=node_modules');
    expect(stages[1].args).toEqual(['head', '-5']);
  });
});

describe('glob operands', () => {
  const created: string[] = [];
  afterAll(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
  });

  function corpus(files: string[], dirs: string[] = []): string {
    const root = mkdtempSync(join(tmpdir(), 'glob-operands-'));
    created.push(root);
    for (const dir of dirs) mkdirSync(join(root, dir));
    for (const file of files) writeFileSync(join(root, file), 'data\n');
    return root;
  }

  async function pipeline(root: string, cmd: string) {
    const parsed = parseCommand(cmd);
    if ('error' in parsed) throw new Error(`Expected '${cmd}' to parse`);
    const expanded = await expandGlobStages(parsed.stages, root);
    if ('error' in expanded) return { blocked: expanded.error.message };
    const stages = augmentStagesWithExcludes(expanded.stages);
    return { stages, command: serializeStages(stages) };
  }

  async function run(root: string, cmd: string) {
    const step = await pipeline(root, cmd);
    if (step.blocked !== undefined)
      throw new Error(`expected ${cmd} to parse, got: ${step.blocked}`);
    const result = await execBash(createBashInstance(root), step.command);
    return {
      ...step,
      stdout: result.stdout,
      paths: extractReferencedPaths(result.stdout, step.stages),
    };
  }

  test('a glob operand is expanded to real files before the engine runs', async () => {
    const root = corpus(['specs/one.md', 'specs/two.md', 'top.md'], ['specs']);
    expect((await pipeline(root, 'cat specs/*.md')).command).toBe('cat specs/one.md specs/two.md');
  });

  test('a pattern matching nothing stays literal, as a shell leaves it', async () => {
    const root = corpus(['top.md']);
    expect((await pipeline(root, 'cat nomatch/*.md')).command).toBe("cat 'nomatch/*.md'");
  });

  test('every argument still reaches the engine quoted', async () => {
    const root = corpus(['top.md']);
    expect((await pipeline(root, 'cat *.md')).command).toBe('cat top.md');
    expect((await pipeline(root, "grep 'two words' top.md")).command).toBe(
      "grep 'two words' top.md",
    );
  });

  test('a filename the glob produced is escaped, not handed over raw', async () => {
    const root = corpus(['my notes.md', 'plain.md']);
    expect((await pipeline(root, 'cat *.md')).command).toBe("cat 'my notes.md' plain.md");
  });

  test('a pattern matching more than the cap is refused with a way forward', async () => {
    const root = corpus(Array.from({ length: 12 }, (_, index) => `f${index}.md`));
    const parsed = parseCommand('cat *.md');
    if ('error' in parsed) throw new Error('expected parse');
    const expanded = await expandGlobStages(parsed.stages, root, 5);
    if (!('error' in expanded)) throw new Error('expected the cap to refuse 12 matches against 5');
    expect(expanded.error.message).toContain('more than 5 paths');
    expect(expanded.error.message).toMatch(/narrow/i);
  });

  test('at or under the cap the command is expanded normally', async () => {
    const root = corpus(Array.from({ length: 5 }, (_, index) => `f${index}.md`));
    const parsed = parseCommand('cat *.md');
    if ('error' in parsed) throw new Error('expected parse');
    const expanded = await expandGlobStages(parsed.stages, root, 5);
    if ('error' in expanded) throw new Error('expected 5 matches to pass a cap of 5');
    expect(expanded.stages[0].args).toHaveLength(6);
  });

  test('expansion never names what every other exec surface hides', async () => {
    const root = corpus(
      ['top.md', 'node_modules/dep/readme.md', 'dist/out.md'],
      ['node_modules', 'node_modules/dep', 'dist'],
    );
    const step = await pipeline(root, 'cat **/*.md');
    if (step.blocked !== undefined) throw new Error(step.blocked);
    expect(step.stages[0].args).toEqual(['cat', 'top.md']);
  });

  test('the shipped cap is what production uses', () => {
    expect(GLOB_EXPANSION_CAP).toBe(1000);
  });

  test('an absolute pattern is passed through literally, never expanded', async () => {
    const root = corpus(['top.md']);
    expect((await pipeline(root, 'cat /etc/*.conf')).command).toBe("cat '/etc/*.conf'");
    expect((await pipeline(root, 'cat /*.md')).command).toBe("cat '/*.md'");
  });

  test.each([
    ['grep -rn --include *.md needle .', "--include '*.md'"],
    ['grep -rn --include=*.md needle .', "'--include=*.md'"],
    ['grep --exclude-dir *.md needle .', "--exclude-dir '*.md'"],
    ['grep --exclude *.md needle .', "--exclude '*.md'"],
  ])('%s leaves the glob for grep to match', async (cmd, expected) => {
    const root = corpus(['PRD-1.md', 'notes.md']);
    expect((await pipeline(root, cmd)).command).toContain(expected);
  });

  test('a glob in a flag value slot is not expanded into file operands', async () => {
    const root = corpus(['a.md', 'b.md']);
    expect((await pipeline(root, 'uniq -f *')).command).toBe("uniq -f '*'");
    expect((await pipeline(root, 'sort -k * a.md')).command).toBe("sort -k '*' a.md");
  });

  test('a flag that supplies grep its patterns does not reserve a positional', async () => {
    const root = corpus(['PRD-1.md', 'notes.md', 'pats.txt']);
    expect((await pipeline(root, 'grep -f pats.txt *.md')).command).toBe(
      'grep -f pats.txt PRD-1.md notes.md',
    );
    expect((await pipeline(root, 'grep --file=pats.txt *.md')).command).toBe(
      "grep '--file=pats.txt' PRD-1.md notes.md",
    );
  });

  test('find keeps its own pattern matching instead of expanding first', async () => {
    const root = corpus(['top.md', 'deep/nested.md'], ['deep']);
    expect((await pipeline(root, 'find . -name *.md')).command).toContain("-name '*.md'");
  });

  test('a quoted pattern is never expanded and is matched literally', async () => {
    const root = corpus(['specs/one.md'], ['specs']);
    expect((await pipeline(root, "find . -name '*.md'")).command).toContain("-name '*.md'");
  });

  test('the engine returns the globbed files', async () => {
    const root = corpus(['specs/one.md', 'specs/two.md'], ['specs']);
    expect((await run(root, 'cat specs/*.md')).stdout).toBe('data\ndata\n');
  });

  test('enrichment names the real files, not the pattern', async () => {
    const root = corpus(['specs/one.md', 'specs/two.md'], ['specs']);
    expect((await run(root, 'cat specs/*.md')).paths).toEqual(['specs/one.md', 'specs/two.md']);
    expect((await run(root, 'ls specs/*.md')).paths).toEqual(['specs/one.md', 'specs/two.md']);
  });

  test('brace expansion cannot smuggle a denied flag past the allowlist', async () => {
    const root = corpus(['k1.md', 'k2.md']);
    const before = readdirSync(root).sort();
    const result = await run(root, 'find {*,-delete}');
    expect(result.command).toContain("'{*,-delete}'");
    expect(readdirSync(root).sort()).toEqual(before);
  });
});

describe('find flags that run another command', () => {
  test.each([
    '-exec',
    '-execdir',
    '-ok',
    '-okdir',
  ])('find %s is refused by the parser, since it runs a command the allowlist never sees', (flag) =>
    expectError(`find . ${flag} rm {} +`, 'shell_construct_blocked'));
});

describe('a flag value is not a positional', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function corpus(files: string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'positional-'));
    dirs.push(root);
    for (const file of files) writeFileSync(join(root, file), 'data\n');
    return root;
  }

  async function serialize(root: string, cmd: string): Promise<string> {
    const parsed = parseCommand(cmd);
    if ('error' in parsed) throw new Error(`expected '${cmd}' to parse: ${parsed.error.message}`);
    const expanded = await expandGlobStages(parsed.stages, root);
    if ('error' in expanded) throw new Error(`expected '${cmd}' to expand`);
    return serializeStages(expanded.stages);
  }

  test.each([
    'uniq -f 2 notes.md',
    'uniq -s 1 notes.md',
    'uniq -w 3 notes.md',
    'uniq -c notes.md',
    'sort -k 2 notes.md',
    'sort -t , notes.md',
  ])('%s reads its flag value as a value, not an operand', (command) => {
    expect('error' in parseCommand(command)).toBe(false);
  });

  test("grep's pattern is the first positional, not the first non-flag token", async () => {
    const root = corpus(['PRD-1.md', 'notes.md']);
    expect(await serialize(root, 'grep -m 5 PRD-* .')).toContain("'PRD-*'");
    expect(await serialize(root, 'grep -A 2 PRD-* .')).toContain("'PRD-*'");
    expect(await serialize(root, 'grep PRD-* .')).toContain("'PRD-*'");
  });

  test('an explicit -e pattern leaves the positionals free to expand', async () => {
    const root = corpus(['PRD-1.md', 'notes.md']);
    expect(await serialize(root, 'grep -e PRD-1 *.md')).toBe('grep -e PRD-1 PRD-1.md notes.md');
  });
});
