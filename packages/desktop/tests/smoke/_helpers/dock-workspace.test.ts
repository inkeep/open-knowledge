import { stripVTControlCharacters } from 'node:util';
import type { Page } from '@playwright/test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  expectStoredDockArrangementChanged,
  readTerminalHome,
  type StoredDockArrangement,
  storedDockArrangement,
  storedDockArrangementsProbe,
  type TerminalHome,
  terminalHomeProbe,
} from './dock-workspace';
import { settleBudget } from './settled-reading';

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface FakeElement {
  readonly visibility: string;
  readonly textContent: string | null;
  checkVisibility(): boolean;
  getBoundingClientRect(): Box & { readonly right: number; readonly bottom: number };
  getAttribute(name: string): string | null;
  querySelector(selector: string): FakeElement | null;
  querySelectorAll(selector: string): readonly FakeElement[];
}

interface FakeElementSpec {
  readonly box?: Box;
  readonly displayed?: boolean;
  readonly visibility?: 'visible' | 'hidden';
  readonly attributes?: Readonly<Record<string, string>>;
  readonly descendants?: Readonly<Record<string, readonly FakeElement[]>>;
  readonly textContent?: string;
}

interface SessionSpec {
  readonly shown: boolean;
  readonly rows: string;
}

type TerminalUnitSpec = { readonly box: Box; readonly state: 'shown' | 'off' } | 'never';

interface WorkspaceSpec {
  readonly editor: Box | 'off';
  readonly terminal: TerminalUnitSpec;
  readonly placement: TerminalHome;
  readonly sessions?: readonly SessionSpec[];
}

const ZERO: Box = { left: 0, top: 0, width: 0, height: 0 };
const EDITOR_BESIDE_RIGHT: Box = { left: 0, top: 0, width: 1200, height: 860 };
const RIGHT_TERMINAL: Box = { left: 1208, top: 0, width: 500, height: 860 };
const EDITOR_ABOVE_BOTTOM: Box = { left: 0, top: 0, width: 1400, height: 560 };
const BOTTOM_TERMINAL: Box = { left: 0, top: 568, width: 1400, height: 292 };
const LIVE_SESSION: SessionSpec = { shown: true, rows: '% echo ready' };
const DECLARED_BOUND_MS = 300;
const MOVED_ARRANGEMENT: StoredDockArrangement = {
  key: 'ok-dock-arrangement-v1:3f2a',
  value: '{"moved":true}',
};
const RESIZED_ARRANGEMENT: StoredDockArrangement = {
  key: MOVED_ARRANGEMENT.key,
  value: '{"resized":true}',
};

function fakeElement({
  box = ZERO,
  displayed = true,
  visibility = 'visible',
  attributes = {},
  descendants = {},
  textContent,
}: FakeElementSpec = {}): FakeElement {
  return {
    visibility,
    textContent: textContent ?? null,
    checkVisibility: () => displayed,
    getBoundingClientRect: () => ({
      ...box,
      right: box.left + box.width,
      bottom: box.top + box.height,
    }),
    getAttribute: (name) => attributes[name] ?? null,
    querySelector: (selector) => descendants[selector]?.[0] ?? null,
    querySelectorAll: (selector) => descendants[selector] ?? [],
  };
}

function mountWorkspace({
  editor,
  terminal,
  placement,
  sessions = [LIVE_SESSION],
}: WorkspaceSpec): void {
  const terminalVisibility =
    terminal !== 'never' && terminal.state === 'off' ? 'hidden' : 'visible';
  const sectionElements = sessions.map(({ shown, rows }) =>
    fakeElement({
      box: shown && terminal !== 'never' ? { left: 0, top: 44, width: 400, height: 200 } : ZERO,
      displayed: shown && terminal !== 'never',
      visibility: terminalVisibility,
      descendants: { '.xterm-rows': [fakeElement({ textContent: rows })] },
    }),
  );
  const terminalUnit = fakeElement({
    box: terminal === 'never' ? ZERO : terminal.box,
    displayed: terminal !== 'never',
    visibility: terminalVisibility,
    descendants: {
      '[data-slot="pane-card"][data-pane="terminal"]': [
        fakeElement({ attributes: { 'data-placement': placement } }),
      ],
      'section[aria-label="Terminal"]': sectionElements,
    },
  });
  const editorUnit = fakeElement({
    box: editor === 'off' ? EDITOR_ABOVE_BOTTOM : editor,
    visibility: editor === 'off' ? 'hidden' : 'visible',
  });
  const units: Readonly<Record<string, FakeElement>> = {
    '[data-dock-unit="terminal"]': terminalUnit,
    '[data-dock-unit="editor"]': editorUnit,
  };
  vi.stubGlobal('document', { querySelector: (selector: string) => units[selector] ?? null });
  vi.stubGlobal('getComputedStyle', (element: FakeElement) => ({
    visibility: element.visibility,
  }));
}

