import { randomUUID } from 'node:crypto';
import { act, render, waitFor } from '@testing-library/react';
import type { Terminal as XtermTerminal } from '@xterm/xterm';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { OkDesktopBridge, OkPtyData } from '@/lib/desktop-bridge-types';

interface Geometry {
  readonly cols: number;
  readonly rows: number;
}

const DOCK_GEOMETRY: Geometry = { cols: 200, rows: 13 };
const TALLER_DOCK_GEOMETRY: Geometry = { cols: DOCK_GEOMETRY.cols, rows: 48 };
const NARROWED_DOCK_GEOMETRY: Geometry = { cols: 92, rows: DOCK_GEOMETRY.rows };
const COLUMN_GEOMETRY: Geometry = {
  cols: NARROWED_DOCK_GEOMETRY.cols,
  rows: TALLER_DOCK_GEOMETRY.rows,
};
const SCROLL_LINE_COUNT = 120;

const constructedTerminals: XtermTerminal[] = [];
const laidOut: { geometry: Geometry | null } = { geometry: null };

vi.doMock('@xterm/xterm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xterm/xterm')>();
  class RecordedTerminal extends actual.Terminal {
    constructor(...args: ConstructorParameters<typeof actual.Terminal>) {
      super(...args);
      constructedTerminals.push(this);
    }
  }
  return { ...actual, Terminal: RecordedTerminal };
});

vi.doMock('@xterm/addon-fit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xterm/addon-fit')>();
  class LaidOutFitAddon extends actual.FitAddon {
    override proposeDimensions() {
      return laidOut.geometry === null ? undefined : { ...laidOut.geometry };
    }
  }
  return { ...actual, FitAddon: LaidOutFitAddon };
});

type ResizeCallback = (
  entries: readonly { contentRect: { width: number; height: number } }[],
) => void;

