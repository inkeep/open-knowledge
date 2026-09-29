import { describe, expect, test } from 'vitest';
import {
  numberedScrollLine,
  readScrollbackUpward,
  type ScrollbackExpectation,
} from './terminal-scrollback';
import { terminalSmokeShellCommands } from './terminal-smoke-shell';

const TOKEN = '0123456789abcdef0123456789abcdef';
const SENTINEL = `SENTINEL_${TOKEN}`;
const SCROLL_START = `SCROLL_START_${TOKEN}`;
const LINE_PREFIX = `SCROLL_${TOKEN}_`;
const LINE_COUNT = 120;
const DOCK_ROWS = 13;
const COLUMN_ROWS = 48;
const PAGE_LIMIT = 40;
const PROMPT = 'PS C:\\project> ';

const expectation: ScrollbackExpectation = {
  markers: [SENTINEL, SCROLL_START],
  linePrefix: LINE_PREFIX,
  lineCount: LINE_COUNT,
};

const scrollLines = Array.from({ length: LINE_COUNT }, (_, index) =>
  numberedScrollLine(LINE_PREFIX, index + 1),
);

function transcript(platform: NodeJS.Platform, lines: readonly string[]): string[] {
  const command = terminalSmokeShellCommands(platform).scroll(
    SENTINEL,
    SCROLL_START,
    LINE_PREFIX,
    LINE_COUNT,
  );
  return ['PowerShell 7.6.5', `${PROMPT}${command}`, SENTINEL, SCROLL_START, ...lines, PROMPT];
}

function renderedTerminal(
  buffer: readonly string[],
  rows: number,
  startAt: 'bottom' | 'top' = 'bottom',
) {
  const bottomViewportY = Math.max(0, buffer.length - rows);
  let viewportY = startAt === 'bottom' ? bottomViewportY : 0;
  const view = () => buffer.slice(viewportY, viewportY + rows).join('');
  return {
    readSettledView: async () => view(),
    pageUpFrom: async (_settledView: string) => {
      viewportY = Math.max(0, viewportY - (rows - 1));
      return view();
    },
    pageDownFrom: async (_settledView: string) => {
      viewportY = Math.min(bottomViewportY, viewportY + (rows - 1));
      return view();
    },
  };
}

function linesOverwrittenByDockToColumnGrowth(): string[] {
  const rowsPulledIntoView = COLUMN_ROWS - DOCK_ROWS;
  const firstPreGrowthViewportLine = LINE_COUNT - (DOCK_ROWS - 1);
  return scrollLines.slice(
    firstPreGrowthViewportLine - rowsPulledIntoView,
    firstPreGrowthViewportLine,
  );
}

function pagesToTop(bufferLength: number, rows: number): number {
  return Math.ceil(Math.max(0, bufferLength - rows) / (rows - 1));
}

function pagesToCrossAndConfirmTheEnd(bufferLength: number, rows: number): number {
  return pagesToTop(bufferLength, rows) + 1;
}

