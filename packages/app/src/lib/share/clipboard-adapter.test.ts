
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { isPermissionsPolicyRefusal, scheduleClipboardWrite } from './clipboard-adapter';

interface MockableGlobals {
  windowOkDesktop: { clipboard: { writeText: (text: string) => Promise<void> } } | undefined;
  navigatorClipboardWriteText: ((text: string) => Promise<void>) | undefined;
}

function captureGlobals(): MockableGlobals {
  const win = globalThis as unknown as {
    okDesktop?: MockableGlobals['windowOkDesktop'];
  };
  const nav = globalThis as unknown as {
    navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> } };
  };
  return {
    windowOkDesktop: win.okDesktop,
    navigatorClipboardWriteText: nav.navigator?.clipboard?.writeText,
  };
}

function setGlobals(g: MockableGlobals): void {
  const win = globalThis as unknown as {
    okDesktop?: MockableGlobals['windowOkDesktop'];
  };
  if (g.windowOkDesktop) win.okDesktop = g.windowOkDesktop;
  else delete win.okDesktop;

  const navHolder = globalThis as unknown as {
    navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> } };
  };
  const clip: { writeText?: typeof g.navigatorClipboardWriteText } = {};
  if (g.navigatorClipboardWriteText) clip.writeText = g.navigatorClipboardWriteText;
  if (!navHolder.navigator) {
    (navHolder as { navigator: { clipboard: typeof clip } }).navigator = { clipboard: clip };
  } else {
    navHolder.navigator.clipboard = clip;
  }
}

let savedGlobals: MockableGlobals;

beforeEach(() => {
  savedGlobals = captureGlobals();
});

afterEach(() => {
  setGlobals(savedGlobals);
});

describe('scheduleClipboardWrite — Electron IPC bridge path (preferred when available)', () => {
  test('routes the URL through window.okDesktop.clipboard.writeText', async () => {
    const calls: string[] = [];
    setGlobals({
      windowOkDesktop: {
        clipboard: {
          writeText: async (text) => {
            calls.push(text);
          },
        },
      },
      navigatorClipboardWriteText: undefined,
    });

    await scheduleClipboardWrite('https://openknowledge.ai/d/AAA');
    expect(calls).toEqual(['https://openknowledge.ai/d/AAA']);
  });

  test('does NOT touch navigator.clipboard when okDesktop bridge is available', async () => {
    const navWriteText = mock(async () => undefined);
    setGlobals({
      windowOkDesktop: {
        clipboard: { writeText: async () => undefined },
      },
      navigatorClipboardWriteText: navWriteText,
    });

    await scheduleClipboardWrite('https://openknowledge.ai/d/AAA');
    expect(navWriteText).not.toHaveBeenCalled();
  });

  test('propagates the bridge rejection when Electron IPC fails', async () => {
    setGlobals({
      windowOkDesktop: {
        clipboard: {
          writeText: async () => {
            throw new Error('ipc-channel-closed');
          },
        },
      },
      navigatorClipboardWriteText: undefined,
    });

    await expect(scheduleClipboardWrite('https://openknowledge.ai/d/AAA')).rejects.toThrow(
      /ipc-channel-closed/,
    );
  });
});

describe('scheduleClipboardWrite — navigator.clipboard.writeText fallback', () => {
  test('writes the URL via writeText when the Electron bridge is absent', async () => {
    const calls: string[] = [];
    setGlobals({
      windowOkDesktop: undefined,
      navigatorClipboardWriteText: async (text) => {
        calls.push(text);
      },
    });

    await scheduleClipboardWrite('https://openknowledge.ai/d/BBB');
    expect(calls).toEqual(['https://openknowledge.ai/d/BBB']);
  });

  test('propagates the writeText rejection (e.g. NotAllowedError)', async () => {
    setGlobals({
      windowOkDesktop: undefined,
      navigatorClipboardWriteText: async () => {
        throw new Error('NotAllowedError: clipboard denied');
      },
    });

    await expect(scheduleClipboardWrite('https://openknowledge.ai/d/BBB')).rejects.toThrow(
      /NotAllowedError|clipboard denied/,
    );
  });
});

describe('isPermissionsPolicyRefusal', () => {
  test('matches NotAllowedError with "permission denied" wording (Chrome / Edge)', () => {
    const error = new Error(
      "Failed to execute 'writeText' on 'Clipboard': Write permission denied.",
    );
    error.name = 'NotAllowedError';
    expect(isPermissionsPolicyRefusal(error)).toBe(true);
  });

  test('matches case-insensitively', () => {
    const error = new Error('Write Permission Denied.');
    error.name = 'NotAllowedError';
    expect(isPermissionsPolicyRefusal(error)).toBe(true);
  });

  test('does NOT match NotAllowedError without "permission denied" (activation expiry)', () => {
    const error = new Error('Document is not focused.');
    error.name = 'NotAllowedError';
    expect(isPermissionsPolicyRefusal(error)).toBe(false);
  });

  test('does NOT match a different error name even with matching message', () => {
    const error = new Error('Write permission denied.');
    error.name = 'SecurityError';
    expect(isPermissionsPolicyRefusal(error)).toBe(false);
  });

  test('does NOT match non-Error values', () => {
    expect(isPermissionsPolicyRefusal('Write permission denied')).toBe(false);
    expect(isPermissionsPolicyRefusal(null)).toBe(false);
    expect(isPermissionsPolicyRefusal(undefined)).toBe(false);
    expect(
      isPermissionsPolicyRefusal({ name: 'NotAllowedError', message: 'permission denied' }),
    ).toBe(false);
  });
});

