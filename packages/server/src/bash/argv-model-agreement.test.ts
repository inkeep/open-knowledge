import { describe, expect, test } from 'vitest';
import { pathArgs } from './extract-paths.ts';
import { deriveScanRoots } from './mtime-scan.ts';
import { classifyArgs, parseCommand, type Stage } from './parse-command.ts';

function stageOf(command: string): Stage {
  const parsed = parseCommand(command);
  if ('error' in parsed) throw new Error(`expected '${command}' to parse: ${parsed.error.message}`);
  return parsed.stages[0];
}

const COMMANDS = [
  'grep -m 5 needle notes.md',
  'grep -e needle notes.md',
  'grep -rn needle .',
  'grep --include=*.md needle .',
  'grep -A 2 needle notes.md',
  'sort -k 2 notes.md',
  'sort -t , notes.md',
  'uniq -f 2 notes.md',
  'uniq -w 3 notes.md',
  'cut -d , -f 1 notes.md',
  'cut -d, -f1 notes.md',
  'find . -name *.md',
  'find . -newer ref.md',
  'find docs -maxdepth 2',
  'head -n 5 notes.md',
  'tail -c 20 notes.md',
  'wc -l notes.md',
  'cat -n notes.md',
  'ls -la docs',
];

describe('one argv model, read by every consumer', () => {
  test.each(COMMANDS)('%s — the sweep never watches less than the extractor reports', (command) => {
    const stage = stageOf(command);
    const watched = deriveScanRoots([stage]);
    for (const path of pathArgs(stage)) expect(watched).toContain(path);
  });

  test.each(COMMANDS)('%s — no consumer invents a token', (command) => {
    const stage = stageOf(command);
    const typed = command.split(/\s+/);
    for (const value of [...pathArgs(stage), ...deriveScanRoots([stage])]) {
      expect(typed, `${command} produced "${value}"`).toContain(value);
    }
  });

  test('the sweep watches an unknown attached value that the extractor does not', () => {
    const stage = stageOf('sort --weird=out.md notes.md');
    expect(pathArgs(stage)).toEqual(['notes.md']);
    expect(deriveScanRoots([stage])).toContain('out.md');
  });

  test('a bundled switch is never read as a value', () => {
    expect(classifyArgs(stageOf('ls -la docs')).filter((a) => a.role === 'attached-value')).toEqual(
      [],
    );
    expect(
      classifyArgs(stageOf('grep -rn needle .')).filter((a) => a.role === 'attached-value'),
    ).toEqual([]);
  });

  test('a glued value on a flag that takes one is read as a value', () => {
    const glued = classifyArgs(stageOf('cut -d, -f1 notes.md')).filter(
      (a) => a.role === 'attached-value',
    );
    expect(glued.map((a) => a.value)).toEqual([',', '1']);
  });
});
