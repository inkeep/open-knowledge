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

const DOUBLE_QUOTE_ESCAPABLE: ReadonlySet<string> = new Set(['$', '`', '"', '\\', '\n']);

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

const REDIRECT_TARGET_ENDS: ReadonlySet<string> = new Set([
  ' ',
  '\t',
  '\n',
  ';',
  '|',
  '&',
  '<',
  '>',
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
  '--output',
  '--textconv',
]);

const GIT_ABBREVIABLE_REJECTS: ReadonlyMap<
  string,
  readonly (readonly [option: string, shortest: string])[]
> = new Map([
  [
    'cat-file',
    [
      ['--filters', '--f'],
      ['--textconv', '--t'],
    ],
  ],
  [
    'grep',
    [
      ['--open-files-in-pager', '--o'],
      ['--textconv', '--textc'],
    ],
  ],
]);

const GIT_FORMAT_OPTIONS = ['--format', '--group', '--pretty', '--sort'];

const SIGNATURE_CHECK_FORMAT = /signature|%[-+ ]?G/;

const GIT_REJECTED_PREFIXES = ['--output='];

const GIT_BRANCH_LISTING_OPTIONS: ReadonlySet<string> = new Set([
  '--abbrev',
  '--all',
  '--color',
  '--column',
  '--contains',
  '--format',
  '--ignore-case',
  '--list',
  '--merged',
  '--no-abbrev',
  '--no-color',
  '--no-column',
  '--no-contains',
  '--no-merged',
  '--points-at',
  '--remotes',
  '--show-current',
  '--sort',
  '--verbose',
]);

const GIT_BRANCH_LISTING_LETTERS = 'arvli';

const GIT_TAG_LISTING_OPTIONS: ReadonlySet<string> = new Set([
  '--color',
  '--column',
  '--contains',
  '--format',
  '--ignore-case',
  '--list',
  '--merged',
  '--no-color',
  '--no-column',
  '--no-contains',
  '--no-merged',
  '--points-at',
  '--sort',
]);

