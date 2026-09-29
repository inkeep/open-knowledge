import type { PtyProcessLike } from '../../src/utility/pty-host.ts';

export const CURSOR_POSITION_QUERY = '\u001b[6n';

export interface CursorReport {
  row: number;
  column: number;
}

export interface ConptyCursorSyncHostOptions {
  cols: number;
  rows: number;
  afterTimedOutQuery?: 'asks-again' | 'stops-asking';
  queryOutput?: (queryNumber: number) => readonly string[];
}

export interface ConptyCursorSyncHost extends PtyProcessLike {
  readonly outputEmitted: readonly string[];
  readonly inputReceived: readonly string[];
  readonly keysReadByShell: readonly string[];
  readonly linesAcceptedByShell: readonly string[];
  readonly cursorReportsConsumed: readonly CursorReport[];
  readonly cursorQueriesIssued: number;
  readonly shellBlockedOnCursorSync: boolean;
  shellReadsScreenBufferInfo(): void;
  cursorSyncWaitTimesOut(): void;
}

type ConsoleKey =
  | { kind: 'char'; char: string }
  | { kind: 'enter' }
  | { kind: 'f3'; shift: boolean; alt: boolean; ctrl: boolean };

type CharacterSearchDirection = 'forward' | 'backward';

const VT_SHIFT = 1;
const VT_ALT = 2;
const VT_CTRL = 4;

function f3WithVtModifiers(modifierParameter: number): ConsoleKey {
  const flags = modifierParameter - 1;
  return {
    kind: 'f3',
    shift: (flags & VT_SHIFT) !== 0,
    alt: (flags & VT_ALT) !== 0,
    ctrl: (flags & VT_CTRL) !== 0,
  };
}

function keyName(key: ConsoleKey): string {
  if (key.kind === 'char') return key.char;
  if (key.kind === 'enter') return '\r';
  const modifiers = [key.ctrl ? 'Ctrl' : '', key.alt ? 'Alt' : '', key.shift ? 'Shift' : ''];
  return `<${[...modifiers.filter((name) => name !== ''), 'F3'].join('+')}>`;
}

function keyChar(key: ConsoleKey): string {
  if (key.kind === 'char') return key.char;
  if (key.kind === 'enter') return '\r';
  return '\u0000';
}

function unmodeledInput(input: string): Error {
  return new Error(
    `the ConPTY cursor-sync host model does not cover input ${JSON.stringify(input)}`,
  );
}

interface CsiSequence {
  length: number;
  parameters: readonly (number | undefined)[];
  final: string;
}

function readCsi(input: string, start: number): CsiSequence | null {
  if (start + 1 >= input.length) return null;
  if (input[start + 1] !== '[') throw unmodeledInput(input.slice(start));
  let end = start + 2;
  while (end < input.length && /[0-9;]/u.test(input[end] as string)) end += 1;
  if (end >= input.length) return null;
  const final = input[end] as string;
  if (final < '@' || final > '~') throw unmodeledInput(input.slice(start, end + 1));
  const raw = input.slice(start + 2, end);
  return {
    length: end + 1 - start,
    parameters:
      raw === '' ? [] : raw.split(';').map((part) => (part === '' ? undefined : Number(part))),
    final,
  };
}