describe('scheduleClipboardWrite — no clipboard API available', () => {
  test('throws "clipboard API unavailable" when no platform path is supported', async () => {
    setGlobals({
      windowOkDesktop: undefined,
      navigatorClipboardWriteText: undefined,
    });

    await expect(scheduleClipboardWrite('https://openknowledge.ai/d/ZZZ')).rejects.toThrow(
      /clipboard API unavailable/,
    );
  });
});

describe('isPermissionsPolicyRefusal — Chromium permissions-policy wording', () => {
  test('matches "blocked because of a permissions policy" (current Chromium iframe block)', () => {
    const error = new Error(
      "Failed to execute 'writeText' on 'Clipboard': The Clipboard API has been blocked because of a permissions policy applied to the current document.",
    );
    error.name = 'NotAllowedError';
    expect(isPermissionsPolicyRefusal(error)).toBe(true);
  });
});

describe('scheduleClipboardWrite — document.execCommand("copy") fallback', () => {
  interface FakeTextArea {
    value: string;
    style: Record<string, string>;
    attributes: Record<string, string>;
    focused: boolean;
    selected: boolean;
    removed: boolean;
    setAttribute(name: string, value: string): void;
    focus(): void;
    select(): void;
    remove(): void;
  }

  function makeFakeDocument(opts: { execResult?: boolean; execThrows?: boolean } = {}) {
    const created: FakeTextArea[] = [];
    const appended: FakeTextArea[] = [];
    const execCalls: string[] = [];
    const doc = {
      activeElement: null,
      body: {
        appendChild(el: FakeTextArea) {
          appended.push(el);
        },
      },
      createElement(_tag: string): FakeTextArea {
        const ta: FakeTextArea = {
          value: '',
          style: {},
          attributes: {},
          focused: false,
          selected: false,
          removed: false,
          setAttribute(name, value) {
            ta.attributes[name] = value;
          },
          focus() {
            ta.focused = true;
          },
          select() {
            ta.selected = true;
          },
          remove() {
            ta.removed = true;
          },
        };
        created.push(ta);
        return ta;
      },
      execCommand(command: string): boolean {
        execCalls.push(command);
        if (opts.execThrows) throw new Error('execCommand exploded');
        return opts.execResult ?? true;
      },
    };
    return { doc, created, appended, execCalls };
  }

  function policyRefusal(): Error {
    const error = new Error(
      "Failed to execute 'writeText' on 'Clipboard': The Clipboard API has been blocked because of a permissions policy applied to the current document.",
    );
    error.name = 'NotAllowedError';
    return error;
  }

  let savedDocument: unknown;
  const docHolder = globalThis as { document?: unknown };

  beforeEach(() => {
    savedDocument = docHolder.document;
  });

  afterEach(() => {
    if (savedDocument === undefined) delete docHolder.document;
    else docHolder.document = savedDocument;
  });

  test('writeText rejection falls back to execCommand and resolves', async () => {
    const { doc, created, execCalls } = makeFakeDocument({ execResult: true });
    docHolder.document = doc;
    setGlobals({
      windowOkDesktop: undefined,
      navigatorClipboardWriteText: async () => {
        throw policyRefusal();
      },
    });

    await scheduleClipboardWrite('https://openknowledge.ai/d/CCC');

    expect(execCalls).toEqual(['copy']);
    expect(created).toHaveLength(1);
    expect(created[0]?.value).toBe('https://openknowledge.ai/d/CCC');
    expect(created[0]?.selected).toBe(true);
    expect(created[0]?.removed).toBe(true);
  });

  test('missing navigator.clipboard falls back to execCommand and resolves', async () => {
    const { doc, execCalls } = makeFakeDocument({ execResult: true });
    docHolder.document = doc;
    setGlobals({
      windowOkDesktop: undefined,
      navigatorClipboardWriteText: undefined,
    });

    await scheduleClipboardWrite('https://openknowledge.ai/d/DDD');
    expect(execCalls).toEqual(['copy']);
  });

  test('execCommand returning false rejects with the ORIGINAL writeText error', async () => {
    const { doc } = makeFakeDocument({ execResult: false });
    docHolder.document = doc;
    setGlobals({
      windowOkDesktop: undefined,
      navigatorClipboardWriteText: async () => {
        throw policyRefusal();
      },
    });

    await expect(scheduleClipboardWrite('https://openknowledge.ai/d/EEE')).rejects.toThrow(
      /permissions policy/,
    );
  });

  test('execCommand throwing rejects with the original writeText error', async () => {
    const { doc, created } = makeFakeDocument({ execThrows: true });
    docHolder.document = doc;
    setGlobals({
      windowOkDesktop: undefined,
      navigatorClipboardWriteText: async () => {
        throw policyRefusal();
      },
    });

    await expect(scheduleClipboardWrite('https://openknowledge.ai/d/FFF')).rejects.toThrow(
      /permissions policy/,
    );
    expect(created[0]?.removed).toBe(true);
  });

  test('no document available + writeText rejects → original error propagates', async () => {
    delete docHolder.document;
    setGlobals({
      windowOkDesktop: undefined,
      navigatorClipboardWriteText: async () => {
        throw policyRefusal();
      },
    });

    await expect(scheduleClipboardWrite('https://openknowledge.ai/d/GGG')).rejects.toThrow(
      /permissions policy/,
    );
  });

  test('okDesktop bridge path never touches execCommand', async () => {
    const { doc, execCalls } = makeFakeDocument({ execResult: true });
    docHolder.document = doc;
    setGlobals({
      windowOkDesktop: { clipboard: { writeText: async () => undefined } },
      navigatorClipboardWriteText: undefined,
    });

    await scheduleClipboardWrite('https://openknowledge.ai/d/HHH');
    expect(execCalls).toEqual([]);
  });
});
