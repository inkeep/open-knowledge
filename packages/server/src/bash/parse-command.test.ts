import { describe, expect, test } from 'bun:test';
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
  test('`<` input redirection', () => expectError('cat < file', 'write_blocked'));
  test('sort -o output flag', () => expectError('sort -o out file', 'write_blocked'));
  test('sort --output=file', () => expectError('sort --output=out file', 'write_blocked'));
  test('find -delete', () => expectError('find . -name "*.md" -delete', 'write_blocked'));
  test('find -fprint', () => expectError('find . -fprint out.txt', 'write_blocked'));
  // find -exec / -execdir / -ok take a command terminated by `;` which
  // shell-quote turns into an op token — the shell-construct layer fires
  // first. Either rejection is correct; categorizing as shell_construct_blocked
  // is defensible because the `;` terminator is the real injection vector.
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
  // shell-quote strips `$IFS`, `$HOME`, `${FOO}` etc. when no env map is
  // provided — they become empty strings in the arg list. The resulting
  // command parses fine at the parser layer; path-traversal rejection
  // happens later in the exec handler via realpath check.
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
    // None of ours injected
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
    // Injection happens before the -name primary
    expect(stages[0].args.indexOf('-not')).toBeLessThan(stages[0].args.indexOf('-name'));
  });

  test('injects when no path arg given', () => {
    const stages = augmentStagesWithExcludes(parse('find -name "*.md"'));
    expect(stages[0].args).toContain('-not');
    expect(stages[0].args.indexOf('-not')).toBe(1);
  });

  test('skips when user already passed -not', () => {
    const stages = augmentStagesWithExcludes(parse('find . -not -path "*/foo/*" -name "*.md"'));
    // Only the user's -not should be present
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
    // No additional -not injected
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

  test('pipeline: only recursive grep stage is augmented', () => {
    const stages = augmentStagesWithExcludes(parse('grep -rn oauth . | head -5'));
    expect(stages[0].args).toContain('--exclude-dir=node_modules');
    expect(stages[1].args).toEqual(['head', '-5']);
  });
});