const resizeObservers: LayoutResizeObserver[] = [];
class LayoutResizeObserver {
  readonly targets: Element[] = [];
  readonly callback: ResizeCallback;
  disconnected = false;
  constructor(callback: ResizeCallback) {
    this.callback = callback;
    resizeObservers.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
}
vi.stubGlobal('ResizeObserver', LayoutResizeObserver);

const { TerminalPanel } = await import('./TerminalPanel');

const nextAnimationFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

afterEach(async () => {
  await nextAnimationFrame();
  await nextAnimationFrame();
  constructedTerminals.length = 0;
  resizeObservers.length = 0;
  laidOut.geometry = null;
});

interface ModelledHost {
  readonly platform: OkDesktopBridge['platform'];
  readonly prompt: string;
  repaintAfterResize(previous: Geometry, next: Geometry, screen: ScreenModel): string;
}

interface ScreenModel {
  readonly rows: string[];
  readonly cursorRow: number;
  readonly cursorCol: number;
}

const conptyHost: ModelledHost = {
  platform: 'win32',
  prompt: 'PS C:\\Users\\runneradmin\\project> ',
  repaintAfterResize(previous, next, screen) {
    if (next.rows <= previous.rows) return '';
    let repaint = '\x1b[H';
    for (let row = 0; row < next.rows; row += 1) {
      repaint += `\x1b[${row + 1};1H${screen.rows[row] ?? ''}\x1b[K`;
    }
    return `${repaint}\x1b[${screen.cursorRow + 1};${screen.cursorCol + 1}H`;
  },
};

const unixPtyHost = (platform: 'darwin' | 'linux'): ModelledHost => ({
  platform,
  prompt: 'user@host project % ',
  repaintAfterResize: () => '',
});

function hostSession(host: ModelledHost, token: string) {
  const dataSubscribers: Array<(message: OkPtyData) => void> = [];
  const pendingDrains: Array<() => void> = [];
  const repaints: Promise<void>[] = [];
  const ptyId = `pty-${token}`;
  const outputLines: string[] = [''];
  const state: { geometry: Geometry | null; replay: string | null } = {
    geometry: null,
    replay: null,
  };

  const screen = (): ScreenModel => {
    const rows = state.geometry?.rows ?? 0;
    const visible = outputLines.slice(-rows);
    return {
      rows: visible,
      cursorRow: visible.length - 1,
      cursorCol: visible.at(-1)?.length ?? 0,
    };
  };

  const deliver = (data: string) =>
    new Promise<void>((resolve) => {
      pendingDrains.push(resolve);
      for (const subscriber of dataSubscribers) subscriber({ ptyId, data });
    });

  const terminal = {
    create: vi.fn(async (request: { cols: number; rows: number }) => {
      state.geometry = { cols: request.cols, rows: request.rows };
      return { ok: true as const, ptyId };
    }),
    start: vi.fn(async () => ({ ok: true as const, replay: '' })),
    adopt: vi.fn(async () =>
      state.replay === null
        ? { ok: false as const, reason: 'unknown-session' as const }
        : { ok: true as const, replay: state.replay },
    ),
    input: vi.fn(),
    resize: vi.fn((_id: string, cols: number, rows: number) => {
      const previous = state.geometry ?? { cols, rows };
      const before = screen();
      state.geometry = { cols, rows };
      const repaint = host.repaintAfterResize(previous, { cols, rows }, before);
      if (repaint !== '') repaints.push(deliver(repaint));
    }),
    kill: vi.fn(async () => {}),
    drain: vi.fn(() => {
      pendingDrains.shift()?.();
    }),
    onData: vi.fn((subscriber: (message: OkPtyData) => void) => {
      dataSubscribers.push(subscriber);
      return () => {};
    }),
    onExit: vi.fn(() => () => {}),
    onNotice: vi.fn(() => () => {}),
    claudePreflight: vi.fn(async () => ({ claude: 'present' as const })),
    cliPreflight: vi.fn(async () => ({ onPath: 'present' as const })),
  };

  const bridge = {
    terminal,
    shell: {
      openExternal: vi.fn(async () => {}),
      openAsset: vi.fn(async () => ({ ok: true })),
      revealAsset: vi.fn(async () => ({ ok: true })),
      revealExternal: vi.fn(async () => ({ ok: true, outcome: 'revealed' })),
    },
    project: { checkTargetExists: vi.fn(async () => 'exists' as const) },
    config: { e2eSmoke: true, projectPath: '/project' },
    platform: host.platform,
    getPathForFile: () => null,
  } as unknown as OkDesktopBridge;

  const record = (text: string) => {
    const [first = '', ...rest] = text.split('\r\n');
    outputLines[outputLines.length - 1] += first;
    outputLines.push(...rest);
  };

  const print = async (text: string) => {
    record(text);
    await act(() => deliver(text));
  };

  const holdForAdoption = (text: string, geometry: Geometry) => {
    record(text);
    state.replay = text;
    state.geometry = geometry;
  };

  return {
    bridge,
    ptyId,
    terminal,
    get geometry() {
      return state.geometry;
    },
    print,
    holdForAdoption,
    repaintsDelivered: () => Promise.all(repaints),
    get outputLines(): readonly string[] {
      return outputLines;
    },
  };
}

function scrollbackFixture(token: string, prompt: string) {
  const sentinel = `SENTINEL_${token}`;
  const scrollStart = `SCROLL_START_${token}`;
  const scrollLines = Array.from(
    { length: SCROLL_LINE_COUNT },
    (_, index) => `SCROLL_${token}_${String(index + 1).padStart(3, '0')}`,
  );
  const history = [sentinel, scrollStart, ...scrollLines];
  const transcript = [`${prompt}print-scrollback-fixture`, ...history, prompt].join('\r\n');
  const historyLine = new RegExp(`^(?:SENTINEL|SCROLL_START|SCROLL)_${token}(?:_\\d+)?$`);
  return { history, transcript, historyLine };
}

function bufferLines(term: XtermTerminal): string[] {
  const buffer = term.buffer.active;
  return Array.from(
    { length: buffer.length },
    (_, index) => buffer.getLine(index)?.translateToString(true) ?? '',
  );
}

function viewportLines(term: XtermTerminal): string[] {
  const buffer = term.buffer.active;
  return Array.from(
    { length: term.rows },
    (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '',
  );
}

interface BufferRow {
  readonly text: string;
  readonly wrapped: boolean;
}

function bufferRows(term: XtermTerminal): BufferRow[] {
  const buffer = term.buffer.active;
  return Array.from({ length: buffer.length }, (_, index) => {
    const line = buffer.getLine(index);
    return { text: line?.translateToString(true) ?? '', wrapped: line?.isWrapped ?? false };
  });
}

function filledLine(label: string, length: number): string {
  return `${label}${'0123456789'.repeat(Math.ceil(length / 10))}`.slice(0, length);
}

function rowsOfWidth(line: string, cols: number): string[] {
  return Array.from({ length: Math.ceil(line.length / cols) }, (_, index) =>
    line.slice(index * cols, (index + 1) * cols),
  );
}

type SessionEstablishment = 'created' | 'adopted';

async function mountTerminalWithHistory(host: ModelledHost, establishment: SessionEstablishment) {
  const token = randomUUID().replaceAll('-', '');
  const session = hostSession(host, token);
  const fixture = scrollbackFixture(token, host.prompt);
  if (establishment === 'adopted') session.holdForAdoption(fixture.transcript, DOCK_GEOMETRY);
  render(
    <TerminalPanel
      bridge={session.bridge}
      adoptPtyId={establishment === 'adopted' ? session.ptyId : null}
    />,
  );

  await waitFor(() => {
    expect(constructedTerminals).toHaveLength(1);
    expect(document.querySelector('[data-terminal-status="running"]')).not.toBeNull();
  });
  const term = constructedTerminals[0];
  if (term === undefined) throw new Error('TerminalPanel constructed no xterm Terminal');

  const containerObserver = () => {
    const observer = resizeObservers.find(
      (candidate) =>
        !candidate.disconnected &&
        candidate.targets.some((target) => target.matches('[data-terminal-status]')),
    );
    if (observer === undefined) throw new Error('TerminalPanel observes no terminal container');
    return observer;
  };

  const layOut = async (geometry: Geometry) => {
    laidOut.geometry = geometry;
    await act(async () => {
      containerObserver().callback([
        { contentRect: { width: geometry.cols, height: geometry.rows } },
      ]);
    });
    await waitFor(() => {
      expect(term.rows).toBe(geometry.rows);
      expect(session.geometry).toEqual(geometry);
    });
    await session.repaintsDelivered();
  };

  await layOut(DOCK_GEOMETRY);
  if (establishment === 'created') await session.print(fixture.transcript);

  return { ...fixture, term, session, layOut };
}

describe.each([
  { growth: 'the dock dragged taller', grown: TALLER_DOCK_GEOMETRY },
  { growth: 'a move to the right column', grown: COLUMN_GEOMETRY },
])('TerminalPanel row growth on a ConPTY-hosted shell (win32, $growth)', ({ grown }) => {
  test.each([{ establishment: 'created' as const }, { establishment: 'adopted' as const }])(
    'growing the terminal keeps every scrollback line exactly once, in order, after the host repaints its view ($establishment session)',
    async ({ establishment }) => {
      const { history, historyLine, term, layOut } = await mountTerminalWithHistory(
        conptyHost,
        establishment,
      );

      expect(
        bufferLines(term).filter((line) => historyLine.test(line)),
        'the scrollback held every emitted line before the resize',
      ).toEqual(history);
      expect(
        term.buffer.active.baseY,
        'the dock-sized terminal holds more scrollback than the growth can pull back into view',
      ).toBeGreaterThan(grown.rows - DOCK_GEOMETRY.rows);

      await layOut(grown);

      expect(
        bufferLines(term).filter((line) => historyLine.test(line)),
        'a row-growing resize on a ConPTY host lost or duplicated scrollback',
      ).toEqual(history);
    },
  );
});

describe('TerminalPanel line wrapping on a ConPTY-hosted shell (win32)', () => {
  test('narrowing the terminal reflows a line longer than the new width into wrapped rows', async () => {
    const { term, session, layOut } = await mountTerminalWithHistory(conptyHost, 'created');
    const label = `REFLOW_${randomUUID().replaceAll('-', '')}_`;
    const longLine = filledLine(label, DOCK_GEOMETRY.cols - 1);
    await session.print(`\r\n${longLine}\r\n${conptyHost.prompt}`);
    expect(
      bufferRows(term).filter((row) => row.text.startsWith(label)),
      'the dock-width terminal holds the long line on one unwrapped row',
    ).toEqual([{ text: longLine, wrapped: false }]);

    await layOut(NARROWED_DOCK_GEOMETRY);
    expect(term.cols, 'the terminal narrowed to the laid-out width').toBe(
      NARROWED_DOCK_GEOMETRY.cols,
    );

    const rows = bufferRows(term);
    const firstRow = rows.findIndex((row) => row.text.startsWith(label));
    const reflowed: BufferRow[] = [
      ...rowsOfWidth(longLine, NARROWED_DOCK_GEOMETRY.cols).map((text, index) => ({
        text,
        wrapped: index > 0,
      })),
      { text: conptyHost.prompt, wrapped: false },
    ];
    expect(
      rows.slice(firstRow, firstRow + reflowed.length),
      'the long line reflowed into wrapped rows of the narrower width, ending before the prompt',
    ).toEqual(reflowed);
  });

  test('a full-width line followed by a line break leaves the next row unwrapped', async () => {
    const { term, session } = await mountTerminalWithHistory(conptyHost, 'created');
    const token = randomUUID().replaceAll('-', '');
    const fullWidthLine = filledLine(`FULL_${token}_`, term.cols);
    const nextLine = `NEXT_${token}`;
    await session.print(`\r\n${fullWidthLine}\r\n${nextLine}\r\n${conptyHost.prompt}`);

    const rows = bufferRows(term);
    const fullWidthRow = rows.findIndex((row) => row.text === fullWidthLine);
    expect(fullWidthRow, 'the full-width line filled exactly one row').toBeGreaterThanOrEqual(0);
    expect(
      rows.slice(fullWidthRow, fullWidthRow + 2),
      'the row after a full-width line and a line break is not marked as its continuation',
    ).toEqual([
      { text: fullWidthLine, wrapped: false },
      { text: nextLine, wrapped: false },
    ]);
  });
});

describe.each([{ platform: 'darwin' as const }, { platform: 'linux' as const }])(
  'TerminalPanel row growth on a Unix pty ($platform)',
  ({ platform }) => {
    test('growing the terminal brings the most recent scrollback back into view above the prompt', async () => {
      const { history, historyLine, term, session, layOut } = await mountTerminalWithHistory(
        unixPtyHost(platform),
        'created',
      );
      await layOut(TALLER_DOCK_GEOMETRY);

      expect(
        bufferLines(term).filter((line) => historyLine.test(line)),
        'a row-growing resize on a Unix pty lost or duplicated scrollback',
      ).toEqual(history);
      expect(
        viewportLines(term),
        'the grown viewport shows the latest output with the prompt on its bottom row',
      ).toEqual(session.outputLines.slice(-TALLER_DOCK_GEOMETRY.rows));
    });
  },
);
