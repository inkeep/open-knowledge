import type { ToolCallUpdate } from '@agentclientprotocol/sdk';
import { shellCommandFromRawInput } from '@inkeep/open-knowledge-core/acp/tool-call-input';

interface Word {
  readonly text: string;
  readonly literal: boolean;
}

type ArgumentPolicy = (args: readonly string[]) => boolean;

const READ_ONLY_WITH_ANY_ARGUMENTS: ReadonlySet<string> = new Set([
  '[',
  'basename',
  'cat',
  'cd',
  'cmp',
  'column',
  'comm',
  'cut',
  'df',
  'diff',
  'dirname',
  'du',
  'echo',
  'egrep',
  'expr',
  'false',
  'fgrep',
  'fold',
  'grep',
  'head',
  'hexdump',
  'id',
  'jq',
  'ls',
  'lsof',
  'md5',
  'md5sum',
  'netstat',
  'nl',
  'od',
  'pgrep',
  'printf',
  'ps',
  'pwd',
  'readlink',
  'realpath',
  'rev',
  'seq',
  'sha1sum',
  'sha256sum',
  'shasum',
  'stat',
  'strings',
  'tac',
  'tail',
  'test',
  'tr',
  'true',
  'type',
  'uname',
  'uptime',
  'wc',
  'whereis',
  'which',
  'whoami',
]);

const PROGRAM_DIRS = ['/bin/', '/usr/bin/', '/usr/local/bin/', '/opt/homebrew/bin/'];

const HARMLESS_ASSIGNMENT = /^(?:LC_[A-Z]+|LANG|TZ|NO_COLOR|COLUMNS|LINES)=/;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const PARAMETER_START = /[A-Za-z_]/;

const PARAMETER_CHAR = /[A-Za-z0-9_]/;

const SPECIAL_PARAMETER = /[@*#?\-$!0-9]/;

const NUMBER = /^[0-9]+(?:\.[0-9]+)?$/;

const HTTP_URL = /^https?:\/\/\S+$/;

const FD_DIGITS = /^[0-9]+$/;

const DEV_NULL = '/dev/null';

const WORD_TERMINATORS: ReadonlySet<string> = new Set([
  ' ',
  '\t',
  '\n',
  ';',
  '|',
  '&',
  '<',
  '>',
  '(',
  ')',
  '`',
  '"',
  "'",
]);

const FIND_MUTATORS: ReadonlySet<string> = new Set([
  '-delete',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
]);

const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'blame',
  'cat-file',
  'check-ignore',
  'count-objects',
  'describe',
  'diff',
  'diff-tree',
  'for-each-ref',
  'grep',
  'log',
  'ls-files',
  'ls-tree',
  'merge-base',
  'name-rev',
  'rev-list',
  'rev-parse',
  'shortlog',
  'show',
  'status',
  'var',
  'version',
]);

const GIT_REJECTED_ARGUMENTS: ReadonlySet<string> = new Set([
  '--ext-diff',
  '--open-files-in-pager',
  '--output',
  '--show-signature',
  '--textconv',
]);

const GIT_REJECTED_PREFIXES = ['--output=', '--open-files-in-pager='];

const GIT_BRANCH_MUTATORS: ReadonlySet<string> = new Set([
  '-c',
  '-C',
  '-d',
  '-D',
  '-f',
  '-m',
  '-M',
  '-u',
  '--copy',
  '--delete',
  '--edit-description',
  '--force',
  '--move',
  '--set-upstream-to',
  '--track',
  '--no-track',
  '--unset-upstream',
]);

const GIT_TAG_MUTATORS: ReadonlySet<string> = new Set([
  '-a',
  '-d',
  '-f',
  '-F',
  '-m',
  '-s',
  '-u',
  '--delete',
  '--force',
]);

const HOSTNAME_FLAGS: ReadonlySet<string> = new Set([
  '-A',
  '-d',
  '-f',
  '-i',
  '-I',
  '-s',
  '--all-ip-addresses',
  '--domain',
  '--fqdn',
  '--ip-address',
  '--short',
]);

