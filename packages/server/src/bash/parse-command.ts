import { OK_DIR } from '@inkeep/open-knowledge-core';
import shellQuote from 'shell-quote';
import { shellEscape } from './shell-escape.ts';

export type ErrorCategory =
  | 'unknown_command'
  | 'write_blocked'
  | 'shell_construct_blocked'
  | 'path_traversal'
  | 'output_overflow'
  | 'security_invariant_violation';

export interface ParseCommandError {
  category: ErrorCategory;
  message: string;
}

export interface Stage {
  command: string;
  args: string[];
}

export interface GlobStage extends Stage {
  globArgIndices: readonly number[];
}

type ParseResult = { stages: GlobStage[] } | { error: ParseCommandError };

export const WIKI_EXCLUDE_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.nuxt',
  'coverage',
  '.cache',
  '.parcel-cache',
  '.vercel',
  OK_DIR,
  '.claude',
];

interface ExcludeStrategy {
  command: string;
  applies(args: string[]): boolean;
  hasUserExcludes(args: string[]): boolean;
  buildExcludeArgs(dirs: readonly string[]): string[];
  insertionIndex(args: string[]): number;
}

export function isRecursiveGrepFlag(arg: string): boolean {
  if (arg === '--recursive' || arg === '--dereference-recursive') return true;
  if (arg.startsWith('--')) return false;
  if (!arg.startsWith('-')) return false;
  return /[rR]/.test(arg.slice(1));
}

const GREP_STRATEGY: ExcludeStrategy = {
  command: 'grep',
  applies: (args) => args.slice(1).some(isRecursiveGrepFlag),
  hasUserExcludes: (args) =>
    args.some((a) => a === '--exclude-dir' || a.startsWith('--exclude-dir=')),
  buildExcludeArgs: (dirs) => dirs.map((d) => `--exclude-dir=${d}`),
  insertionIndex: () => 1,
};

const FIND_STRATEGY: ExcludeStrategy = {
  command: 'find',
  applies: () => true,
  hasUserExcludes: (args) => args.slice(1).some((a) => a === '-not' || a === '!' || a === '-prune'),
  buildExcludeArgs: (dirs) => {
    const out: string[] = [];
    for (const d of dirs) {
      out.push('-not', '-path', `*/${d}/*`);
    }
    return out;
  },
  insertionIndex: (args) => {
    for (let i = 1; i < args.length; i++) {
      if (args[i].startsWith('-')) return i;
    }
    return args.length;
  },
};

const STRATEGIES: readonly ExcludeStrategy[] = [GREP_STRATEGY, FIND_STRATEGY];

export function augmentStagesWithExcludes(stages: Stage[]): Stage[] {
  return stages.map((stage) => {
    const strategy = STRATEGIES.find((s) => s.command === stage.command);
    if (!strategy) return stage;
    if (!strategy.applies(stage.args)) return stage;
    if (strategy.hasUserExcludes(stage.args)) return stage;
    const extra = strategy.buildExcludeArgs(WIKI_EXCLUDE_DIRS);
    const at = strategy.insertionIndex(stage.args);
    return {
      command: stage.command,
      args: [...stage.args.slice(0, at), ...extra, ...stage.args.slice(at)],
    };
  });
}

export function serializeStages(stages: Stage[]): string {
  return stages.map((s) => s.args.map(shellEscape).join(' ')).join(' | ');
}

const FIND_PATTERN_FLAGS: ReadonlySet<string> = new Set([
  '-name',
  '-iname',
  '-path',
  '-ipath',
  '-regex',
  '-iregex',
  '-lname',
  '-ilname',
]);

const PATH_VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  find: new Set(['-newer', '-anewer', '-cnewer']),
  grep: new Set(['-f', '--file']),
  sort: new Set(['-o', '-T', '--output', '--temporary-directory']),
};

const VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  grep: new Set([
    '-m',
    '-A',
    '-B',
    '-C',
    '-e',
    '-f',
    '-d',
    '-D',
    '--regexp',
    '--file',
    '--max-count',
    '--after-context',
    '--before-context',
    '--context',
    '--include',
    '--exclude',
    '--exclude-dir',
  ]),
  uniq: new Set(['-f', '-s', '-w', '--skip-fields', '--skip-chars', '--check-chars']),
  sort: new Set(['-k', '-t', '-o', '-S', '-T', '--key', '--field-separator', '--output']),
  cut: new Set(['-d', '-f', '-b', '-c', '--delimiter', '--fields', '--bytes', '--characters']),
  head: new Set(['-n', '-c', '--lines', '--bytes']),
  tail: new Set(['-n', '-c', '--lines', '--bytes']),
  wc: new Set([]),
  find: new Set([
    ...FIND_PATTERN_FLAGS,
    '-newer',
    '-anewer',
    '-cnewer',
    '-type',
    '-maxdepth',
    '-mindepth',
    '-size',
    '-mtime',
    '-mmin',
    '-atime',
    '-amin',
    '-ctime',
    '-cmin',
    '-perm',
    '-links',
    '-inum',
    '-user',
    '-group',
  ]),
};

