/**
 * `parseCommand` — the sole primary security boundary for `exec`.
 *
 * Uses `shell-quote` to tokenize the user-supplied command string, then
 * walks the resulting AST and rejects anything not structurally allowed.
 * A post-exec mtime-scan backstop is the defense-in-depth layer
 * for any bug that slips past this parser.
 *
 * Three layers of validation:
 *   1. AST-level op denylist — only `|` is allowed; every other operator
 *      (redirection, sequencing, backgrounding, subshell) rejects with a
 *      categorized error.
 *   2. First-token allowlist per pipeline stage — Conservative-plus set:
 *      cat, ls, grep, find, head, tail, wc, sort, uniq, cut.
 *      awk/sed/xargs explicitly excluded (program-arg write vectors).
 *   3. Argument-level flag denylist — universal `-o` / `--output-file` /
 *      `--output`, plus find-specific `-exec`/`-execdir`/`-delete`/etc.
 *   4. String-token scan — arguments containing backticks, `$(`, or `${`
 *      are treated as shell-construct-blocked (injection vectors that
 *      shell-quote may not split but that just-bash could interpret).
 *
 * Error messages are category-specific so agents receive an actionable
 * next-step, not a wall of allowlist text.
 */

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
  /** First token — the allowlisted command. */
  command: string;
  /** All tokens including the command itself. */
  args: string[];
}

type ParseResult = { stages: Stage[] } | { error: ParseCommandError };

/**
 * Dirs that are never wiki content. Auto-injected on recursive `grep` (as
 * `--exclude-dir=`) and on `find` (as `-not -path "/X/"` glob) so agents don't
 * wait 20s scanning `node_modules/` etc. Users can opt out by passing their
 * own `--exclude-dir` / `-not -path`.
 */
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
  // Worktree snapshots + plugin cache duplicate the main repo's content,
  // producing N× hits for any search. Never wiki content.
  '.claude',
];

/**
 * Per-command strategy for auto-injecting ignored-dir filters so agents don't
 * waste time walking `node_modules/`, `.git/`, build dirs, etc. Strategies
 * follow a common shape:
 *   - `applies`   — stage should be augmented (command matches + recurses)
 *   - `hasUserExcludes` — user already passed their own excludes; skip injection
 *   - `buildExcludeArgs` — the tokens to splice in
 *   - `insertionIndex` — where in stage.args to splice
 */
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
  // Right after the command token so excludes appear before pattern/paths.
  insertionIndex: () => 1,
};

const FIND_STRATEGY: ExcludeStrategy = {
  command: 'find',
  // `find` is always recursive — augment unconditionally.
  applies: () => true,
  // Respect user's own filtering. Only `-not` / `!` / `-prune` unambiguously
  // signal the user is managing exclusions — bare `-path` is also used for
  // inclusion patterns (e.g. `find . -path "docs/*.md"`), so matching on it
  // would wrongly disable injection for include-style commands.
  hasUserExcludes: (args) => args.slice(1).some((a) => a === '-not' || a === '!' || a === '-prune'),
  buildExcludeArgs: (dirs) => {
    const out: string[] = [];
    for (const d of dirs) {
      out.push('-not', '-path', `*/${d}/*`);
    }
    return out;
  },
  // Splice before the first expression primary (first arg starting with `-`),
  // so `find . -name X` becomes `find . -not -path ... -name X`. If no path
  // arg exists (`find -name X`), splice right after `find`.
  insertionIndex: (args) => {
    for (let i = 1; i < args.length; i++) {
      if (args[i].startsWith('-')) return i;
    }
    return args.length;
  },
};

const STRATEGIES: readonly ExcludeStrategy[] = [GREP_STRATEGY, FIND_STRATEGY];

/**
 * Inject `WIKI_EXCLUDE_DIRS` filters into any stage whose command has a
 * matching strategy. Returns a new stage array — original is not mutated.
 */
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

/** Serialize stages back to a pipeline command string for execBash. */
export function serializeStages(stages: Stage[]): string {
  return stages.map((s) => s.args.map(shellEscape).join(' ')).join(' | ');
}

// Conservative-plus allowlist.
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

// Redirections (write to file/fd) — write_blocked.
const WRITE_OPS: ReadonlySet<string> = new Set(['>', '>>', '<', '>&', '<&', '|&']);

// Shell constructs (sequencing, subshell, background, heredoc) — shell_construct_blocked.
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

// Flags that write to file on any command.
const UNIVERSAL_FLAG_DENY: ReadonlySet<string> = new Set(['-o', '--output-file', '--output']);
const UNIVERSAL_FLAG_PREFIX_DENY = ['-o=', '--output-file=', '--output='];

// find-specific flags that execute arbitrary commands or delete files.
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

// Injection vectors that may survive shell-quote.parse: backticks, command
// substitution `$(...)`, variable expansion `${...}`, and ANSI-C quoting
// `$'...'` (which bash evaluates escape sequences in, distinct from plain
// single-quoted strings).
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
    // Glob tokens {op:'glob', pattern:'*.md'} pass through as args — just-bash
    // expands them inside the sandbox.
    if (token.op === 'glob' && typeof token.pattern === 'string') {
      args.push(token.pattern);
      continue;
    }
    // Comments shouldn't appear in an `exec` command; reject.
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

/**
 * Validate a command string and return a parsed pipeline structure, or a
 * categorized error. Does NOT execute anything.
 */
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

  // Split into pipeline stages at `{ op: '|' }`.
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