function pageRunning(probe: (settledAt: TerminalHome | null) => unknown): Page {
  return {
    evaluate: (run: typeof terminalHomeProbe, settledAt: TerminalHome | null) =>
      Promise.resolve(run === terminalHomeProbe ? probe(settledAt) : undefined),
  } as unknown as Page;
}

function pageStoring(...readings: ReadonlyArray<readonly StoredDockArrangement[]>): Page {
  let reads = 0;
  return {
    evaluate: (run: unknown) => {
      if (run !== storedDockArrangementsProbe) {
        return Promise.reject(new Error('the page was asked to run another probe'));
      }
      const reading = readings[Math.min(reads, readings.length - 1)] ?? [];
      reads += 1;
      return Promise.resolve(reading);
    },
  } as unknown as Page;
}

async function rejectionOf(run: Promise<unknown>): Promise<string> {
  return run.then(
    () => {
      throw new Error('the wait resolved where it had to reject');
    },
    (error: unknown) =>
      stripVTControlCharacters(error instanceof Error ? error.message : String(error)),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('terminal home probe', () => {
  test('reads a terminal under the editor and as wide as it as the bottom home', () => {
    mountWorkspace({
      editor: EDITOR_ABOVE_BOTTOM,
      terminal: { box: BOTTOM_TERMINAL, state: 'shown' },
      placement: 'bottom',
    });

    expect(terminalHomeProbe(null)).toEqual({
      placement: 'bottom',
      geometry: 'bottom',
      painted: true,
    });
  });

  test('reads a terminal after the editor and as tall as it as the right home', () => {
    mountWorkspace({
      editor: EDITOR_BESIDE_RIGHT,
      terminal: { box: RIGHT_TERMINAL, state: 'shown' },
      placement: 'right',
    });

    expect(terminalHomeProbe(null)).toEqual({
      placement: 'right',
      geometry: 'right',
      painted: true,
    });
  });

  test('gives no home to a terminal that sits below the editor without spanning it', () => {
    mountWorkspace({
      editor: EDITOR_ABOVE_BOTTOM,
      terminal: { box: { ...BOTTOM_TERMINAL, width: 900 }, state: 'shown' },
      placement: 'bottom',
    });

    expect(terminalHomeProbe(null)).toMatchObject({ placement: 'bottom', geometry: null });
  });

  test('gives no home to a terminal that sits beside the editor at another height', () => {
    mountWorkspace({
      editor: EDITOR_BESIDE_RIGHT,
      terminal: { box: { ...RIGHT_TERMINAL, height: 600 }, state: 'shown' },
      placement: 'right',
    });

    expect(terminalHomeProbe(null)).toMatchObject({ placement: 'right', geometry: null });
  });

  test('a terminal turned off keeps its last rect but has no home and nothing painted', () => {
    mountWorkspace({
      editor: EDITOR_ABOVE_BOTTOM,
      terminal: { box: BOTTOM_TERMINAL, state: 'off' },
      placement: 'bottom',
    });

    expect(terminalHomeProbe(null)).toEqual({
      placement: 'bottom',
      geometry: null,
      painted: false,
    });
  });

  test('a terminal that was never shown has no home', () => {
    mountWorkspace({ editor: EDITOR_ABOVE_BOTTOM, terminal: 'never', placement: 'bottom' });

    expect(terminalHomeProbe(null)).toEqual({
      placement: 'bottom',
      geometry: null,
      painted: false,
    });
  });

  test('without the editor on screen the terminal has no home to be measured against', () => {
    mountWorkspace({
      editor: 'off',
      terminal: { box: BOTTOM_TERMINAL, state: 'shown' },
      placement: 'bottom',
    });

    expect(terminalHomeProbe(null)).toMatchObject({ geometry: null, painted: true });
  });

  test('counts only a shown session with output as painted', () => {
    mountWorkspace({
      editor: EDITOR_ABOVE_BOTTOM,
      terminal: { box: BOTTOM_TERMINAL, state: 'shown' },
      placement: 'bottom',
      sessions: [
        { shown: false, rows: '% echo hidden tab' },
        { shown: true, rows: '' },
      ],
    });

    expect(terminalHomeProbe(null)).toMatchObject({ painted: false });
  });

  test('settles at a home only when the placement, the geometry and the paint all agree on it', () => {
    mountWorkspace({
      editor: EDITOR_ABOVE_BOTTOM,
      terminal: { box: BOTTOM_TERMINAL, state: 'shown' },
      placement: 'right',
    });
    expect(terminalHomeProbe('right')).toBe(false);
    expect(terminalHomeProbe('bottom')).toBe(false);

    mountWorkspace({
      editor: EDITOR_BESIDE_RIGHT,
      terminal: { box: RIGHT_TERMINAL, state: 'shown' },
      placement: 'right',
      sessions: [{ shown: true, rows: '' }],
    });
    expect(terminalHomeProbe('right')).toBe(false);

    mountWorkspace({
      editor: EDITOR_BESIDE_RIGHT,
      terminal: { box: RIGHT_TERMINAL, state: 'shown' },
      placement: 'right',
    });
    expect(terminalHomeProbe('right')).toEqual({
      placement: 'right',
      geometry: 'right',
      painted: true,
    });
  });
});

describe('terminal home read', () => {
  test('returns what the probe reads in the renderer', async () => {
    mountWorkspace({
      editor: EDITOR_BESIDE_RIGHT,
      terminal: { box: RIGHT_TERMINAL, state: 'shown' },
      placement: 'right',
    });

    await expect(readTerminalHome(pageRunning(terminalHomeProbe))).resolves.toEqual({
      placement: 'right',
      geometry: 'right',
      painted: true,
    });
  });

  test('refuses a renderer that answers a plain read with false', async () => {
    await expect(readTerminalHome(pageRunning(() => false))).rejects.toThrow(
      /different probe than this module ships/u,
    );
  });
});

describe('stored dock arrangements probe', () => {
  test('lists every project arrangement in storage order and nothing else', () => {
    const entries: ReadonlyArray<readonly [string, string]> = [
      ['ok-dock-arrangement-v1:3f2a', '{"pane":"editor"}'],
      ['ok-terminal-placement-v1', 'right'],
      ['ok-dock-arrangement-v1:91c0', 'not a tree'],
      ['ok-dock-arrangement-v2:91c0', 'another version'],
    ];
    vi.stubGlobal('localStorage', {
      get length() {
        return entries.length;
      },
      key: (index: number) => entries[index]?.[0] ?? null,
      getItem: (key: string) => entries.find(([name]) => name === key)?.[1] ?? null,
    });

    expect(storedDockArrangementsProbe()).toEqual([
      { key: 'ok-dock-arrangement-v1:3f2a', value: '{"pane":"editor"}' },
      { key: 'ok-dock-arrangement-v1:91c0', value: 'not a tree' },
    ]);
  });
});

describe('stored dock arrangement of the open project', () => {
  test('resolves the one stored arrangement once the project writes it', async () => {
    await expect(
      storedDockArrangement(pageStoring([], [MOVED_ARRANGEMENT]), {
        timeout: DECLARED_BOUND_MS * 10,
      }),
    ).resolves.toEqual(MOVED_ARRANGEMENT);
  });

  test('refuses a project that keeps two stored arrangements, naming the count it read', async () => {
    const message = await rejectionOf(
      storedDockArrangement(
        pageStoring([MOVED_ARRANGEMENT, { key: 'ok-dock-arrangement-v1:91c0', value: '{}' }]),
        {
          timeout: DECLARED_BOUND_MS,
        },
      ),
    );

    expect(message).toMatch(/stored arrangement count of the project dock arrangement/u);
    expect(message).toMatch(/Received: 2\b/u);
  });

  test('settles once the arrangement stored under the same key changes', async () => {
    await expect(
      expectStoredDockArrangementChanged(
        pageStoring([MOVED_ARRANGEMENT], [RESIZED_ARRANGEMENT]),
        MOVED_ARRANGEMENT,
        settleBudget('stored arrangement change', { timeout: DECLARED_BOUND_MS * 10 }),
      ),
    ).resolves.toBeUndefined();
  });

  test('refuses a stored arrangement that never changes', async () => {
    const message = await rejectionOf(
      expectStoredDockArrangementChanged(
        pageStoring([MOVED_ARRANGEMENT]),
        MOVED_ARRANGEMENT,
        settleBudget('stored arrangement change', { timeout: DECLARED_BOUND_MS }),
      ),
    );

    expect(message).toMatch(/stored arrangement of ok-dock-arrangement-v1:3f2a never settled/u);
  });

  test('refuses a change that lands under another project key', async () => {
    const message = await rejectionOf(
      expectStoredDockArrangementChanged(
        pageStoring([{ key: 'ok-dock-arrangement-v1:91c0', value: RESIZED_ARRANGEMENT.value }]),
        MOVED_ARRANGEMENT,
        settleBudget('stored arrangement change', { timeout: DECLARED_BOUND_MS }),
      ),
    );

    expect(message).toMatch(/never settled/u);
    expect(message).toContain('ok-dock-arrangement-v1:91c0');
  });
});