const GIT_TAG_LISTING_LETTERS = 'lni0123456789';

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
  let plain = true;
  let inWord = false;
  let quote: '"' | "'" | null = null;
  let redirectTarget = false;
  let invalidRedirect = false;
  const append = (part: string, isLiteral: boolean): void => {
    text += part;
    inWord = true;
    if (!isLiteral) literal = false;
  };
  const endWord = (): void => {
    if (!inWord) return;
    if (redirectTarget) {
      redirectTarget = false;
      if (!literal) invalidRedirect = true;
    } else {
      words.push({ text, literal });
    }
    text = '';
    literal = true;
    plain = true;
    inWord = false;
  };
  const endStatement = (): void => {
    endWord();
    if (redirectTarget) invalidRedirect = true;
    if (words.length > 0) statements.push(words);
    words = [];
  };
  const dropFdPrefix = (): boolean => {
    if (inWord && literal && plain && FD_DIGITS.test(text)) {
      if (text.length > 1) return false;
      text = '';
      inWord = false;
      return true;
    }
    endWord();
    return true;
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
      if (c === '\\' && next !== undefined && DOUBLE_QUOTE_ESCAPABLE.has(next)) {
        if (next !== '\n') append(next, true);
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
      plain = false;
      i += 1;
      continue;
    }
    if (c === '\\') {
      if (next === undefined) return null;
      if (next !== '\n') {
        append(next, true);
        plain = false;
      }
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
      return null;
    }
    if (c === '>') {
      if (!dropFdPrefix() || redirectTarget) return null;
      if (next === '&') {
        const after = readFdDuplicate(chars, i + 2);
        if (after === null) return null;
        i = after;
        continue;
      }
      let j = i + 1;
      if (chars[j] === '>' || chars[j] === '|') j += 1;
      const after = readDevNullTarget(chars, j);
      if (after === null) return null;
      i = after;
      continue;
    }
    if (c === '<') {
      if (next === '<' || next === '(' || next === '&' || next === '>') return null;
      if (!dropFdPrefix() || redirectTarget) return null;
      redirectTarget = true;
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
  return invalidRedirect ? null : statements;
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

function endsRedirectTarget(chars: readonly string[], index: number): boolean {
  const next = chars[index];
  return next === undefined || REDIRECT_TARGET_ENDS.has(next);
}

function readFdDuplicate(chars: readonly string[], start: number): number | null {
  const target = chars[start] ?? '';
  if (target !== '-' && !FD_DIGITS.test(target)) return null;
  return endsRedirectTarget(chars, start + 1) ? start + 1 : null;
}

function readDevNullTarget(chars: readonly string[], start: number): number | null {
  let i = start;
  while (chars[i] === ' ' || chars[i] === '\t') i += 1;
  let target = '';
  while (i < chars.length && !WORD_TERMINATORS.has(chars[i] ?? '')) {
    target += chars[i];
    i += 1;
  }
  return target === DEV_NULL && endsRedirectTarget(chars, i) ? i : null;
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
  const policy = RESTRICTED_PROGRAMS.get(program);
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

function abbreviates(arg: string, option: string, shortest: string): boolean {
  if (!arg.startsWith('--')) return false;
  const name = optionName(arg);
  return name.startsWith(shortest) && option.startsWith(name);
}

function requestsSignatureCheck(args: readonly string[]): boolean {
  return args.some((arg, index) => {
    if (arg === '--show-signature') return true;
    if (!GIT_FORMAT_OPTIONS.some((option) => abbreviates(arg, option, option.slice(0, 3)))) {
      return false;
    }
    const name = optionName(arg);
    const value = name === arg ? (args[index + 1] ?? '') : arg.slice(name.length + 1);
    return SIGNATURE_CHECK_FORMAT.test(value);
  });
}

function isListingOption(
  arg: string,
  longOptions: ReadonlySet<string>,
  shortLetters: string,
): boolean {
  if (arg.startsWith('--')) return longOptions.has(optionName(arg));
  if (!arg.startsWith('-') || arg.length < 2) return false;
  return Array.from(arg.slice(1)).every((letter) => shortLetters.includes(letter));
}

const RESTRICTED_PROGRAMS: ReadonlyMap<string, ArgumentPolicy> = new Map<string, ArgumentPolicy>([
  ['command', (args) => (args[0] === '-v' || args[0] === '-V') && args.length > 1],
  ['curl', isReadOnlyCurl],
  [
    'date',
    (args) => !args.some((arg) => abbreviates(arg, '--set', '--s') || shortClusterHas(arg, 's')),
  ],
  ['find', (args) => !args.some((arg) => FIND_MUTATORS.has(arg))],
  ['git', isReadOnlyGit],
  ['hostname', (args) => args.every((arg) => HOSTNAME_FLAGS.has(arg))],
  [
    'sort',
    (args) =>
      !args.some(
        (arg) =>
          abbreviates(arg, '--output', '--o') ||
          abbreviates(arg, '--temporary-directory', '--t') ||
          abbreviates(arg, '--compress-program', '--c') ||
          shortClusterHas(arg, 'oT'),
      ),
  ],
  ['tree', (args) => !args.some((arg) => shortClusterHas(arg, 'o'))],
  ['uniq', (args) => args.filter(isOperand).length <= 1],
]);

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
  const abbreviableRejects = GIT_ABBREVIABLE_REJECTS.get(subcommand) ?? [];
  if (
    requestsSignatureCheck(rest) ||
    rest.some(
      (arg) =>
        GIT_REJECTED_ARGUMENTS.has(arg) ||
        GIT_REJECTED_PREFIXES.some((prefix) => arg.startsWith(prefix)) ||
        abbreviableRejects.some(([option, shortest]) => abbreviates(arg, option, shortest)) ||
        shortClusterHas(arg, 'O'),
    )
  ) {
    return false;
  }
  if (GIT_READ_SUBCOMMANDS.has(subcommand)) return true;
  switch (subcommand) {
    case 'branch':
      return rest.every((arg) =>
        isListingOption(arg, GIT_BRANCH_LISTING_OPTIONS, GIT_BRANCH_LISTING_LETTERS),
      );
    case 'tag':
      return rest.every((arg) =>
        isListingOption(arg, GIT_TAG_LISTING_OPTIONS, GIT_TAG_LISTING_LETTERS),
      );
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