const CURL_FLAGS: ReadonlySet<string> = new Set([
  '-4',
  '-6',
  '-f',
  '-g',
  '-I',
  '-i',
  '-k',
  '-L',
  '-N',
  '-q',
  '-S',
  '-s',
  '-v',
  '--compressed',
  '--disable',
  '--fail',
  '--fail-with-body',
  '--globoff',
  '--head',
  '--http1.1',
  '--http2',
  '--include',
  '--insecure',
  '--ipv4',
  '--ipv6',
  '--location',
  '--no-buffer',
  '--no-keepalive',
  '--no-progress-meter',
  '--show-error',
  '--silent',
  '--verbose',
]);

const isNumber = (value: string): boolean => NUMBER.test(value);
const isNotFileReference = (value: string): boolean => !value.startsWith('@');
const isWriteOutFormat = (value: string): boolean =>
  isNotFileReference(value) && !/%output\{/i.test(value);
const isDevNull = (value: string): boolean => value === DEV_NULL;
const isHttpUrl = (value: string): boolean => HTTP_URL.test(value);
const anyValue = (): boolean => true;

const CURL_VALUE_OPTIONS: Readonly<Record<string, (value: string) => boolean>> = {
  '-A': isNotFileReference,
  '--user-agent': isNotFileReference,
  '-e': isNotFileReference,
  '--referer': isNotFileReference,
  '-H': isNotFileReference,
  '--header': isNotFileReference,
  '-m': isNumber,
  '--max-time': isNumber,
  '--connect-timeout': isNumber,
  '--max-filesize': isNumber,
  '--max-redirs': isNumber,
  '--retry': isNumber,
  '--retry-delay': isNumber,
  '--retry-max-time': isNumber,
  '-o': isDevNull,
  '--output': isDevNull,
  '-r': anyValue,
  '--range': anyValue,
  '--resolve': anyValue,
  '-x': anyValue,
  '--proxy': anyValue,
  '-w': isWriteOutFormat,
  '--write-out': isWriteOutFormat,
  '--url': isHttpUrl,
};

export function readOnlyShellCommand(toolCall: ToolCallUpdate): string | null {
  if ((toolCall.kind ?? 'other') !== 'execute') return null;
  const command = shellCommandFromRawInput(toolCall.rawInput);
  return command !== null && isReadOnlyShellCommand(command) ? command : null;
}

export function isReadOnlyShellCommand(command: string): boolean {
  const statements = splitStatements(command);
  return statements !== null && statements.length > 0 && statements.every(isReadOnlySimpleCommand);
}

function splitStatements(command: string): Word[][] | null {
  const chars = Array.from(command);
  const statements: Word[][] = [];
  let words: Word[] = [];
  let text = '';
  let literal = true;
  let inWord = false;
  let quote: '"' | "'" | null = null;
  const append = (part: string, isLiteral: boolean): void => {
    text += part;
    inWord = true;
    if (!isLiteral) literal = false;
  };
  const endWord = (): void => {
    if (!inWord) return;
    words.push({ text, literal });
    text = '';
    literal = true;
    inWord = false;
  };
  const endStatement = (): void => {
    endWord();
    if (words.length > 0) statements.push(words);
    words = [];
  };
  const dropFdPrefix = (): void => {
    if (inWord && literal && FD_DIGITS.test(text)) {
      text = '';
      inWord = false;
    } else {
      endWord();
    }
  };
  let i = 0;
  while (i < chars.length) {
    const c = chars[i] ?? '';
    const next = chars[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null;
      else append(c, true);
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (c === '"') {
        quote = null;
        i += 1;
        continue;
      }
      if (c === '`') return null;
      if (c === '$') {
        const after = readParameter(chars, i, append);
        if (after === null) return null;
        i = after;
        continue;
      }
      if (c === '\\' && next !== undefined) {
        append(next, true);
        i += 2;
        continue;
      }
      append(c, true);
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      i += 1;
      continue;
    }
    if (c === '\\') {
      if (next === undefined) return null;
      if (next !== '\n') append(next, true);
      i += 2;
      continue;
    }
    if (c === '#' && !inWord) {
      while (i < chars.length && chars[i] !== '\n') i += 1;
      continue;
    }
    if (c === '`' || c === '(' || c === ')') return null;
    if (c === '$') {
      const after = readParameter(chars, i, append);
      if (after === null) return null;
      i = after;
      continue;
    }
    if (c === '*' || c === '?' || c === '[' || c === '{' || c === '}' || (c === '~' && !inWord)) {
      append(c, false);
      i += 1;
      continue;
    }
    if (c === '\n' || c === ';') {
      endStatement();
      i += 1;
      continue;
    }
    if (c === '|') {
      endStatement();
      i += next === '|' || next === '&' ? 2 : 1;
      continue;
    }
    if (c === '&') {
      if (next === '&') {
        endStatement();
        i += 2;
        continue;
      }
      if (next === '>') {
        endWord();
        const after = readDevNullTarget(chars, i + 2);
        if (after === null) return null;
        i = after;
        continue;
      }
      return null;
    }
    if (c === '>') {
      dropFdPrefix();
      let j = i + 1;
      if (chars[j] === '>' || chars[j] === '|') j += 1;
      if (chars[j] === '&') {
        const after = readFdDuplicate(chars, j + 1);
        if (after === null) return null;
        i = after;
        continue;
      }
      const after = readDevNullTarget(chars, j);
      if (after === null) return null;
      i = after;
      continue;
    }
    if (c === '<') {
      if (next === '<' || next === '(' || next === '&') return null;
      dropFdPrefix();
      i += 1;
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      i += 1;
      continue;
    }
    append(c, true);
    i += 1;
  }
  if (quote !== null) return null;
  endStatement();
  return statements;
}

function readParameter(
  chars: readonly string[],
  start: number,
  append: (part: string, isLiteral: boolean) => void,
): number | null {
  const next = chars[start + 1];
  if (next === undefined) {
    append('$', false);
    return start + 1;
  }
  if (next === '(' || next === '[' || next === "'" || next === '"') return null;
  if (next === '{') {
    let j = start + 2;
    let name = '';
    while (j < chars.length && chars[j] !== '}') {
      name += chars[j];
      j += 1;
    }
    if (chars[j] !== '}' || !PARAMETER_NAME.test(name)) return null;
    append(`\${${name}}`, false);
    return j + 1;
  }
  if (PARAMETER_START.test(next)) {
    let j = start + 1;
    let name = '';
    while (j < chars.length && PARAMETER_CHAR.test(chars[j] ?? '')) {
      name += chars[j];
      j += 1;
    }
    append(`$${name}`, false);
    return j;
  }
  if (SPECIAL_PARAMETER.test(next)) {
    append(`$${next}`, false);
    return start + 2;
  }
  append('$', false);
  return start + 1;
}

function readFdDuplicate(chars: readonly string[], start: number): number | null {
  if (chars[start] === '-') return start + 1;
  let i = start;
  while (i < chars.length && FD_DIGITS.test(chars[i] ?? '')) i += 1;
  return i === start ? null : i;
}

function readDevNullTarget(chars: readonly string[], start: number): number | null {
  let i = start;
  while (chars[i] === ' ' || chars[i] === '\t') i += 1;
  let target = '';
  while (i < chars.length && !WORD_TERMINATORS.has(chars[i] ?? '')) {
    target += chars[i];
    i += 1;
  }
  return target === DEV_NULL ? i : null;
}

function isReadOnlySimpleCommand(statement: readonly Word[]): boolean {
  let words = statement;
  while (words.length > 0 && ASSIGNMENT.test(words[0]?.text ?? '')) {
    if (!HARMLESS_ASSIGNMENT.test(words[0]?.text ?? '')) return false;
    words = words.slice(1);
  }
  if (words[0]?.text === '!') words = words.slice(1);
  const head = words[0];
  if (head === undefined) return true;
  if (words.some((word) => word.text === '{' || word.text === '}')) return false;
  if (!head.literal) return false;
  const program = programName(head.text);
  if (program === null) return false;
  if (READ_ONLY_WITH_ANY_ARGUMENTS.has(program)) return true;
  const policy = RESTRICTED_PROGRAMS[program];
  if (policy === undefined) return false;
  const args = words.slice(1);
  if (!args.every((word) => word.literal)) return false;
  return policy(args.map((word) => word.text));
}

function programName(word: string): string | null {
  if (!word.includes('/')) return word;
  const dir = PROGRAM_DIRS.find((candidate) => word.startsWith(candidate));
  if (dir === undefined) return null;
  const name = word.slice(dir.length);
  return name.includes('/') || name === '' ? null : name;
}

function shortClusterHas(arg: string, letters: string): boolean {
  if (!arg.startsWith('-') || arg.startsWith('--') || arg.length < 2) return false;
  return Array.from(arg.slice(1)).some((letter) => letters.includes(letter));
}

function isOperand(arg: string): boolean {
  return arg === '-' || !arg.startsWith('-');
}

function optionName(arg: string): string {
  return arg.split('=', 1)[0] ?? arg;
}

const RESTRICTED_PROGRAMS: Readonly<Record<string, ArgumentPolicy>> = {
  command: (args) => (args[0] === '-v' || args[0] === '-V') && args.length > 1,
  curl: isReadOnlyCurl,
  date: (args) => !args.some((arg) => arg.startsWith('--set') || shortClusterHas(arg, 's')),
  find: (args) => !args.some((arg) => FIND_MUTATORS.has(arg)),
  git: isReadOnlyGit,
  hostname: (args) => args.every((arg) => HOSTNAME_FLAGS.has(arg)),
  sort: (args) =>
    !args.some(
      (arg) =>
        arg.startsWith('--output') ||
        arg.startsWith('--temporary-directory') ||
        arg.startsWith('--compress-program') ||
        shortClusterHas(arg, 'oT'),
    ),
  tree: (args) => !args.some((arg) => shortClusterHas(arg, 'o')),
  uniq: (args) => args.filter(isOperand).length <= 1,
};

function isReadOnlyGit(args: readonly string[]): boolean {
  let i = 0;
  while (i < args.length && (args[i] ?? '').startsWith('-')) {
    const option = args[i];
    if (option === '--no-pager' || option === '-P') {
      i += 1;
      continue;
    }
    if (option === '-C' && args[i + 1] !== undefined) {
      i += 2;
      continue;
    }
    return false;
  }
  const subcommand = args[i];
  if (subcommand === undefined) return false;
  const rest = args.slice(i + 1);
  if (
    rest.some(
      (arg) =>
        GIT_REJECTED_ARGUMENTS.has(arg) ||
        GIT_REJECTED_PREFIXES.some((prefix) => arg.startsWith(prefix)) ||
        shortClusterHas(arg, 'O'),
    )
  ) {
    return false;
  }
  if (GIT_READ_SUBCOMMANDS.has(subcommand)) return true;
  switch (subcommand) {
    case 'branch':
      return rest.every((arg) => arg.startsWith('-') && !GIT_BRANCH_MUTATORS.has(optionName(arg)));
    case 'tag':
      return rest.every((arg) => arg.startsWith('-') && !GIT_TAG_MUTATORS.has(optionName(arg)));
    case 'remote':
      return (
        rest.every((arg) => arg === '-v' || arg === '--verbose') ||
        rest[0] === 'show' ||
        rest[0] === 'get-url'
      );
    case 'stash':
      return rest[0] === 'list' || rest[0] === 'show';
    case 'worktree':
      return rest[0] === 'list';
    case 'reflog':
      return rest.length === 0 || rest[0] === 'show';
    case 'config':
      return ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(rest[0] ?? '');
    default:
      return false;
  }
}

function isReadOnlyCurl(args: readonly string[]): boolean {
  let sawUrl = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg.startsWith('--')) {
      const separator = arg.indexOf('=');
      const name = separator === -1 ? arg : arg.slice(0, separator);
      const inlineValue = separator === -1 ? null : arg.slice(separator + 1);
      if (CURL_FLAGS.has(name)) {
        if (inlineValue !== null) return false;
        continue;
      }
      const accepts = CURL_VALUE_OPTIONS[name];
      if (accepts === undefined) return false;
      let value = inlineValue;
      if (value === null) {
        i += 1;
        value = args[i] ?? null;
      }
      if (value === null || !accepts(value)) return false;
      if (name === '--url') sawUrl = true;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const letters = Array.from(arg.slice(1));
      for (const [index, letter] of letters.entries()) {
        const flag = `-${letter}`;
        if (CURL_FLAGS.has(flag)) continue;
        const accepts = CURL_VALUE_OPTIONS[flag];
        if (accepts === undefined) return false;
        const attached = letters.slice(index + 1).join('');
        let value: string | null = attached !== '' ? attached : null;
        if (value === null) {
          i += 1;
          value = args[i] ?? null;
        }
        if (value === null || !accepts(value)) return false;
        break;
      }
      continue;
    }
    if (!HTTP_URL.test(arg)) return false;
    sawUrl = true;
  }
  return sawUrl;
}
