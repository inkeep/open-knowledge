import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { waitForShellReady, waitForTerminalOutput } from './terminal-ready';
import { numberedScrollLine } from './terminal-scrollback';
import { terminalSmokeShellCommands } from './terminal-smoke-shell';

const POWERSHELL_BANNER = 'PowerShell 7.6.6';
const POWERSHELL_PROMPT = 'PS C:\\Users\\runneradmin\\AppData\\Local\\Temp\\ok-term-proj> ';
const POWERSHELL_PROMPT_TEXT_REDRAW = '> ';
const POWERSHELL_CONTINUATION_PROMPT = '>> ';
const POWERSHELL_PROFILE_LOAD_TIME = 'Loading personal and system profiles took 2840ms.';
const POWERSHELL_UNTERMINATED_LINE = `${POWERSHELL_PROMPT}852f747a1bbfdb530ad50b962_$((6*7))_READY"`;
const POWERSHELL_ARITHMETIC_WRITE = /^Write-Output "([^"]*)\$\(\((\d+)\*(\d+)\)\)([^"]*)"$/u;

const EARLIER_CALL_TOKEN = 'OK_INPUT_READY_49ddbe43af6c4863836fdea9d02fa945';
const EARLIER_CALL_ECHO_AND_MARKER = [
  `${POWERSHELL_PROMPT}Write-Output "${EARLIER_CALL_TOKEN}_$((6*7))_READY"`,
  `${EARLIER_CALL_TOKEN}_42_READY`,
];
const RELOAD_REPLAY = [
  ...EARLIER_CALL_ECHO_AND_MARKER,
  `${POWERSHELL_PROMPT}$env:OK_RELOAD_MARKER='OKRELOAD_SURVIVED_351'`,
  `${POWERSHELL_PROMPT}Write-Output "before=[$env:OK_RELOAD_MARKER]"`,
  'before=[OKRELOAD_SURVIVED_351]',
];

const XTERM_VIEWPORT_ROWS = 12;
const XTERM_EMPTY_ACCESSIBILITY_ROW = '\u00a0';
const XTERM_CURSOR_CELL = ' ';

const PROMPTED_POLL = { interval: 10, timeout: 5_000 };
const LONG_BLANK_POLL = { interval: 25, timeout: 5_000 };
const NEVER_READY_POLL = { interval: 10, timeout: 600 };

type TerminalReader = 'accessibility-then-rows' | 'rows-inner-text';

interface ShellWrite {
  readonly label: string;
  readonly text: string;
  readonly afterRead: number;
  readonly violation: string | null;
  evaluated: boolean;
  promptedAfter: boolean;
}

interface PowerShellScript {
  readonly startupScreen?: (read: number) => readonly string[];
  readonly startupDelayMs?: number;
  readonly firstPromptAtRead: number | null;
  readonly echoLagReads?: number;
  readonly evaluationLagReads?: number;
  readonly evaluationDelayMs?: number;
  readonly promptLagReads?: number;
  readonly reader?: TerminalReader;
  readonly replayedHistory?: readonly string[];
  readonly promptAfterEvaluation?: string;
}

interface TerminalScreen {
  readonly history: readonly string[];
  readonly editing: string | null;
  readonly liveRegion: string;
}

interface ReaderShape {
  readonly shape: string;
  readonly screen: Pick<PowerShellScript, 'reader' | 'replayedHistory'>;
}

const READER_SHAPES: readonly ReaderShape[] = [
  { shape: 'the accessibility copy then the rows', screen: { reader: 'accessibility-then-rows' } },
  { shape: 'the rows innerText', screen: { reader: 'rows-inner-text' } },
  {
    shape: 'a reload replay then the live rows',
    screen: { reader: 'accessibility-then-rows', replayedHistory: RELOAD_REPLAY },
  },
];

const EVERY_READER_SHAPE: readonly ReaderShape[] = [
  { shape: 'rows joined by newlines', screen: {} },
  ...READER_SHAPES,
];

const READER_SHAPES_WITHOUT_A_REPLAY = EVERY_READER_SHAPE.filter(
  ({ screen }) => screen.replayedHistory === undefined,
);

type ReadinessOutcome = 'resolved' | 'rejected';

interface ReadinessHandover {
  readonly outcome: ReadinessOutcome;
  readonly probeEvaluated: boolean;
  readonly promptedAfterLastWrite: boolean;
  readonly writesAwaitingPrompt: readonly string[];
}

const HANDED_OVER_AT_A_FRESH_PROMPT: ReadinessHandover = {
  outcome: 'resolved',
  probeEvaluated: true,
  promptedAfterLastWrite: true,
  writesAwaitingPrompt: [],
};

function outputOf(write: ShellWrite): string[] {
  const match = POWERSHELL_ARITHMETIC_WRITE.exec(write.text);
  if (match === null) return [];
  const [, head, left, right, tail] = match;
  return [`${head}${Number(left) * Number(right)}${tail}`];
}

function cursorRow({ editing }: TerminalScreen): string {
  return `${editing ?? ''}${XTERM_CURSOR_CELL}`;
}

function accessibilityCopy({ history, editing, liveRegion }: TerminalScreen): string {
  const rows = editing === null ? history : [...history, editing];
  const emptyRows = Math.max(0, XTERM_VIEWPORT_ROWS - rows.length);
  return `${rows.join('')}${XTERM_EMPTY_ACCESSIBILITY_ROW.repeat(emptyRows)}${liveRegion}`;
}

function readTerminal(
  reader: TerminalReader | undefined,
  screen: TerminalScreen,
  accessibilityScreen: TerminalScreen,
): string {
  if (reader === 'accessibility-then-rows') {
    return `${accessibilityCopy(accessibilityScreen)}\n${[...screen.history, cursorRow(screen)].join('')}`;
  }
  if (reader === 'rows-inner-text') return [...screen.history, cursorRow(screen)].join('\n');
  return [...screen.history, ...(screen.editing === null ? [] : [screen.editing])].join('\n');
}

function scriptedPowerShell({
  startupScreen = () => [POWERSHELL_BANNER],
  startupDelayMs = 0,
  firstPromptAtRead,
  echoLagReads = 0,
  evaluationLagReads = 0,
  evaluationDelayMs = 0,
  promptLagReads = 0,
  reader,
  replayedHistory = [],
  promptAfterEvaluation = POWERSHELL_PROMPT,
}: PowerShellScript) {
  const startupBeginsAt = performance.now() + startupDelayMs;
  let reads = 0;
  let startupReads = 0;
  let prompted = firstPromptAtRead === 0;
  const screenBeforePrompt = (read: number): string[] => [
    ...startupScreen(read),
    ...replayedHistory,
  ];
  let history: string[] = screenBeforePrompt(startupReads);
  let editing: string | null = prompted ? POWERSHELL_PROMPT : null;
  let liveRegion = '';
  let evaluating: {
    readonly write: ShellWrite;
    readonly outputAtRead: number;
    readonly outputAtTime: number;
    promptAtRead: number | null;
  } | null = null;
  const queued: ShellWrite[] = [];
  const writes: ShellWrite[] = [];

  const announce = (text: string): void => {
    if (writes.length > 0) liveRegion += text;
  };

  const advance = (): void => {
    if (!prompted) {
      if (performance.now() >= startupBeginsAt) startupReads += 1;
      history = screenBeforePrompt(startupReads);
      if (firstPromptAtRead === null || startupReads < firstPromptAtRead) return;
      prompted = true;
      editing = POWERSHELL_PROMPT;
      announce(POWERSHELL_PROMPT);
    }
    for (;;) {
      if (evaluating === null) {
        const next = queued.at(0);
        if (next === undefined || reads <= next.afterRead + echoLagReads) return;
        queued.shift();
        editing = `${editing ?? ''}${next.text}`;
        announce(POWERSHELL_PROMPT_TEXT_REDRAW);
        evaluating = {
          write: next,
          outputAtRead: reads + evaluationLagReads,
          outputAtTime: performance.now() + evaluationDelayMs,
          promptAtRead: null,
        };
      }
      if (evaluating.promptAtRead === null) {
        if (reads < evaluating.outputAtRead || performance.now() < evaluating.outputAtTime) return;
        const output = outputOf(evaluating.write);
        history.push(editing ?? '', ...output);
        announce(`\n${output.map((line) => `${line}\n`).join('')}`);
        editing = null;
        evaluating.write.evaluated = true;
        evaluating.promptAtRead = reads + promptLagReads;
      }
      if (reads < evaluating.promptAtRead) return;
      editing = promptAfterEvaluation;
      announce(promptAfterEvaluation);
      evaluating.write.promptedAfter = promptAfterEvaluation === POWERSHELL_PROMPT;
      evaluating = null;
    }
  };

  const screen = (): TerminalScreen => ({ history: [...history], editing, liveRegion });
  let accessibilityScreen = screen();

  const unreadiness = (): string | null => {
    if (!prompted) return 'before the shell showed its first prompt';
    const previous = writes.at(-1);
    if (previous !== undefined && !previous.promptedAfter) {
      return `before the shell prompted after ${previous.label}`;
    }
    return null;
  };

  const write = (text: string): Promise<void> => {
    const record: ShellWrite = {
      label: `write ${writes.length + 1} (probe)`,
      text,
      afterRead: reads,
      violation: unreadiness(),
      evaluated: false,
      promptedAfter: false,
    };
    writes.push(record);
    queued.push(record);
    liveRegion = '';
    return Promise.resolve();
  };

  return {
    read: (): Promise<string> => {
      reads += 1;
      advance();
      const current = screen();
      const text = readTerminal(reader, current, accessibilityScreen);
      accessibilityScreen = current;
      return Promise.resolve(text);
    },
    send: write,
    writeLog: () => writes.map(({ label, violation }) => ({ label, violation })),
    violations: () =>
      writes.flatMap(({ label, afterRead, violation }) =>
        violation === null ? [] : [`${label} after read ${afterRead}, ${violation}`],
      ),
    handover: (outcome: ReadinessOutcome): ReadinessHandover => ({
      outcome,
      probeEvaluated: writes.some((w) => w.evaluated),
      promptedAfterLastWrite: writes.at(-1)?.promptedAfter === true,
      writesAwaitingPrompt: writes.filter((w) => !w.promptedAfter).map((w) => w.label),
    }),
  };
}

type ScriptedPowerShell = ReturnType<typeof scriptedPowerShell>;

async function settleOnTheFakeClock(wait: Promise<unknown>): Promise<void> {
  const settlement = Promise.allSettled([wait]).then(() => {
    vi.clearAllTimers();
  });
  await vi.runAllTimersAsync();
  await settlement;
}

async function runWindowsReadiness(
  shell: ScriptedPowerShell,
  poll: { readonly interval: number; readonly timeout: number },
): Promise<ReadinessHandover> {
  const handover = waitForShellReady(shell.read, shell.send, {
    ...poll,
    platform: 'win32',
  }).then(
    () => shell.handover('resolved'),
    () => shell.handover('rejected'),
  );
  await settleOnTheFakeClock(handover);
  return handover;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('terminal smoke shell readiness', () => {
  describe.each(EVERY_READER_SHAPE)('as read through $shape', ({ screen }) => {
    test('probes a Windows shell already at its prompt and hands it back at a fresh prompt', async () => {
      const shell = scriptedPowerShell({ ...screen, firstPromptAtRead: 0 });

      const handover = await runWindowsReadiness(shell, PROMPTED_POLL);

      expect(shell.violations()).toEqual([]);
      expect(handover).toEqual(HANDED_OVER_AT_A_FRESH_PROMPT);
    });

    test('accepts the evaluated Windows probe, not its echo, when evaluation trails the echo by a read', async () => {
      const shell = scriptedPowerShell({ ...screen, firstPromptAtRead: 0, evaluationLagReads: 1 });

      const handover = await runWindowsReadiness(shell, PROMPTED_POLL);

      expect(shell.violations()).toEqual([]);
      expect(handover).toEqual(HANDED_OVER_AT_A_FRESH_PROMPT);
    });

    test('writes nothing before the first prompt of a Windows shell whose quiet banner is not yet the prompt', async () => {
      const shell = scriptedPowerShell({ ...screen, firstPromptAtRead: 20 });

      const handover = await runWindowsReadiness(shell, PROMPTED_POLL);

      expect(shell.violations()).toEqual([]);
      expect(handover).toEqual(HANDED_OVER_AT_A_FRESH_PROMPT);
    });

    test('writes nothing before the first prompt of a Windows shell whose terminal stays blank for half the liveness bound', async () => {
      const shell = scriptedPowerShell({
        ...screen,
        startupDelayMs: LONG_BLANK_POLL.timeout / 2,
        startupScreen: (read) => (read === 0 ? [] : [POWERSHELL_BANNER]),
        firstPromptAtRead: 3,
      });

      const handover = await runWindowsReadiness(shell, LONG_BLANK_POLL);

      expect(shell.violations()).toEqual([]);
      expect(handover).toEqual(HANDED_OVER_AT_A_FRESH_PROMPT);
    });

    test.each([
      { startup: 'a blank terminal', startupScreen: (): string[] => [] },
      { startup: 'a quiet banner', startupScreen: (): string[] => [POWERSHELL_BANNER] },
      {
        startup: 'output that never settles',
        startupScreen: (read: number): string[] => [
          POWERSHELL_BANNER,
          `Loading${'.'.repeat(read)}`,
        ],
      },
    ])(
      'writes nothing to a Windows shell that never prompts after $startup, and fails at its liveness bound',
      async ({ startupScreen }) => {
        const shell = scriptedPowerShell({ ...screen, startupScreen, firstPromptAtRead: null });

        const handover = await runWindowsReadiness(shell, NEVER_READY_POLL);

        expect(shell.violations()).toEqual([]);
        expect(handover.outcome).toBe('rejected');
      },
    );

    test.each([2, 5])(
      'writes no reset and no second probe while the Windows shell is still evaluating the first (evaluation trails the echo by %i reads)',
      async (evaluationLagReads) => {
        const shell = scriptedPowerShell({ ...screen, firstPromptAtRead: 0, evaluationLagReads });

        const handover = await runWindowsReadiness(shell, PROMPTED_POLL);

        expect(shell.violations()).toEqual([]);
        expect(handover.probeEvaluated).toBe(true);
      },
    );

    test('hands a Windows shell back at a fresh prompt with none of its writes pending when evaluation trails the echo by two reads', async () => {
      const shell = scriptedPowerShell({ ...screen, firstPromptAtRead: 0, evaluationLagReads: 2 });

      const handover = await runWindowsReadiness(shell, PROMPTED_POLL);

      expect(handover).toEqual(HANDED_OVER_AT_A_FRESH_PROMPT);
    });

    test('hands a Windows shell back only at the prompt that follows the probe output, not on the output alone', async () => {
      const shell = scriptedPowerShell({ ...screen, firstPromptAtRead: 0, promptLagReads: 2 });

      const handover = await runWindowsReadiness(shell, PROMPTED_POLL);

      expect(handover).toEqual(HANDED_OVER_AT_A_FRESH_PROMPT);
    });

    test('still fails loud when the Windows probe is echoed but never evaluated', async () => {
      const shell = scriptedPowerShell({
        ...screen,
        firstPromptAtRead: 0,
        evaluationLagReads: Number.POSITIVE_INFINITY,
      });

      const handover = await runWindowsReadiness(shell, NEVER_READY_POLL);

      expect(handover.outcome).toBe('rejected');
      expect(shell.writeLog()[0]).toEqual({ label: 'write 1 (probe)', violation: null });
    });
  });

  describe.each(EVERY_READER_SHAPE)(
    'as read through $shape, at a continuation prompt',
    ({ screen }) => {
      test('writes nothing to a Windows shell that sits at a continuation prompt, and fails at its liveness bound', async () => {
        const shell = scriptedPowerShell({
          ...screen,
          replayedHistory: [
            ...(screen.replayedHistory ?? []),
            POWERSHELL_UNTERMINATED_LINE,
            POWERSHELL_CONTINUATION_PROMPT,
          ],
          firstPromptAtRead: null,
        });

        const handover = await runWindowsReadiness(shell, NEVER_READY_POLL);

        expect(shell.violations()).toEqual([]);
        expect(handover.outcome).toBe('rejected');
      });

      test('does not hand a Windows shell back at a continuation prompt drawn after the probe output', async () => {
        const shell = scriptedPowerShell({
          ...screen,
          firstPromptAtRead: 0,
          promptAfterEvaluation: POWERSHELL_CONTINUATION_PROMPT,
        });

        const handover = await runWindowsReadiness(shell, NEVER_READY_POLL);

        expect(shell.violations()).toEqual([]);
        expect(handover.outcome).toBe('rejected');
        expect(shell.writeLog()[0]).toEqual({ label: 'write 1 (probe)', violation: null });
      });
    },
  );

  describe.each(READER_SHAPES_WITHOUT_A_REPLAY)(
    'as read through $shape, at a profile-load line',
    ({ screen }) => {
      test('writes nothing before the first prompt of a Windows shell whose profile-load line is not yet the prompt', async () => {
        const shell = scriptedPowerShell({
          ...screen,
          startupScreen: () => [POWERSHELL_BANNER, POWERSHELL_PROFILE_LOAD_TIME],
          firstPromptAtRead: 20,
        });

        const handover = await runWindowsReadiness(shell, PROMPTED_POLL);

        expect(shell.violations()).toEqual([]);
        expect(handover).toEqual(HANDED_OVER_AT_A_FRESH_PROMPT);
      });
    },
  );

  describe.each(EVERY_READER_SHAPE)(
    'as read through $shape, before the probe is echoed',
    ({ screen }) => {
      test('hands a Windows shell back at the prompt drawn after the probe output, not at the prompt still showing from before the probe', async () => {
        const shell = scriptedPowerShell({ ...screen, firstPromptAtRead: 0, echoLagReads: 2 });

        const handover = await runWindowsReadiness(shell, PROMPTED_POLL);

        expect(shell.violations()).toEqual([]);
        expect(handover).toEqual(HANDED_OVER_AT_A_FRESH_PROMPT);
      });
    },
  );

  describe.each(READER_SHAPES_WITHOUT_A_REPLAY)(
    'as read through $shape, after an earlier readiness call, before the probe is echoed',
    ({ screen }) => {
      test("hands a Windows shell back at the prompt drawn after this call's probe output, not at an earlier call's marker and prompt", async () => {
        const shell = scriptedPowerShell({
          ...screen,
          replayedHistory: EARLIER_CALL_ECHO_AND_MARKER,
          firstPromptAtRead: 0,
          echoLagReads: 2,
        });

        const handover = await runWindowsReadiness(shell, PROMPTED_POLL);

        expect(shell.violations()).toEqual([]);
        expect(handover).toEqual(HANDED_OVER_AT_A_FRESH_PROMPT);
      });
    },
  );

  test('spends one liveness bound across both Windows waits, failing a probe evaluated after it even when the first prompt came at half the bound', async () => {
    const shell = scriptedPowerShell({
      startupDelayMs: LONG_BLANK_POLL.timeout / 2,
      firstPromptAtRead: 1,
      evaluationDelayMs: (LONG_BLANK_POLL.timeout * 3) / 4,
    });

    const handover = await runWindowsReadiness(shell, LONG_BLANK_POLL);

    expect(shell.writeLog()).toEqual([{ label: 'write 1 (probe)', violation: null }]);
    expect(handover.outcome).toBe('rejected');
  });

  test('names the whole liveness bound, not its remainder, and the first-prompt wait when a Windows probe is echoed but never evaluated, keeping the text it last read', async () => {
    const shell = scriptedPowerShell({
      firstPromptAtRead: 3,
      evaluationLagReads: Number.POSITIVE_INFINITY,
    });

    const readiness = waitForShellReady(shell.read, shell.send, {
      ...NEVER_READY_POLL,
      platform: 'win32',
    });
    await settleOnTheFakeClock(readiness);

    await expect(readiness).rejects.toThrow(
      new RegExp(
        `^[^\\n]*timeout is ${NEVER_READY_POLL.timeout} ms[^\\n]*first-prompt wait took \\d+ ms`,
      ),
    );
    await expect(readiness).rejects.toThrow('_$((6*7))_READY');
    expect(shell.writeLog()).toEqual([{ label: 'write 1 (probe)', violation: null }]);
  });

  test('still fails loud on POSIX when the buffer never settles, naming the text it last read', async () => {
    let reads = 0;
    const readiness = waitForShellReady(
      () => {
        reads += 1;
        return Promise.resolve(`zsh tick${reads}`);
      },
      () => Promise.resolve(),
      { platform: 'darwin', interval: 5, timeout: 200 },
    );
    await settleOnTheFakeClock(readiness);
    await expect(readiness).rejects.toThrow();
    expect(reads).toBeGreaterThan(1);
    await expect(readiness).rejects.toThrow(`zsh tick${reads}`);
  });

  test('retains the quiet-buffer readiness contract on POSIX', async () => {
    const quietPolls = 3;
    let text = 'shell startup';
    let commandsSent = 0;
    let reads = 0;
    let firstCompleteRead: number | null = null;
    const timer = setTimeout(() => {
      text += ' complete';
    }, 25);

    try {
      const readiness = waitForShellReady(
        () => {
          reads += 1;
          if (firstCompleteRead === null && text.endsWith('complete')) firstCompleteRead = reads;
          return Promise.resolve(text);
        },
        () => {
          commandsSent += 1;
          return Promise.resolve();
        },
        { platform: 'linux', interval: 10, quietPolls, timeout: 2_000 },
      );
      await settleOnTheFakeClock(readiness);
      await readiness;
      expect(commandsSent).toBe(0);
      expect(text).toContain('complete');
      expect(reads - (firstCompleteRead ?? Number.NaN)).toBe(quietPolls);
    } finally {
      clearTimeout(timer);
    }
  });
});

const SCROLL_TOKEN = '3f9a27c4d18e4b6f9e0c5a7d2b1f8e64';
const SCROLL_SENTINEL = `SENTINEL_${SCROLL_TOKEN}`;
const SCROLL_START = `SCROLL_START_${SCROLL_TOKEN}`;
const SCROLL_LINE_PREFIX = `SCROLL_${SCROLL_TOKEN}_`;
const SCROLL_LINE_COUNT = 120;
const SCROLL_COMMAND_ECHO = `${POWERSHELL_PROMPT}${terminalSmokeShellCommands('win32').scroll(
  SCROLL_SENTINEL,
  SCROLL_START,
  SCROLL_LINE_PREFIX,
  SCROLL_LINE_COUNT,
)}`;
const SCROLL_OUTPUT = [
  SCROLL_SENTINEL,
  SCROLL_START,
  ...Array.from({ length: SCROLL_LINE_COUNT }, (_, index) =>
    numberedScrollLine(SCROLL_LINE_PREFIX, index + 1),
  ),
];
const NEWEST_SCROLL_LINE = numberedScrollLine(SCROLL_LINE_PREFIX, SCROLL_LINE_COUNT);
const LAST_SCROLL_LINE_BEFORE_A_STALL = numberedScrollLine(
  SCROLL_LINE_PREFIX,
  SCROLL_LINE_COUNT - 10,
);

const SCROLL_STALL_WINDOW_MS = 15_000;
const XTERM_ACCESSIBILITY_REFRESH_MS = 1_000;
const SLOW_PERIOD_READ_MS = 4_100;

interface ScrollOutputScript {
  readonly linesPerSecond: number;
  readonly linesPrinted?: number;
  readonly pause?: { readonly afterLines: number; readonly forMs: number };
  readonly readDelayMs?: number;
  readonly slowRead?: {
    readonly startingAtOrAfterMs: number;
    readonly forMs: number;
    readonly samplesAt?: 'start' | 'return';
  };
}

interface TerminalFrame {
  readonly atMs: number;
  readonly text: string;
}

interface TerminalRead {
  readonly text: string;
  readonly startedAtMs: number;
  readonly returnedAtMs: number;
}

interface ReadFigures {
  readonly quietMs: number;
  readonly lastChangedMs: number;
  readonly reads: number;
  readonly readingMs: number;
  readonly readsThatChangedTheText: number;
}

interface StallFigures extends ReadFigures {
  readonly windowMs: number;
  readonly slowestReadMs: number;
}

function scrollOutputFrames({
  linesPerSecond,
  linesPrinted = SCROLL_OUTPUT.length,
  pause,
}: ScrollOutputScript): TerminalFrame[] {
  const printed = SCROLL_OUTPUT.slice(0, linesPrinted);
  const arrivalsMs = printed.map(
    (_, index) =>
      Math.round(((index + 1) * 1_000) / linesPerSecond) +
      (pause !== undefined && index >= pause.afterLines ? pause.forMs : 0),
  );
  const finished = printed.length === SCROLL_OUTPUT.length;
  const screenAt = (ms: number): TerminalScreen => {
    const shown = arrivalsMs.filter((atMs) => atMs <= ms).length;
    return {
      history: [
        ...EARLIER_CALL_ECHO_AND_MARKER,
        SCROLL_COMMAND_ECHO,
        ...printed.slice(0, shown),
      ].slice(1 - XTERM_VIEWPORT_ROWS),
      editing: finished && shown === printed.length ? POWERSHELL_PROMPT : null,
      liveRegion: '',
    };
  };
  const refreshesMs = Array.from(
    { length: Math.ceil(Math.max(0, ...arrivalsMs) / XTERM_ACCESSIBILITY_REFRESH_MS) + 1 },
    (_, index) => index * XTERM_ACCESSIBILITY_REFRESH_MS,
  );
  const frames: TerminalFrame[] = [];
  for (const atMs of [...new Set([0, ...arrivalsMs, ...refreshesMs])].sort((a, b) => a - b)) {
    const refreshedAtMs =
      Math.floor(atMs / XTERM_ACCESSIBILITY_REFRESH_MS) * XTERM_ACCESSIBILITY_REFRESH_MS;
    const text = readTerminal('accessibility-then-rows', screenAt(atMs), screenAt(refreshedAtMs));
    if (frames.at(-1)?.text !== text) frames.push({ atMs, text });
  }
  return frames;
}

function scrollingTerminal(script: ScrollOutputScript) {
  const frames = scrollOutputFrames(script);
  const startedAt = performance.now();
  const elapsedMs = (): number => performance.now() - startedAt;
  const reads: TerminalRead[] = [];
  let pendingSlowRead = script.slowRead;
  return {
    read: async (): Promise<string> => {
      const readStartedAtMs = elapsedMs();
      const slowRead =
        pendingSlowRead !== undefined && readStartedAtMs >= pendingSlowRead.startingAtOrAfterMs
          ? pendingSlowRead
          : undefined;
      if (slowRead !== undefined) pendingSlowRead = undefined;
      const readDelayMs = slowRead?.forMs ?? script.readDelayMs;
      if (readDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, readDelayMs));
      }
      const sampledAtMs = slowRead?.samplesAt === 'start' ? readStartedAtMs : elapsedMs();
      const text = frames.findLast(({ atMs }) => atMs <= sampledAtMs)?.text ?? '';
      reads.push({ text, startedAtMs: readStartedAtMs, returnedAtMs: elapsedMs() });
      return text;
    },
    firstShownAtMs: (text: string): number | undefined =>
      frames.find((frame) => frame.text.includes(text))?.atMs,
    lastAdvanceAtMs: frames.at(-1)?.atMs ?? 0,
    longestQuietMs: Math.max(
      0,
      ...frames.slice(1).map((frame, index) => frame.atMs - frames[index].atMs),
    ),
    readCount: (): number => reads.length,
    readsShowing: (text: string): number => reads.filter((read) => read.text.includes(text)).length,
    readFigures: (): ReadFigures => {
      const changedReads = reads.filter(
        (read, index) => index === 0 || read.text !== reads[index - 1].text,
      );
      const lastChange = changedReads[changedReads.length - 1];
      const lastRead = reads[reads.length - 1];
      return {
        quietMs: lastRead.startedAtMs - lastChange.returnedAtMs,
        lastChangedMs: lastChange.returnedAtMs,
        reads: reads.length,
        readingMs: lastRead.returnedAtMs,
        readsThatChangedTheText: changedReads.length,
      };
    },
    runUntil: async (ms: number): Promise<void> => {
      await vi.advanceTimersByTimeAsync(ms - elapsedMs());
    },
  };
}

type ScrollingTerminal = ReturnType<typeof scrollingTerminal>;

type OutputWaitState = 'pending' | ReadinessOutcome;

interface OutputWaitSettlement {
  state: OutputWaitState;
  error: unknown;
}

function waitForTheNewestScrollLine(terminal: ScrollingTerminal): OutputWaitSettlement {
  const settlement: OutputWaitSettlement = { state: 'pending', error: undefined };
  void waitForTerminalOutput(terminal.read, NEWEST_SCROLL_LINE, {
    stallMs: SCROLL_STALL_WINDOW_MS,
  }).then(
    () => {
      settlement.state = 'resolved';
    },
    (error: unknown) => {
      settlement.state = 'rejected';
      settlement.error = error;
    },
  );
  return settlement;
}

interface NewestLineObservation {
  readonly beforeTheNewestLine: OutputWaitState;
  readonly afterTheNewestLine: OutputWaitState;
  readonly readsShowingTheNewestLine: number;
}

const RESOLVED_ONCE_THE_NEWEST_LINE_APPEARS: NewestLineObservation = {
  beforeTheNewestLine: 'pending',
  afterTheNewestLine: 'resolved',
  readsShowingTheNewestLine: 1,
};

async function observeTheNewestLine(terminal: ScrollingTerminal): Promise<NewestLineObservation> {
  const newestLineAtMs = terminal.firstShownAtMs(NEWEST_SCROLL_LINE) ?? Number.NaN;
  const wait = waitForTheNewestScrollLine(terminal);
  await terminal.runUntil(newestLineAtMs - 1);
  const beforeTheNewestLine = wait.state;
  await terminal.runUntil(newestLineAtMs + SCROLL_STALL_WINDOW_MS);
  return {
    beforeTheNewestLine,
    afterTheNewestLine: wait.state,
    readsShowingTheNewestLine: terminal.readsShowing(NEWEST_SCROLL_LINE),
  };
}

function statedFigure(message: string, figure: RegExp): number {
  return Number(figure.exec(message)?.[1]);
}

function statedStallFigures(message: string): StallFigures {
  return {
    quietMs: statedFigure(message, /has not changed for (\d+) ms/u),
    windowMs: statedFigure(message, /declared stall window of (\d+) ms/u),
    lastChangedMs: statedFigure(message, /last changed (\d+) ms after the wait began/u),
    reads: statedFigure(message, /made (\d+) reads/u),
    readingMs: statedFigure(message, /reads in (\d+) ms/u),
    readsThatChangedTheText: statedFigure(message, /(\d+) of which changed the text/u),
    slowestReadMs: statedFigure(message, /slowest read took (\d+) ms/u),
  };
}

describe('terminal output wait', () => {
  test.each([{ linesPerSecond: 8 }, { linesPerSecond: 6.5 }, { linesPerSecond: 4.5 }])(
    'resolves once the newest line appears on output still advancing at $linesPerSecond lines/s, whose newest line lands after the declared window has passed from the start',
    async (script) => {
      const terminal = scrollingTerminal(script);

      expect(terminal.firstShownAtMs(NEWEST_SCROLL_LINE)).toBeGreaterThan(SCROLL_STALL_WINDOW_MS);
      expect(terminal.longestQuietMs).toBeLessThan(SCROLL_STALL_WINDOW_MS);
      expect(await observeTheNewestLine(terminal)).toEqual(RESOLVED_ONCE_THE_NEWEST_LINE_APPEARS);
    },
  );

  test('resolves once the newest line appears on output that keeps advancing while every read of the terminal is slow', async () => {
    const terminal = scrollingTerminal({ linesPerSecond: 6.5, readDelayMs: SLOW_PERIOD_READ_MS });

    expect(terminal.firstShownAtMs(NEWEST_SCROLL_LINE)).toBeGreaterThan(SCROLL_STALL_WINDOW_MS);
    expect(terminal.longestQuietMs).toBeLessThan(SLOW_PERIOD_READ_MS);
    expect(await observeTheNewestLine(terminal)).toEqual(RESOLVED_ONCE_THE_NEWEST_LINE_APPEARS);
  });

  test('resolves once the newest line appears on output that pauses for less than the declared window and then resumes', async () => {
    const terminal = scrollingTerminal({
      linesPerSecond: 6.5,
      pause: {
        afterLines: SCROLL_OUTPUT.length / 2,
        forMs: SCROLL_STALL_WINDOW_MS - XTERM_ACCESSIBILITY_REFRESH_MS,
      },
    });

    expect(terminal.longestQuietMs).toBeGreaterThan(SCROLL_STALL_WINDOW_MS / 2);
    expect(terminal.longestQuietMs).toBeLessThan(SCROLL_STALL_WINDOW_MS);
    expect(await observeTheNewestLine(terminal)).toEqual(RESOLVED_ONCE_THE_NEWEST_LINE_APPEARS);
  });

  test('keeps waiting on output that advanced past the declared window and then stopped short of the newest line, and fails only once the window has passed since its last advance, naming the newest line, the window and its last read', async () => {
    const terminal = scrollingTerminal({
      linesPerSecond: 6.5,
      linesPrinted: SCROLL_OUTPUT.indexOf(LAST_SCROLL_LINE_BEFORE_A_STALL) + 1,
    });

    expect(terminal.firstShownAtMs(LAST_SCROLL_LINE_BEFORE_A_STALL)).toBeDefined();
    expect(terminal.firstShownAtMs(NEWEST_SCROLL_LINE)).toBeUndefined();
    expect(terminal.lastAdvanceAtMs).toBeGreaterThan(SCROLL_STALL_WINDOW_MS);

    const wait = waitForTheNewestScrollLine(terminal);
    await terminal.runUntil(terminal.lastAdvanceAtMs + SCROLL_STALL_WINDOW_MS - 1);
    const beforeTheWindowPassed = wait.state;
    await terminal.runUntil(terminal.lastAdvanceAtMs + 2 * SCROLL_STALL_WINDOW_MS - 1);
    const message = wait.error instanceof Error ? wait.error.message : '';

    expect({
      beforeTheWindowPassed,
      afterTheWindowPassed: wait.state,
      namesTheNewestLine: message.includes(NEWEST_SCROLL_LINE),
      namesTheWindow: message.includes(String(SCROLL_STALL_WINDOW_MS)),
      namesItsLastRead: message.includes(LAST_SCROLL_LINE_BEFORE_A_STALL),
    }).toEqual({
      beforeTheWindowPassed: 'pending',
      afterTheWindowPassed: 'rejected',
      namesTheNewestLine: true,
      namesTheWindow: true,
      namesItsLastRead: true,
    });
  });

  test('fails output that never advances once the declared window has passed', async () => {
    const terminal = scrollingTerminal({ linesPerSecond: 6.5, linesPrinted: 0 });

    expect(terminal.lastAdvanceAtMs).toBe(0);

    const wait = waitForTheNewestScrollLine(terminal);
    await terminal.runUntil(SCROLL_STALL_WINDOW_MS / 2);
    const insideTheWindow = wait.state;
    await terminal.runUntil(2 * SCROLL_STALL_WINDOW_MS - 1);

    expect({ insideTheWindow, afterTheWindowPassed: wait.state }).toEqual({
      insideTheWindow: 'pending',
      afterTheWindowPassed: 'rejected',
    });
  });

  test('resolves at its first read when the output already shows the newest line', async () => {
    const terminal = scrollingTerminal({ linesPerSecond: Number.POSITIVE_INFINITY });

    expect(terminal.firstShownAtMs(NEWEST_SCROLL_LINE)).toBe(0);

    const wait = waitForTheNewestScrollLine(terminal);
    await terminal.runUntil(0);

    expect({ state: wait.state, reads: terminal.readCount() }).toEqual({
      state: 'resolved',
      reads: 1,
    });
  });

  test('resolves once the newest line appears on output that finishes inside the declared window', async () => {
    const terminal = scrollingTerminal({ linesPerSecond: 100 });

    expect(terminal.firstShownAtMs(NEWEST_SCROLL_LINE)).toBeLessThan(SCROLL_STALL_WINDOW_MS);
    expect(await observeTheNewestLine(terminal)).toEqual(RESOLVED_ONCE_THE_NEWEST_LINE_APPEARS);
  });

  test('resolves once the newest line appears on output that never goes quiet for the declared window but takes more than a hundred windows to finish', async () => {
    const terminal = scrollingTerminal({
      linesPerSecond: 1_000 / (SCROLL_STALL_WINDOW_MS - 2 * XTERM_ACCESSIBILITY_REFRESH_MS),
    });

    expect(terminal.longestQuietMs).toBeLessThan(SCROLL_STALL_WINDOW_MS);
    expect(terminal.firstShownAtMs(NEWEST_SCROLL_LINE)).toBeGreaterThan(
      100 * SCROLL_STALL_WINDOW_MS,
    );
    expect(await observeTheNewestLine(terminal)).toEqual(RESOLVED_ONCE_THE_NEWEST_LINE_APPEARS);
  });

  test('resolves once the newest line appears on output that resumes during a slow read that sampled the terminal before it resumed', async () => {
    const pause = {
      afterLines: SCROLL_OUTPUT.length / 2,
      forMs: SCROLL_STALL_WINDOW_MS - XTERM_ACCESSIBILITY_REFRESH_MS,
    };
    const pausing = { linesPerSecond: 6.5, pause };
    const resumedAtMs =
      scrollingTerminal(pausing).firstShownAtMs(SCROLL_OUTPUT[pause.afterLines]) ?? Number.NaN;
    const slowReadFromMs = resumedAtMs - XTERM_ACCESSIBILITY_REFRESH_MS;
    const terminal = scrollingTerminal({
      ...pausing,
      slowRead: {
        startingAtOrAfterMs: slowReadFromMs,
        forMs: SLOW_PERIOD_READ_MS,
        samplesAt: 'start',
      },
    });
    const quietFromMs = resumedAtMs - terminal.longestQuietMs;

    expect(terminal.longestQuietMs).toBeLessThan(SCROLL_STALL_WINDOW_MS);
    expect(slowReadFromMs + SLOW_PERIOD_READ_MS - quietFromMs).toBeGreaterThan(
      SCROLL_STALL_WINDOW_MS,
    );
    expect(await observeTheNewestLine(terminal)).toEqual(RESOLVED_ONCE_THE_NEWEST_LINE_APPEARS);
  });

  test('keeps waiting on output whose last advance lands during one slow read of the terminal, and fails only once the window has passed since that advance, naming its last read and stating its window and the reads it made, timed from its own start', async () => {
    await vi.advanceTimersByTimeAsync(SCROLL_STALL_WINDOW_MS);
    const stall = {
      linesPerSecond: 6.5,
      linesPrinted: SCROLL_OUTPUT.indexOf(LAST_SCROLL_LINE_BEFORE_A_STALL) + 1,
    };
    const { lastAdvanceAtMs } = scrollingTerminal(stall);
    const terminal = scrollingTerminal({
      ...stall,
      slowRead: {
        startingAtOrAfterMs: lastAdvanceAtMs - SLOW_PERIOD_READ_MS,
        forMs: SLOW_PERIOD_READ_MS,
        samplesAt: 'return',
      },
    });

    expect(terminal.lastAdvanceAtMs).toBe(lastAdvanceAtMs);
    expect(terminal.firstShownAtMs(NEWEST_SCROLL_LINE)).toBeUndefined();

    const wait = waitForTheNewestScrollLine(terminal);
    await terminal.runUntil(lastAdvanceAtMs + SCROLL_STALL_WINDOW_MS - 1);
    const beforeTheWindowPassed = wait.state;
    await terminal.runUntil(lastAdvanceAtMs + 2 * SCROLL_STALL_WINDOW_MS - 1);
    const message = wait.error instanceof Error ? wait.error.message : '';

    expect({
      beforeTheWindowPassed,
      afterTheWindowPassed: wait.state,
      namesItsLastRead: message.includes(LAST_SCROLL_LINE_BEFORE_A_STALL),
      statedFigures: statedStallFigures(message),
    }).toEqual({
      beforeTheWindowPassed: 'pending',
      afterTheWindowPassed: 'rejected',
      namesItsLastRead: true,
      statedFigures: {
        ...terminal.readFigures(),
        windowMs: SCROLL_STALL_WINDOW_MS,
        slowestReadMs: SLOW_PERIOD_READ_MS,
      },
    });
  });

  test('fails output that never advances only once the declared window has passed since its slow first read returned, stating how long it had been quiet, its window and the reads it made', async () => {
    const terminal = scrollingTerminal({
      linesPerSecond: 6.5,
      linesPrinted: 0,
      slowRead: { startingAtOrAfterMs: 0, forMs: SLOW_PERIOD_READ_MS },
    });
    const firstReadReturnedAtMs = SLOW_PERIOD_READ_MS;

    expect(terminal.lastAdvanceAtMs).toBe(0);

    const wait = waitForTheNewestScrollLine(terminal);
    await terminal.runUntil(firstReadReturnedAtMs + SCROLL_STALL_WINDOW_MS - 1);
    const beforeTheWindowPassed = wait.state;
    await terminal.runUntil(firstReadReturnedAtMs + 2 * SCROLL_STALL_WINDOW_MS - 1);
    const message = wait.error instanceof Error ? wait.error.message : '';
    const readFigures = terminal.readFigures();

    expect({
      beforeTheWindowPassed,
      afterTheWindowPassed: wait.state,
      quietOutlastsTheWindow: readFigures.quietMs > SCROLL_STALL_WINDOW_MS,
      statedFigures: statedStallFigures(message),
    }).toEqual({
      beforeTheWindowPassed: 'pending',
      afterTheWindowPassed: 'rejected',
      quietOutlastsTheWindow: true,
      statedFigures: {
        ...readFigures,
        windowMs: SCROLL_STALL_WINDOW_MS,
        slowestReadMs: SLOW_PERIOD_READ_MS,
      },
    });
  });
});