describe('reading terminal scrollback upward', () => {
  test.each([
    { platform: 'win32' as const, rows: DOCK_ROWS },
    { platform: 'win32' as const, rows: COLUMN_ROWS },
    { platform: 'linux' as const, rows: DOCK_ROWS },
  ])(
    'accepts a $platform buffer of $rows rows that still holds every emitted line',
    async ({ platform, rows }) => {
      const terminal = renderedTerminal(transcript(platform, scrollLines), rows);

      await expect(readScrollbackUpward(terminal, expectation, PAGE_LIMIT)).resolves.toEqual({
        kind: 'complete',
      });
    },
  );

  test('names exactly the recent lines a row-growing resize overwrote, though the oldest markers survive', async () => {
    const overwritten = linesOverwrittenByDockToColumnGrowth();
    const survivors = scrollLines.filter((line) => !overwritten.includes(line));
    const terminal = renderedTerminal(transcript('win32', survivors), DOCK_ROWS);

    await expect(readScrollbackUpward(terminal, expectation, PAGE_LIMIT)).resolves.toEqual({
      kind: 'lost',
      pagesRead: expect.any(Number),
      missingMarkers: [],
      missingLines: overwritten,
    });
  });

  test.each([
    { platform: 'win32' as const, rows: DOCK_ROWS },
    { platform: 'win32' as const, rows: COLUMN_ROWS },
    { platform: 'linux' as const, rows: DOCK_ROWS },
    { platform: 'linux' as const, rows: COLUMN_ROWS },
  ])(
    'accepts a $platform buffer of $rows rows that holds every emitted line when the read starts from a view parked at its top',
    async ({ platform, rows }) => {
      const terminal = renderedTerminal(transcript(platform, scrollLines), rows, 'top');
      expect(
        await terminal.readSettledView(),
        'the parked view starts above the newest emitted line',
      ).not.toContain(numberedScrollLine(LINE_PREFIX, LINE_COUNT));

      await expect(readScrollbackUpward(terminal, expectation, PAGE_LIMIT)).resolves.toEqual({
        kind: 'complete',
      });
    },
  );

  test.each([{ rows: COLUMN_ROWS }, { rows: DOCK_ROWS }])(
    'names exactly the lines a row-growing resize overwrote when the read starts from a view parked at the top of $rows rows',
    async ({ rows }) => {
      const overwritten = linesOverwrittenByDockToColumnGrowth();
      const survivors = scrollLines.filter((line) => !overwritten.includes(line));
      const terminal = renderedTerminal(transcript('win32', survivors), rows, 'top');
      expect(
        await terminal.readSettledView(),
        'the parked view starts above the newest emitted line',
      ).not.toContain(numberedScrollLine(LINE_PREFIX, LINE_COUNT));

      await expect(readScrollbackUpward(terminal, expectation, PAGE_LIMIT)).resolves.toEqual({
        kind: 'lost',
        pagesRead: expect.any(Number),
        missingMarkers: [],
        missingLines: overwritten,
      });
    },
  );

  test.each(['win32', 'linux'] as const)(
    'does not count the echoed %s scroll command as the lines it prints',
    async (platform) => {
      const terminal = renderedTerminal(transcript(platform, []), DOCK_ROWS);

      const verdict = await readScrollbackUpward(terminal, expectation, PAGE_LIMIT);

      expect(verdict).toMatchObject({ kind: 'lost', missingLines: scrollLines });
    },
  );

  test('reports an unreached top, not a loss, when the page limit ends the read first', async () => {
    const buffer = transcript('win32', scrollLines);
    const terminal = renderedTerminal(buffer, DOCK_ROWS);
    const tooFewPages = pagesToTop(buffer.length, DOCK_ROWS) - 1;

    const verdict = await readScrollbackUpward(terminal, expectation, tooFewPages);

    expect(verdict).toMatchObject({ kind: 'unreached', pagesRead: tooFewPages });
  });

  test('reports an unreached read, not a loss, when the page limit ends before the descent from a parked view confirms the bottom', async () => {
    const overwritten = linesOverwrittenByDockToColumnGrowth();
    const survivors = scrollLines.filter((line) => !overwritten.includes(line));
    const buffer = transcript('win32', survivors);
    const terminal = renderedTerminal(buffer, DOCK_ROWS, 'top');
    const onePageShortOfConfirmingTheBottom =
      pagesToCrossAndConfirmTheEnd(buffer.length, DOCK_ROWS) - 1;
    expect(
      await terminal.readSettledView(),
      'the parked view starts above the newest emitted line',
    ).not.toContain(numberedScrollLine(LINE_PREFIX, LINE_COUNT));

    const verdict = await readScrollbackUpward(
      terminal,
      expectation,
      onePageShortOfConfirmingTheBottom,
    );

    expect(verdict).toMatchObject({
      kind: 'unreached',
      pagesRead: onePageShortOfConfirmingTheBottom,
    });
  });

  test('charges the descent from a parked view to the same page limit as the ascent', async () => {
    const overwritten = linesOverwrittenByDockToColumnGrowth();
    const survivors = scrollLines.filter((line) => !overwritten.includes(line));
    const buffer = transcript('win32', survivors);
    const terminal = renderedTerminal(buffer, DOCK_ROWS, 'top');
    const onePageShortOfBothLegs = 2 * pagesToCrossAndConfirmTheEnd(buffer.length, DOCK_ROWS) - 1;
    expect(
      await terminal.readSettledView(),
      'the parked view starts above the newest emitted line',
    ).not.toContain(numberedScrollLine(LINE_PREFIX, LINE_COUNT));

    const verdict = await readScrollbackUpward(terminal, expectation, onePageShortOfBothLegs);

    expect(verdict).toMatchObject({ kind: 'unreached', pagesRead: onePageShortOfBothLegs });
  });

  test.each([{ rows: DOCK_ROWS }, { rows: COLUMN_ROWS }])(
    'leaves the view scrolled back above the newest line after a complete read from the bottom of $rows rows',
    async ({ rows }) => {
      const terminal = renderedTerminal(transcript('win32', scrollLines), rows);
      const newestLine = numberedScrollLine(LINE_PREFIX, LINE_COUNT);
      expect(
        await terminal.readSettledView(),
        'the read starts from a view that shows the newest emitted line',
      ).toContain(newestLine);

      await expect(readScrollbackUpward(terminal, expectation, PAGE_LIMIT)).resolves.toEqual({
        kind: 'complete',
      });
      expect(
        await terminal.readSettledView(),
        'the read leaves the view scrolled back for the next move to keep',
      ).not.toContain(newestLine);
    },
  );
});