type ArgRole = 'command' | 'flag' | 'flag-value' | 'attached-value' | 'pattern' | 'path';

export interface ClassifiedArg {
  index: number;
  value: string;
  role: ArgRole;
  flag?: string;
}

function attachedValueOf(command: string, arg: string): { flag: string; value: string } | null {
  if (!arg.startsWith('-')) return null;
  const takesValue = VALUE_FLAGS[command] ?? new Set<string>();
  const eq = arg.indexOf('=');
  if (eq > 0) return { flag: arg.slice(0, eq), value: arg.slice(eq + 1) };
  if (arg.startsWith('--')) return null;
  for (let cut = arg.length - 1; cut >= 2; cut--) {
    const flag = arg.slice(0, cut);
    if (takesValue.has(flag)) return { flag, value: arg.slice(cut) };
  }
  return null;
}

export function attachedValueMayNamePath(command: string, flag: string): boolean {
  if (PATH_VALUE_FLAGS[command]?.has(flag) === true) return true;
  return VALUE_FLAGS[command]?.has(flag) !== true;
}

function suppliesPattern(command: string, flag: string): boolean {
  if (command === 'grep') return GREP_PATTERN_SUPPLIED_BY_FLAGS.has(flag);
  return false;
}

export function classifyArgs(stage: Stage): ClassifiedArg[] {
  const takesValue = VALUE_FLAGS[stage.command] ?? new Set<string>();
  const patternFlags =
    stage.command === 'find'
      ? FIND_PATTERN_FLAGS
      : stage.command === 'grep'
        ? GREP_GLOB_PROTECTED_FLAGS
        : new Set<string>();
  const out: ClassifiedArg[] = [{ index: 0, value: stage.args[0], role: 'command' }];
  let sawExplicitPattern = false;

  for (let i = 1; i < stage.args.length; i++) {
    const value = stage.args[i];
    if (value === '--') {
      out.push({ index: i, value, role: 'flag' });
      for (let j = i + 1; j < stage.args.length; j++) {
        out.push({ index: j, value: stage.args[j], role: 'path' });
      }
      break;
    }
    if (takesValue.has(value)) {
      out.push({ index: i, value, role: 'flag' });
      if (i + 1 < stage.args.length) {
        const isPattern = patternFlags.has(value);
        if (suppliesPattern(stage.command, value)) sawExplicitPattern = true;
        const namesPath = PATH_VALUE_FLAGS[stage.command]?.has(value) === true;
        out.push({
          index: i + 1,
          value: stage.args[i + 1],
          role: isPattern ? 'pattern' : namesPath ? 'path' : 'flag-value',
          flag: value,
        });
        i += 1;
      }
      continue;
    }
    const attached = attachedValueOf(stage.command, value);
    if (attached !== null) {
      if (suppliesPattern(stage.command, attached.flag)) sawExplicitPattern = true;
      out.push({ index: i, value: attached.value, role: 'attached-value', flag: attached.flag });
      continue;
    }
    if (value.startsWith('-') && value !== '-') {
      out.push({ index: i, value, role: 'flag' });
      continue;
    }
    out.push({ index: i, value, role: 'path' });
  }

  if (stage.command === 'grep' && !sawExplicitPattern) {
    const first = out.find((a) => a.role === 'path');
    if (first !== undefined) first.role = 'pattern';
  }
  return out;
}

const GREP_GLOB_PROTECTED_FLAGS: ReadonlySet<string> = new Set([
  '-e',
  '--regexp',
  '--include',
  '--exclude',
  '--exclude-dir',
]);
const GREP_PATTERN_SUPPLIED_BY_FLAGS: ReadonlySet<string> = new Set([
  '-e',
  '--regexp',
  '-f',
  '--file',
]);

const ALLOWLIST: ReadonlySet<string> = new Set([
  'cat',
  'ls',
  'grep',
  'find',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'cut',
]);

const ALLOWLIST_HINT = 'cat, ls, grep, find, head, tail, wc, sort, uniq, cut';

const WRITE_OPS: ReadonlySet<string> = new Set(['>', '>>']);

const REDIRECT_OPS: ReadonlySet<string> = new Set(['<', '<&', '<<<', '>&', '|&']);

const SHELL_CONSTRUCT_OPS: ReadonlySet<string> = new Set([
  '&',
  ';',
  ';;',
  '&&',
  '||',
  '(',
  ')',
  '<(',
  '>(',
  '<<',
  '<<-',
]);

const FIND_EXEC_DENY: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir']);

