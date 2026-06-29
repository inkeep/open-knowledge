
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

interface ParseCommandError {
  category: ErrorCategory;
  message: string;
}

export interface Stage {
  command: string;
  args: string[];
}

type ParseResult = { stages: Stage[] } | { error: ParseCommandError };

const WIKI_EXCLUDE_DIRS: readonly string[] = [
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

function isRecursiveGrepFlag(arg: string): boolean {
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

const WRITE_OPS: ReadonlySet<string> = new Set(['>', '>>', '<', '>&', '<&', '|&']);

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

const UNIVERSAL_FLAG_DENY: ReadonlySet<string> = new Set(['-o', '--output-file', '--output']);
const UNIVERSAL_FLAG_PREFIX_DENY = ['-o=', '--output-file=', '--output='];

const FIND_FLAG_DENY: ReadonlySet<string> = new Set([
  '-exec',
  '-execdir',
  '-delete',
  '-fprint',
  '-fprintf',
  '-fprint0',
  '-ok',
  '-okdir',
]);

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

function buildStageArgs(tokens: ShellToken[]): { args: string[] } | { error: ParseCommandError } {
  const args: string[] = [];
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
  return { args };
}

function checkStage(stage: Stage): ParseCommandError | null {
  if (!ALLOWLIST.has(stage.command)) {
    return {
      category: 'unknown_command',
      message: `Command '${stage.command}' is not in the allowlist. For pattern matching try 'grep'; for file listing try 'ls' or 'find'. Allowlist: ${ALLOWLIST_HINT}.`,
    };
  }
  for (const arg of stage.args.slice(1)) {
    if (UNIVERSAL_FLAG_DENY.has(arg) || UNIVERSAL_FLAG_PREFIX_DENY.some((p) => arg.startsWith(p))) {
      return {
        category: 'write_blocked',
        message: `Write operation blocked: '${arg}'. exec is read-only. For document changes, use the \`write\` or \`edit\` tool.`,
      };
    }
    if (stage.command === 'find' && FIND_FLAG_DENY.has(arg)) {
      return {
        category: 'write_blocked',
        message: `find flag '${arg}' is blocked (executes commands or deletes files). Use exec for read-only discovery; chain with another allowlisted tool via '|' if you need to transform output.`,
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

  const stages: Stage[] = [];
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
    const stage: Stage = { command: result.args[0], args: result.args };
    const stageError = checkStage(stage);
    if (stageError) return { error: stageError };
    stages.push(stage);
  }

  return { stages };
}