export function createConptyCursorSyncHost(
  options: ConptyCursorSyncHostOptions,
): ConptyCursorSyncHost {
  const afterTimedOutQuery = options.afterTimedOutQuery ?? 'asks-again';
  const queryOutput = options.queryOutput ?? (() => [CURSOR_POSITION_QUERY]);
  const outputEmitted: string[] = [];
  const inputReceived: string[] = [];
  const keysReadByShell: string[] = [];
  const linesAcceptedByShell: string[] = [];
  const cursorReportsConsumed: CursorReport[] = [];
  const consoleInput: ConsoleKey[] = [];
  let size = { cols: options.cols, rows: options.rows };
  let cursorPositionMayBeWrong = false;
  let dirtyGeneration = 0;
  let generationAtQuery = 0;
  let captureNextCursorReport = false;
  let shellBlockedOnCursorSync = false;
  let cursorQueriesIssued = 0;
  let line = '';
  let lineCursor = 0;
  let pendingCharacterSearch: CharacterSearchDirection | null = null;
  let dataListener: ((data: string) => void) | null = null;

  function emit(chunk: string): void {
    outputEmitted.push(chunk);
    dataListener?.(chunk);
  }

  function characterSearch(direction: CharacterSearchDirection, target: string): void {
    if (direction === 'forward') {
      for (let index = lineCursor + 1; index < line.length; index += 1) {
        if (line[index] === target) {
          lineCursor = index;
          return;
        }
      }
      return;
    }
    for (let index = lineCursor - 1; index >= 0; index -= 1) {
      if (line[index] === target) {
        lineCursor = index;
        return;
      }
    }
  }

  function shellHandles(key: ConsoleKey): void {
    keysReadByShell.push(keyName(key));
    if (pendingCharacterSearch !== null) {
      const direction = pendingCharacterSearch;
      pendingCharacterSearch = null;
      characterSearch(direction, keyChar(key));
      return;
    }
    if (key.kind === 'char') {
      line = `${line.slice(0, lineCursor)}${key.char}${line.slice(lineCursor)}`;
      lineCursor += 1;
      return;
    }
    if (key.kind === 'enter') {
      linesAcceptedByShell.push(line);
      line = '';
      lineCursor = 0;
      return;
    }
    if (!key.alt && !key.ctrl) pendingCharacterSearch = key.shift ? 'backward' : 'forward';
  }

  function drainConsoleInput(): void {
    while (!shellBlockedOnCursorSync && consoleInput.length > 0) {
      shellHandles(consoleInput.shift() as ConsoleKey);
    }
  }

  function resetCursorPositionMayBeWrong(): void {
    if (!cursorPositionMayBeWrong) return;
    cursorPositionMayBeWrong = false;
    dirtyGeneration += 1;
  }

  function dispatchCsi(sequence: CsiSequence, text: string): void {
    const parameter = (index: number): number => sequence.parameters[index] ?? 1;
    if (sequence.final === 'R') {
      if (captureNextCursorReport) {
        captureNextCursorReport = false;
        cursorReportsConsumed.push({ row: parameter(0), column: parameter(1) });
        resetCursorPositionMayBeWrong();
        shellBlockedOnCursorSync = false;
        return;
      }
      consoleInput.push(f3WithVtModifiers(parameter(1)));
      return;
    }
    if ((sequence.final === 'I' || sequence.final === 'O') && sequence.parameters.length === 0) {
      return;
    }
    throw unmodeledInput(text);
  }

  function consumeInput(data: string): void {
    let index = 0;
    while (index < data.length) {
      const char = data[index] as string;
      if (char === '\u001b') {
        const sequence = readCsi(data, index);
        if (sequence === null) throw unmodeledInput(data.slice(index));
        dispatchCsi(sequence, data.slice(index, index + sequence.length));
        index += sequence.length;
        continue;
      }
      if (char === '\r') {
        consoleInput.push({ kind: 'enter' });
      } else if (char >= ' ' && char <= '~') {
        consoleInput.push({ kind: 'char', char });
      } else {
        throw unmodeledInput(char);
      }
      index += 1;
    }
  }

  return {
    pid: 4242,
    get outputEmitted() {
      return outputEmitted;
    },
    get inputReceived() {
      return inputReceived;
    },
    get keysReadByShell() {
      return keysReadByShell;
    },
    get linesAcceptedByShell() {
      return linesAcceptedByShell;
    },
    get cursorReportsConsumed() {
      return cursorReportsConsumed;
    },
    get cursorQueriesIssued() {
      return cursorQueriesIssued;
    },
    get shellBlockedOnCursorSync() {
      return shellBlockedOnCursorSync;
    },
    onData(listener) {
      dataListener = listener;
    },
    onExit() {},
    write(data) {
      inputReceived.push(data);
      consumeInput(data);
      drainConsoleInput();
    },
    resize(cols, rows) {
      if (cols === size.cols && rows === size.rows) return;
      size = { cols, rows };
      cursorPositionMayBeWrong = true;
      dirtyGeneration += 1;
    },
    kill() {},
    pause() {},
    resume() {},
    shellReadsScreenBufferInfo() {
      if (shellBlockedOnCursorSync) {
        throw new Error('the shell is still blocked in the previous cursor sync wait');
      }
      if (!cursorPositionMayBeWrong) return;
      const chunks = queryOutput(cursorQueriesIssued + 1);
      if (chunks.join('').split(CURSOR_POSITION_QUERY).length !== 2) {
        throw new Error(
          `query output must carry exactly one cursor-position query: ${JSON.stringify(chunks)}`,
        );
      }
      cursorQueriesIssued += 1;
      captureNextCursorReport = true;
      generationAtQuery = dirtyGeneration;
      shellBlockedOnCursorSync = true;
      for (const chunk of chunks) emit(chunk);
    },
    cursorSyncWaitTimesOut() {
      if (!shellBlockedOnCursorSync) throw new Error('no cursor sync wait is in progress');
      shellBlockedOnCursorSync = false;
      if (afterTimedOutQuery === 'stops-asking' && dirtyGeneration === generationAtQuery) {
        resetCursorPositionMayBeWrong();
      }
      drainConsoleInput();
    },
  };
}