const SUSPICIOUS_STRING_RE = /[`]|\$\(|\$\{|\$'/;

type ShellOpToken = {
  op?: string;
  pattern?: string;
  comment?: string;
};
type ShellToken = string | ShellOpToken;

function isOpToken(token: unknown): token is ShellOpToken {
  return typeof token === 'object' && token !== null && 'op' in token;
}

function opTokenError(token: ShellOpToken): ParseCommandError {
  const op = typeof token.op === 'string' ? token.op : '(unknown)';
  if (WRITE_OPS.has(op)) {
    return {
      category: 'write_blocked',
      message: `Write operation blocked: '${op}'. exec is read-only. For document changes, use the \`write\` or \`edit\` tool.`,
    };
  }
  if (REDIRECT_OPS.has(op)) {
    return {
      category: 'shell_construct_blocked',
      message: `Redirection '${op}' is not available — exec runs ONE command or a pipe (|), not a shell. To read a file, pass it as an argument (\`cat notes.md\`). To change a document, use the \`write\` or \`edit\` tool.`,
    };
  }
  if (SHELL_CONSTRUCT_OPS.has(op)) {
    return {
      category: 'shell_construct_blocked',
      message: `Shell construct '${op}' is not supported — exec runs ONE command or a pipe (|), not a shell. Run separate exec calls, or pass multiple paths to one command (e.g. \`ls -A a b c\`, \`cat a b c\`).`,
    };
  }
  return {
    category: 'shell_construct_blocked',
    message: `Operator '${op}' is not supported.`,
  };
}

function buildStageArgs(
  tokens: ShellToken[],
): { args: string[]; globIndices: number[] } | { error: ParseCommandError } {
  const args: string[] = [];
  const globIndices: number[] = [];
  for (const token of tokens) {
    if (typeof token === 'string') {
      if (SUSPICIOUS_STRING_RE.test(token)) {
        return {
          error: {
            category: 'shell_construct_blocked',
            message: `Argument '${token}' contains a shell-injection pattern (backtick, $(), or \${}); not supported.`,
          },
        };
      }
      args.push(token);
      continue;
    }
    if (!isOpToken(token)) {
      return {
        error: { category: 'shell_construct_blocked', message: 'Unrecognized token shape.' },
      };
    }
    if (token.op === 'glob' && typeof token.pattern === 'string') {
      globIndices.push(args.length);
      args.push(token.pattern);
      continue;
    }
    if (typeof token.comment === 'string') {
      return {
        error: {
          category: 'shell_construct_blocked',
          message: 'Comments are not allowed in exec commands.',
        },
      };
    }
    return { error: opTokenError(token) };
  }
  return { args, globIndices };
}

export function checkStage(stage: Stage): ParseCommandError | null {
  if (!ALLOWLIST.has(stage.command)) {
    return {
      category: 'unknown_command',
      message: `Command '${stage.command}' is not in the allowlist. For pattern matching try 'grep'; for file listing try 'ls' or 'find'. Allowlist: ${ALLOWLIST_HINT}.`,
    };
  }
  for (const arg of stage.args.slice(1)) {
    if (stage.command === 'find' && FIND_EXEC_DENY.has(arg)) {
      return {
        category: 'shell_construct_blocked',
        message: `find flag '${arg}' is blocked (it runs another command). Use exec for read-only discovery; chain with another allowlisted tool via '|' if you need to transform output.`,
      };
    }
  }
  return null;
}

export function parseCommand(commandStr: string): ParseResult {
  const trimmed = commandStr.trim();
  if (!trimmed) {
    return {
      error: { category: 'unknown_command', message: 'Empty command.' },
    };
  }

  let ast: ShellToken[];
  try {
    ast = shellQuote.parse(trimmed) as ShellToken[];
  } catch {
    return {
      error: {
        category: 'shell_construct_blocked',
        message: 'Failed to parse command — likely malformed quoting or an unsupported construct.',
      },
    };
  }

  const stagesTokens: ShellToken[][] = [];
  let current: ShellToken[] = [];
  for (const token of ast) {
    if (isOpToken(token) && token.op === '|') {
      stagesTokens.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  stagesTokens.push(current);

  const stages: GlobStage[] = [];
  for (const tokens of stagesTokens) {
    const result = buildStageArgs(tokens);
    if ('error' in result) return result;
    if (result.args.length === 0) {
      return {
        error: {
          category: 'shell_construct_blocked',
          message: 'Empty pipeline stage (trailing pipe or leading pipe).',
        },
      };
    }
    const stage: GlobStage = {
      command: result.args[0],
      args: result.args,
      globArgIndices: result.globIndices,
    };
    const stageError = checkStage(stage);
    if (stageError) return { error: stageError };
    stages.push(stage);
  }

  return { stages };
}
