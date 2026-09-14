import { asRecord } from '@/lib/acp/mcp-input';

export interface ShellLine {
  readonly text: string;
  readonly continuation: boolean;
}

const PIPELINE_WRAP_THRESHOLD = 72;

const POSIX_SHELL = /^(?:\/bin\/|\/usr\/bin\/|\/usr\/local\/bin\/)?(?:ba|da|z)?sh$/;

const PLAIN_ARGUMENT = /^[\w@%+=:,./-]+$/;

const BLANK_ROW = /^[ \t]*$/;

const HAS_TEXT = /[^ \t\n]/;

const EDGE_BLANKS = /^[ \t]+|[ \t]+$/g;

const HIDDEN_CHARACTER = /(?![\t\n])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const WORD_BOUNDARY = /[ \t;&|()<>]/;

interface ScanState {
  quote: "'" | '"' | null;
  depth: number;
  braces: number;
  backtick: boolean;
  comment: boolean;
  escaped: boolean;
}

function advance(state: ScanState, char: string, previous: string | undefined): void {
  if (state.comment) return;
  if (state.escaped) {
    state.escaped = false;
    return;
  }
  if (char === '\\' && state.quote !== "'") {
    state.escaped = true;
    return;
  }
  if (state.quote !== null) {
    if (char === state.quote) state.quote = null;
    return;
  }
  if (char === "'" || char === '"') {
    state.quote = char;
    return;
  }
  if (
    splittable(state) &&
    char === '#' &&
    (previous === undefined || WORD_BOUNDARY.test(previous))
  ) {
    state.comment = true;
    return;
  }
  if (char === '`') state.backtick = !state.backtick;
  else if (char === '(') state.depth += 1;
  else if (char === ')') state.depth = Math.max(0, state.depth - 1);
  else if (char === '{' && previous === '$') state.braces += 1;
  else if (char === '}' && state.braces > 0) state.braces -= 1;
}

function splittable(state: ScanState): boolean {
  return (
    state.quote === null &&
    state.depth === 0 &&
    state.braces === 0 &&
    !state.backtick &&
    !state.comment &&
    !state.escaped
  );
}

export function formatShellCommand(command: string): ShellLine[] {
  const rows = command.split('\n');
  while (rows.length > 0 && BLANK_ROW.test(rows[0] ?? '')) rows.shift();
  while (rows.length > 0 && BLANK_ROW.test(rows[rows.length - 1] ?? '')) rows.pop();
  if (rows.length === 1) return reflowStatements(rows[0] ?? '');
  return rows.map((text) => ({ text, continuation: false }));
}

function reflowStatements(command: string): ShellLine[] {
  const lines: ShellLine[] = [];
  const state: ScanState = {
    quote: null,
    depth: 0,
    braces: 0,
    backtick: false,
    comment: false,
    escaped: false,
  };
  let buffer = '';
  let pendingContinuation = false;

  const flush = (continuation: boolean): void => {
    const text = buffer.replace(EDGE_BLANKS, '');
    buffer = '';
    if (text === '') return;
    lines.push({ text, continuation });
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string;
    const next = command[index + 1];

    if (splittable(state) && (char === '&' || char === '|') && next === char) {
      buffer += char + next;
      index += 1;
      flush(pendingContinuation);
      pendingContinuation = false;
      continue;
    }

    if (splittable(state) && char === ';') {
      buffer += char;
      flush(pendingContinuation);
      pendingContinuation = false;
      continue;
    }

    if (
      splittable(state) &&
      char === '|' &&
      next !== '|' &&
      buffer.length >= PIPELINE_WRAP_THRESHOLD
    ) {
      buffer += char;
      flush(pendingContinuation);
      pendingContinuation = true;
      continue;
    }

    buffer += char;
    advance(state, char, command[index - 1]);
  }
  flush(pendingContinuation);
  return lines;
}

export function revealHiddenCharacters(text: string): string {
  return text.replace(
    HIDDEN_CHARACTER,
    (char) => `⟨U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟩`,
  );
}

export function shellCommandFromRawInput(rawInput: unknown): string | null {
  const value = asRecord(rawInput).command;
  const command = Array.isArray(value) ? commandFromArgv(value) : value;
  return typeof command === 'string' && HAS_TEXT.test(command) ? command : null;
}

function commandFromArgv(argv: readonly unknown[]): string | null {
  if (argv.length === 0 || !argv.every((part): part is string => typeof part === 'string')) {
    return null;
  }
  const [shell = '', flag, script = ''] = argv;
  if (argv.length === 3 && POSIX_SHELL.test(shell) && (flag === '-c' || flag === '-lc')) {
    return script;
  }
  return argv.map(quoteArgument).join(' ');
}

function quoteArgument(argument: string): string {
  return PLAIN_ARGUMENT.test(argument) ? argument : `'${argument.replaceAll("'", `'\\''`)}'`;
}
