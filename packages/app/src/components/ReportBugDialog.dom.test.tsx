import type {
  OkBugReportCrashDetectedEvent,
  OkBugReportCreateResult,
  OkBugReportScreenshot,
  OkBugReportSendResult,
  ReportBundleSummary,
} from '@inkeep/open-knowledge-core';
import type { OkBugReportSendInput } from '@inkeep/open-knowledge-core/desktop-bridge';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { bugReportSendManager } from '@/lib/bug-report-send-manager';
import { installPointerPositionTracker } from '@/lib/pointer-position';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
    <>{(value === 1 ? one : other).replace('#', String(value))}</>
  ),
  useLingui: () => ({ t: renderLinguiTemplate }),
  t: renderLinguiTemplate,
}));

type WindowGlobals = { NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (
  globalWithDomShims.NodeFilter === undefined &&
  globalWithDomShims.window?.NodeFilter !== undefined
) {
  globalWithDomShims.NodeFilter = globalWithDomShims.window.NodeFilter;
}
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}

const ZIP_PATH = '/Users/tester/.ok/bug-reports/2026-07-10T00-00-00-bugreport.zip';
const SUMMARY: ReportBundleSummary = {
  level: 'standard',
  systemWide: false,
  projectSlug: 'demo-project',
  files: ['sysinfo.json', 'local-logs/server-current.jsonl'],
  redactions: [],
  redactedLineCount: 0,
  generatedAt: '2026-07-10T00:00:00.000Z',
};
const CREATE_OK: OkBugReportCreateResult = {
  ok: true,
  zipPath: ZIP_PATH,
  zipSizeBytes: 7130316,
  summary: SUMMARY,
};
const SCREENSHOT: OkBugReportScreenshot = {
  dataUrl:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  width: 1200,
  height: 800,
};

type CreateRequest = {
  level: 'standard' | 'full';
  note?: string;
  includeCrashDump?: boolean;
  includeScreenshot?: boolean;
};
type SendRequest = OkBugReportSendInput;

interface BridgeLog {
  createCalls: CreateRequest[];
  sendCalls: SendRequest[];
  revealed: string[];
  opened: string[];
  clipboard: string[];
  screenshotCalls: number;
  crashDumpAvailabilityCalls: number;
}

function installBridge(
  handlers: {
    create?: (request: CreateRequest) => Promise<OkBugReportCreateResult>;
    send?: (request: SendRequest) => Promise<OkBugReportSendResult>;
    captureScreenshot?: () => Promise<OkBugReportScreenshot | null>;
    crashDumpAvailability?: () => Promise<{ available: boolean }>;
    platform?: string;
  } = {},
): BridgeLog {
  const log: BridgeLog = {
    createCalls: [],
    sendCalls: [],
    revealed: [],
    opened: [],
    clipboard: [],
    screenshotCalls: 0,
    crashDumpAvailabilityCalls: 0,
  };
  const bridge = {
    platform: handlers.platform ?? 'darwin',
    bugReport: {
      create: (request: CreateRequest) => {
        log.createCalls.push(request);
        return handlers.create ? handlers.create(request) : Promise.resolve(CREATE_OK);
      },
      send: (request: SendRequest) => {
        log.sendCalls.push(request);
        return handlers.send
          ? handlers.send(request)
          : Promise.resolve({ ok: true as const, reference: 'OK-8H3KQD' });
      },
      ...(handlers.captureScreenshot
        ? {
            captureScreenshot: () => {
              log.screenshotCalls += 1;
              return handlers.captureScreenshot?.() ?? Promise.resolve(null);
            },
          }
        : {}),
      ...(handlers.crashDumpAvailability
        ? {
            crashDumpAvailability: () => {
              log.crashDumpAvailabilityCalls += 1;
              return handlers.crashDumpAvailability?.() ?? Promise.resolve({ available: false });
            },
          }
        : {}),
    },
    shell: {
      showItemInFolder: (path: string) => {
        log.revealed.push(path);
        return Promise.resolve();
      },
      openExternal: (url: string) => {
        log.opened.push(url);
        return Promise.resolve();
      },
    },
    clipboard: {
      writeText: (text: string) => {
        log.clipboard.push(text);
        return Promise.resolve();
      },
    },
  };
  for (const host of [window, globalThis] as unknown as Array<Record<string, unknown>>) {
    Object.defineProperty(host, 'okDesktop', { configurable: true, writable: true, value: bridge });
  }
  return log;
}

function clearBridge() {
  for (const host of [window, globalThis] as unknown as Array<Record<string, unknown>>) {
    Object.defineProperty(host, 'okDesktop', {
      configurable: true,
      writable: true,
      value: undefined,
    });
  }
}

async function waitFrames(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });
  }
}

function movePointerTo(x: number, y: number): void {
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function renderDialog(
  props: {
    systemWide?: boolean;
    crashContext?: import('./ReportBugDialogBody').ReportBugCrashContext;
    crashInvite?: OkBugReportCrashDetectedEvent;
  } = {},
  options: { statefulOpen?: boolean } = {},
) {
  const { ReportBugDialog } = await import('./ReportBugDialog');
  const openChangeCalls: boolean[] = [];
  let setHostOpen: ((open: boolean) => void) | null = null;
  function Host() {
    const [open, setOpen] = useState(true);
    useEffect(() => {
      setHostOpen = setOpen;
    }, []);
    return (
      <TooltipProvider>
        <ReportBugDialog
          open={options.statefulOpen === true ? open : true}
          onOpenChange={(next) => {
            openChangeCalls.push(next);
            setOpen(next);
          }}
          {...props}
        />
      </TooltipProvider>
    );
  }
  render(<Host />);
  await screen.findByRole('dialog', {}, { timeout: 15_000 });
  return {
    openChangeCalls,
    reopen: () =>
      act(() => {
        setHostOpen?.(true);
      }),
  };
}

async function createReport(note?: string) {
  if (note !== undefined) {
    await userEvent.type(screen.getByRole('textbox', { name: /what happened/i }), note);
  }
  await userEvent.click(screen.getByRole('button', { name: 'Create report' }));
  await screen.findByRole('heading', { name: 'Review your report' });
}

describe('ReportBugDialog', () => {
  let stopPointerTracking: (() => void) | undefined;

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    stopPointerTracking?.();
    stopPointerTracking = undefined;
    await vi.waitFor(() => {
      expect(bugReportSendManager.getSnapshot().some((op) => op.status === 'sending')).toBe(false);
    });
    clearBridge();
    for (const el of document.querySelectorAll('[cmdk-root],[data-radix-popper-content-wrapper]')) {
      el.remove();
    }
  });

  test('compose state offers a labeled optional note, an always-on logs row, an off-by-default diagnostics checkbox, and the redaction note', async () => {
    installBridge();
    await renderDialog();

    expect(screen.getByRole('dialog')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Report a bug' })).not.toBeNull();
    expect(
      screen.getByText(
        "Tell us what went wrong and we'll gather the logs. Nothing leaves your computer until you've reviewed it.",
      ),
    ).not.toBeNull();

    const noteBox = screen.getByRole('textbox', { name: /what happened\? \(optional\)/i });
    expect(noteBox.getAttribute('placeholder')).toBe(
      'e.g. The editor froze after I pasted a large table',
    );

    expect(screen.getByText('What to include')).not.toBeNull();

    const logsCheckbox = screen.getByRole('checkbox', { name: /Logs & system info/ });
    expect(logsCheckbox.getAttribute('aria-checked')).toBe('true');
    expect(logsCheckbox.hasAttribute('disabled')).toBe(true);
    expect(
      screen.getByText(
        'App & system info, recent app logs, and project server logs: the essentials we need to reproduce the issue.',
      ),
    ).not.toBeNull();

    const checkbox = screen.getByRole('checkbox', { name: 'Detailed diagnostics' });
    expect(checkbox.getAttribute('aria-checked')).toBe('false');
    expect(checkbox.hasAttribute('disabled')).toBe(false);
    expect(
      screen.getByText(
        'Adds telemetry, server state, and runtime info when available. Credentials are always removed; document names, if included, appear in cleartext (not redacted).',
        { exact: false },
      ),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "It also adds the crash reports macOS recorded for OpenKnowledge and its helper processes, only ours and never another app's.",
        { exact: false },
      ),
    ).not.toBeNull();

    expect(
      screen.getByText('Secrets like API keys and tokens are redacted automatically.'),
    ).not.toBeNull();

    expect(screen.getByRole('button', { name: 'Cancel' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Create report' })).not.toBeNull();
  });

  test('omits the macOS crash-report sentence off macOS', async () => {
    installBridge({ platform: 'win32' });
    await renderDialog();

    expect(
      screen.getByText('Adds telemetry, server state, and runtime info when available.', {
        exact: false,
      }),
    ).not.toBeNull();
    expect(screen.queryByText(/crash reports macOS recorded/)).toBeNull();
  });

  test('a system-wide report says up front that no project logs are included', async () => {
    installBridge();
    await renderDialog({ systemWide: true });

    expect(
      screen.getByText(
        "App & system info and recent app logs. No project is open, so project logs aren't included.",
      ),
    ).not.toBeNull();
  });

  test('creating a report builds a standard bundle with the note and shows the review card for the exact zip', async () => {
    const log = installBridge();
    await renderDialog();

    await createReport('The editor froze');

    expect(log.createCalls).toEqual([{ level: 'standard', note: 'The editor froze' }]);
    expect(
      screen.getByText("Take a look if you'd like. This exact file is what we receive."),
    ).not.toBeNull();
    expect(screen.getByText('2026-07-10T00-00-00-bugreport.zip')).not.toBeNull();
    expect(screen.getByText(/6\.8 MB · secrets redacted · 2 files/)).not.toBeNull();
    expect(
      screen.getByText(
        'Sent privately to the OpenKnowledge team, along with your note and app version. Never posted publicly.',
      ),
    ).not.toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }));
    expect(log.revealed).toEqual([ZIP_PATH]);
  });

  test('the detailed-diagnostics checkbox requests a full-level bundle', async () => {
    const log = installBridge();
    await renderDialog();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Detailed diagnostics' }));
    await createReport();

    expect(log.createCalls).toEqual([{ level: 'full', note: undefined }]);
  });

  test('back from review returns to compose with the note intact', async () => {
    installBridge();
    await renderDialog();
    await createReport('my draft note');

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));

    const noteBox = screen.getByRole('textbox', { name: /what happened/i });
    expect((noteBox as HTMLTextAreaElement).value).toBe('my draft note');
  });

  test('Send hands the reviewed zip to the background send manager and closes the dialog', async () => {
    const send = deferred<OkBugReportSendResult>();
    const log = installBridge({ send: () => send.promise });
    const { openChangeCalls } = await renderDialog({}, { statefulOpen: true });
    await createReport('upload me');

    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));

    expect(openChangeCalls).toEqual([false]);
    await vi.waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    expect(log.sendCalls).toEqual([
      {
        zipPath: ZIP_PATH,
        metadata: {
          level: 'standard',
          systemWide: false,
          projectSlug: 'demo-project',
          note: 'upload me',
        },
        includeScreenshot: false,
      },
    ]);

    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText('Uploading securely')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Sending report' })).toBeNull();

    await act(async () => {
      send.resolve({ ok: true, reference: 'OK-8H3KQD' });
      await Promise.resolve();
    });

    expect(screen.queryByDisplayValue('OK-8H3KQD')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test.each([
    [
      'a failed upload',
      {
        ok: false as const,
        reason: 'send-failed' as const,
        fallback: { mailtoUrl: 'mailto:support@inkeep.com?subject=OpenKnowledge%20bug' },
      },
    ],
    [
      'the no-intake email default',
      {
        ok: false as const,
        reason: 'email-draft' as const,
        fallback: { mailtoUrl: 'mailto:support@inkeep.com?subject=OpenKnowledge%20bug' },
      },
    ],
  ])('%s resolves outside the dialog — no terminal phase, no reopen, no draft', async (_, result) => {
    const log = installBridge({ send: () => Promise.resolve(result) });
    const { openChangeCalls } = await renderDialog({}, { statefulOpen: true });
    await createReport('still my note');

    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await vi.waitFor(() => {
      expect(log.sendCalls).toHaveLength(1);
    });

    expect(openChangeCalls).toEqual([false]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('heading', { name: "Couldn't send the report" })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Send your report by email' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Thanks for the report!' })).toBeNull();
    expect(log.opened).toEqual([]);
  });

  test('Escape closes the dialog from review, and review keeps its close button', async () => {
    installBridge();
    const { openChangeCalls } = await renderDialog({}, { statefulOpen: true });
    await createReport();

    expect(screen.getByRole('button', { name: 'Close' })).not.toBeNull();

    await userEvent.keyboard('{Escape}');

    expect(openChangeCalls).toEqual([false]);
    await vi.waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  test('a draft survives a non-Send close: the note and checkboxes come back on reopen', async () => {
    installBridge();
    const { reopen } = await renderDialog({}, { statefulOpen: true });
    await userEvent.type(
      screen.getByRole('textbox', { name: /what happened/i }),
      'half-written thought',
    );
    await userEvent.click(screen.getByRole('checkbox', { name: 'Detailed diagnostics' }));

    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    reopen();
    await screen.findByRole('dialog');

    expect(
      (screen.getByRole('textbox', { name: /what happened/i }) as HTMLTextAreaElement).value,
    ).toBe('half-written thought');
    expect(
      screen.getByRole('checkbox', { name: 'Detailed diagnostics' }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  test('sending spends the draft: reopening after a Send starts from an empty form', async () => {
    const log = installBridge();
    const { reopen } = await renderDialog({}, { statefulOpen: true });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Detailed diagnostics' }));
    await createReport('this one is going out');

    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await vi.waitFor(() => {
      expect(log.sendCalls).toHaveLength(1);
    });
    reopen();
    await screen.findByRole('dialog');

    expect(
      (screen.getByRole('textbox', { name: /what happened/i }) as HTMLTextAreaElement).value,
    ).toBe('');
    expect(
      screen.getByRole('checkbox', { name: 'Detailed diagnostics' }).getAttribute('aria-checked'),
    ).toBe('false');
    expect(screen.getByRole('heading', { name: 'Report a bug' })).not.toBeNull();
  });

  test('a crash context pre-checks detailed diagnostics and folds the context into the note on create and send', async () => {
    const log = installBridge();
    await renderDialog({
      crashContext: { source: 'document view', docName: 'alpha.md', errorMessage: 'boom' },
    });

    const checkbox = screen.getByRole('checkbox', { name: 'Detailed diagnostics' });
    expect(checkbox.getAttribute('aria-checked')).toBe('true');
    expect(
      screen.getByText(
        'Details about the error you just hit are included. Secrets like API keys and tokens are redacted automatically.',
      ),
    ).not.toBeNull();

    await createReport('It crashed while I typed');

    expect(log.createCalls).toEqual([
      {
        level: 'full',
        note: 'It crashed while I typed\n\nCrash source: document view\nDocument: alpha.md\nError: boom',
      },
    ]);

    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await vi.waitFor(() => {
      expect(log.sendCalls).toHaveLength(1);
    });
    expect(log.sendCalls[0].metadata.note).toBe(
      'It crashed while I typed\n\nCrash source: document view\nDocument: alpha.md\nError: boom',
    );
  });

  test("a crash context folds React's component stack into the note, capped", async () => {
    const log = installBridge();
    const frames = Array.from(
      { length: 27 },
      (_, i) => `    at Component${i} (/Users/someone/OpenKnowledge.app/bundle.js:1:${i})`,
    );
    await renderDialog({
      crashContext: {
        source: 'app shell',
        errorMessage: 'Minified React error #185',
        componentStack: `\n${frames.join('\n')}\n`,
      },
    });

    await createReport('it crashed');

    const note = log.createCalls[0]?.note ?? '';
    expect(note).toContain('Component stack:');
    expect(note).toContain('at Component0 (bundle.js:1:0)');
    expect(note).toContain('at Component24 (bundle.js:1:24)');
    expect(note).not.toContain('/Users/');
    expect(note).not.toContain('at Component25');
    expect(note).toContain('... 2 more frame(s) omitted');
  });

  test('a crash context without a component stack keeps the note unchanged', async () => {
    const log = installBridge();
    await renderDialog({
      crashContext: { source: 'app shell', errorMessage: 'boom' },
    });

    await createReport('it crashed');

    expect(log.createCalls[0]?.note).toBe('it crashed\n\nCrash source: app shell\nError: boom');
  });

  test('a failed create surfaces the error with the CLI fallback and stays in compose', async () => {
    installBridge({
      create: () => Promise.resolve({ ok: false, error: 'zip destination not writable' }),
    });
    await renderDialog();

    await userEvent.click(screen.getByRole('button', { name: 'Create report' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Couldn't create the report");
    expect(alert.textContent).toContain('zip destination not writable');
    expect(alert.textContent).toContain('ok bug-report');
    expect(screen.getByRole('heading', { name: 'Report a bug' })).not.toBeNull();
  });

  const BOOT_INVITE: OkBugReportCrashDetectedEvent = {
    eventId: 'boot:1751871600000',
    kind: 'boot',
    context: { dirtyShutdown: true, newMinidumps: 1 },
    minidumpAvailable: true,
  };

  test('a crash invite reskins compose: banner, crash note label, pre-checked diagnostics, on-by-default dump, Not now', async () => {
    installBridge();
    await renderDialog({ crashInvite: BOOT_INVITE });

    expect(screen.getByText('OpenKnowledge quit unexpectedly last time.')).not.toBeNull();
    expect(
      screen.getByText('A report helps us find the cause. Nothing is sent until you review it.'),
    ).not.toBeNull();

    const noteBox = screen.getByRole('textbox', { name: /what were you doing\? \(optional\)/i });
    expect(noteBox.getAttribute('placeholder')).toBe(
      'e.g. Switching projects while a sync was running',
    );

    const logsCheckbox = screen.getByRole('checkbox', { name: /Logs & system info/ });
    expect(logsCheckbox.getAttribute('aria-checked')).toBe('true');
    expect(logsCheckbox.hasAttribute('disabled')).toBe(true);

    expect(
      screen.getByRole('checkbox', { name: 'Detailed diagnostics' }).getAttribute('aria-checked'),
    ).toBe('true');

    const dumpBox = screen.getByRole('checkbox', { name: 'Crash dump' });
    expect(dumpBox.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/a memory snapshot from the crash/i)).not.toBeNull();
    expect(screen.getByText(/can't be redacted/i)).not.toBeNull();

    expect(screen.getByRole('button', { name: 'Not now' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.queryByText(/secrets like api keys and tokens are redacted/i)).toBeNull();
  });

  test('crash-invite create folds the crash details in and includes the dump by default', async () => {
    const log = installBridge();
    await renderDialog({ crashInvite: BOOT_INVITE });

    await userEvent.click(screen.getByRole('button', { name: 'Create report' }));
    await screen.findByRole('heading', { name: 'Review your report' });

    expect(log.createCalls).toEqual([
      {
        level: 'full',
        note: 'Crash source: previous session ended without a clean quit\nCrash event: boot:1751871600000',
        includeCrashDump: true,
      },
    ]);
  });

  test('unchecking Crash dump excludes the minidump from create', async () => {
    const log = installBridge();
    await renderDialog({ crashInvite: BOOT_INVITE });

    await userEvent.click(screen.getByRole('checkbox', { name: 'Crash dump' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create report' }));
    await screen.findByRole('heading', { name: 'Review your report' });

    expect(log.createCalls[0]?.includeCrashDump).toBe(false);
  });

  test('a crash invite with no available minidump shows no dump row and sends no flag', async () => {
    const log = installBridge();
    await renderDialog({
      crashInvite: {
        eventId: 'boot:1751871600001',
        kind: 'boot',
        context: { dirtyShutdown: true, newMinidumps: 0 },
        minidumpAvailable: false,
      },
    });

    expect(screen.queryByRole('checkbox', { name: 'Crash dump' })).toBeNull();
    expect(screen.getByText('OpenKnowledge quit unexpectedly last time.')).not.toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Create report' }));
    await screen.findByRole('heading', { name: 'Review your report' });

    expect(log.createCalls[0]).not.toHaveProperty('includeCrashDump');
  });

  test('a crash invite that names the crashed version folds it in last', async () => {
    const log = installBridge();
    await renderDialog({ crashInvite: { ...BOOT_INVITE, crashedAppVersion: '0.41.0' } });

    await userEvent.click(screen.getByRole('button', { name: 'Create report' }));
    await screen.findByRole('heading', { name: 'Review your report' });

    expect(log.createCalls).toEqual([
      {
        level: 'full',
        note: 'Crash source: previous session ended without a clean quit\nCrash event: boot:1751871600000\nCrashed app version: 0.41.0',
        includeCrashDump: true,
      },
    ]);
  });

  test('a crash invite with no crashed version composes the note without that line', async () => {
    const log = installBridge();
    await renderDialog({ crashInvite: BOOT_INVITE });

    await userEvent.click(screen.getByRole('button', { name: 'Create report' }));
    await screen.findByRole('heading', { name: 'Review your report' });

    expect(log.createCalls[0]?.note).not.toContain('Crashed app version');
  });

  test('a plain compose with no dump on hand renders no crash-dump opt-in and sends no flag', async () => {
    const log = installBridge();
    await renderDialog();

    expect(screen.queryByRole('checkbox', { name: 'Crash dump' })).toBeNull();

    await createReport();
    expect(log.createCalls).toEqual([{ level: 'standard' }]);
  });

  test('a manually-opened report offers the dump main is holding, default unchecked', async () => {
    const log = installBridge({
      crashDumpAvailability: () => Promise.resolve({ available: true }),
    });
    await renderDialog();

    const dumpBox = screen.getByRole('checkbox', { name: 'Crash dump' });
    expect(dumpBox.getAttribute('data-state')).toBe('unchecked');

    await userEvent.click(dumpBox);
    await createReport();
    expect(log.createCalls[0]?.includeCrashDump).toBe(true);
  });

  test('a manually-opened report left untouched declines the dump rather than omitting the flag', async () => {
    const log = installBridge({
      crashDumpAvailability: () => Promise.resolve({ available: true }),
    });
    await renderDialog();

    await screen.findByRole('checkbox', { name: 'Crash dump' });
    await createReport();

    expect(log.createCalls[0]?.includeCrashDump).toBe(false);
  });

  test('a manually-opened report offers nothing when main holds no dump', async () => {
    const log = installBridge({
      crashDumpAvailability: () => Promise.resolve({ available: false }),
    });
    await renderDialog();

    expect(screen.queryByRole('checkbox', { name: 'Crash dump' })).toBeNull();

    await createReport();
    expect(log.createCalls[0]).not.toHaveProperty('includeCrashDump');
  });

  test('offering a dump drops the blanket redaction reassurance', async () => {
    installBridge({ crashDumpAvailability: () => Promise.resolve({ available: true }) });
    await renderDialog();

    await screen.findByRole('checkbox', { name: 'Crash dump' });
    expect(
      screen.queryByText('Secrets like API keys and tokens are redacted automatically.'),
    ).toBeNull();
  });

  test('with no dump on offer the plain compose keeps its redaction reassurance', async () => {
    installBridge({ crashDumpAvailability: () => Promise.resolve({ available: false }) });
    await renderDialog();

    expect(
      screen.getByText('Secrets like API keys and tokens are redacted automatically.'),
    ).not.toBeNull();
  });

  test('a crash invite reads availability off its own event, not the probe', async () => {
    const log = installBridge({
      crashDumpAvailability: () => Promise.resolve({ available: false }),
    });
    await renderDialog({ crashInvite: BOOT_INVITE });

    expect(screen.getByRole('checkbox', { name: 'Crash dump' })).not.toBeNull();
    expect(log.crashDumpAvailabilityCalls).toBe(0);
  });

  test('the review card qualifies the redaction claim when a raw crash dump is bundled', async () => {
    installBridge({
      create: () =>
        Promise.resolve({
          ...CREATE_OK,
          summary: {
            ...SUMMARY,
            level: 'full',
            files: [...SUMMARY.files, 'extra/renderer-crash.dmp'],
          },
        }),
    });
    await renderDialog({ crashInvite: BOOT_INVITE });

    await userEvent.click(screen.getByRole('button', { name: 'Create report' }));
    await screen.findByRole('heading', { name: 'Review your report' });

    expect(
      screen.getByText(/6\.8 MB · secrets redacted · 3 files · crash dump not redacted/),
    ).not.toBeNull();
  });

  test('the review card keeps the unqualified redaction claim when no crash dump is bundled', async () => {
    installBridge();
    await renderDialog();
    await createReport();

    expect(screen.getByText(/6\.8 MB · secrets redacted · 2 files/)).not.toBeNull();
    expect(screen.queryByText(/crash dump not redacted/)).toBeNull();
  });

  test('a captured screenshot shows a default-on preview + checkbox that ride into create', async () => {
    const log = installBridge({ captureScreenshot: () => Promise.resolve(SCREENSHOT) });
    await renderDialog();

    expect(log.screenshotCalls).toBe(1);

    const shot = screen.getByRole('checkbox', { name: 'Screenshot' });
    expect(shot.getAttribute('aria-checked')).toBe('true');
    const preview = screen.getByAltText('Preview of the screenshot');
    expect(preview.getAttribute('src')).toBe(SCREENSHOT.dataUrl);

    await createReport();
    expect(log.createCalls).toEqual([{ level: 'standard', includeScreenshot: true }]);
  });

  test('unchecking the screenshot keeps it out of create', async () => {
    const log = installBridge({ captureScreenshot: () => Promise.resolve(SCREENSHOT) });
    await renderDialog();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Screenshot' }));
    await createReport();

    expect(log.createCalls).toEqual([{ level: 'standard', includeScreenshot: false }]);
  });

  test('without capture support neither the screenshot checkbox nor the flag appears', async () => {
    const log = installBridge();
    await renderDialog();

    expect(screen.queryByRole('checkbox', { name: 'Screenshot' })).toBeNull();
    await createReport();

    expect(log.createCalls).toEqual([{ level: 'standard' }]);
    expect(log.createCalls[0]).not.toHaveProperty('includeScreenshot');
  });

  test('the review card leaves the redaction claim unqualified for a screenshot-only bundle', async () => {
    installBridge({
      captureScreenshot: () => Promise.resolve(SCREENSHOT),
      create: () =>
        Promise.resolve({
          ...CREATE_OK,
          summary: { ...SUMMARY, files: [...SUMMARY.files, 'extra/screenshot.png'] },
        }),
    });
    await renderDialog();

    await userEvent.click(screen.getByRole('button', { name: 'Create report' }));
    await screen.findByRole('heading', { name: 'Review your report' });

    expect(screen.getByText(/6\.8 MB · secrets redacted · 3 files/)).not.toBeNull();
    expect(screen.queryByText(/crash dump not redacted/)).toBeNull();
  });

  test('a screenshot-bearing bundle tells main to upload the screenshot', async () => {
    const log = installBridge({
      captureScreenshot: () => Promise.resolve(SCREENSHOT),
      create: () =>
        Promise.resolve({
          ...CREATE_OK,
          summary: { ...SUMMARY, files: [...SUMMARY.files, 'extra/screenshot.png'] },
        }),
    });
    await renderDialog();

    await userEvent.click(screen.getByRole('button', { name: 'Create report' }));
    await screen.findByRole('heading', { name: 'Review your report' });
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));

    await vi.waitFor(() => {
      expect(log.sendCalls).toHaveLength(1);
    });
    expect(log.sendCalls[0]?.includeScreenshot).toBe(true);
  });

  test('a trigger with no launcher captures at once, overlay still on screen', async () => {
    const popper = document.createElement('div');
    popper.setAttribute('data-radix-popper-content-wrapper', '');
    document.body.appendChild(popper);

    let popperAtCapture: boolean | null = null;
    let capturedAfterMs = Number.POSITIVE_INFINITY;
    let openedAt = Number.NaN;
    const log = installBridge({
      captureScreenshot: () => {
        popperAtCapture = document.querySelector('[data-radix-popper-content-wrapper]') !== null;
        capturedAfterMs = performance.now() - openedAt;
        return Promise.resolve(SCREENSHOT);
      },
    });
    const { ReportBugDialog } = await import('./ReportBugDialog');
    openedAt = performance.now();
    render(
      <TooltipProvider>
        <ReportBugDialog open onOpenChange={() => {}} />
      </TooltipProvider>,
    );

    await screen.findByRole('dialog');
    expect(log.screenshotCalls).toBe(1);
    expect(popperAtCapture).toBe(true);
    expect(capturedAfterMs).toBeLessThan(400);
    expect(screen.getByRole('checkbox', { name: 'Screenshot' })).not.toBeNull();
  });

  test('a known pointer position is in the frame that gets captured, and gone once it settles', async () => {
    stopPointerTracking = installPointerPositionTracker();
    movePointerTo(420, 260);

    let markerAtCapture: { left: string; top: string } | null = null;
    const log = installBridge({
      captureScreenshot: () => {
        const marker = document.querySelector<HTMLElement>('.ok-pointer-marker');
        markerAtCapture = marker && { left: marker.style.left, top: marker.style.top };
        return Promise.resolve(SCREENSHOT);
      },
    });
    const { ReportBugDialog } = await import('./ReportBugDialog');
    render(
      <TooltipProvider>
        <ReportBugDialog open onOpenChange={() => {}} />
      </TooltipProvider>,
    );

    await screen.findByRole('dialog');
    expect(log.screenshotCalls).toBe(1);
    expect(markerAtCapture).toEqual({ left: '420px', top: '260px' });
    expect(document.querySelector('.ok-pointer-marker')).toBeNull();
  });

  test('with the pointer never moved, the capture runs with no marker and nothing else changes', async () => {
    stopPointerTracking = installPointerPositionTracker();

    let markersAtCapture = -1;
    const log = installBridge({
      captureScreenshot: () => {
        markersAtCapture = document.querySelectorAll('.ok-pointer-marker').length;
        return Promise.resolve(SCREENSHOT);
      },
    });
    await renderDialog();

    expect(markersAtCapture).toBe(0);
    expect(log.screenshotCalls).toBe(1);
    expect(screen.getByRole('checkbox', { name: 'Screenshot' })).not.toBeNull();
  });

  test('the screenshot hint promises a pointer marker only when one was drawn', async () => {
    stopPointerTracking = installPointerPositionTracker();
    movePointerTo(120, 140);
    installBridge({ captureScreenshot: () => Promise.resolve(SCREENSHOT) });
    await renderDialog();

    expect(screen.getByText(/with a marker showing where your pointer was/)).not.toBeNull();
  });

  test('with no marker drawn, the hint does not mention one', async () => {
    stopPointerTracking = installPointerPositionTracker();
    installBridge({ captureScreenshot: () => Promise.resolve(SCREENSHOT) });
    await renderDialog();

    expect(screen.getByRole('checkbox', { name: 'Screenshot' })).not.toBeNull();
    expect(screen.queryByText(/with a marker showing where your pointer was/)).toBeNull();
    expect(
      screen.getByText(/A picture of the app from just before you opened this\./),
    ).not.toBeNull();
  });

  test('a rejected capture still takes the marker off the screen', async () => {
    stopPointerTracking = installPointerPositionTracker();
    movePointerTo(80, 90);

    let markersAtCapture = -1;
    installBridge({
      captureScreenshot: () => {
        markersAtCapture = document.querySelectorAll('.ok-pointer-marker').length;
        return Promise.reject(new Error('capture failed'));
      },
    });
    await renderDialog();

    expect(markersAtCapture).toBe(1);
    expect(document.querySelector('.ok-pointer-marker')).toBeNull();
  });

  test('closing before the capture resolves takes the marker with it', async () => {
    stopPointerTracking = installPointerPositionTracker();
    movePointerTo(80, 90);

    const pending = deferred<OkBugReportScreenshot>();
    installBridge({ captureScreenshot: () => pending.promise });
    const { ReportBugDialog } = await import('./ReportBugDialog');
    const { rerender } = render(
      <TooltipProvider>
        <ReportBugDialog open onOpenChange={() => {}} />
      </TooltipProvider>,
    );

    await waitFrames(3);
    expect(document.querySelectorAll('.ok-pointer-marker')).toHaveLength(1);

    rerender(
      <TooltipProvider>
        <ReportBugDialog open={false} onOpenChange={() => {}} />
      </TooltipProvider>,
    );
    expect(document.querySelector('.ok-pointer-marker')).toBeNull();

    pending.resolve(SCREENSHOT);
    await waitFrames(1);
  });

  test('a capture that lands after the reveal timeout is discarded, not offered', async () => {
    stopPointerTracking = installPointerPositionTracker();
    movePointerTo(140, 200);

    const pending = deferred<OkBugReportScreenshot>();
    const log = installBridge({ captureScreenshot: () => pending.promise });
    const { ReportBugDialog } = await import('./ReportBugDialog');
    render(
      <TooltipProvider>
        <ReportBugDialog open onOpenChange={() => {}} />
      </TooltipProvider>,
    );

    await screen.findByRole('dialog', {}, { timeout: 3000 });
    expect(screen.queryByRole('checkbox', { name: 'Screenshot' })).toBeNull();
    expect(document.querySelector('.ok-pointer-marker')).toBeNull();

    pending.resolve(SCREENSHOT);
    await waitFrames(3);
    expect(screen.queryByRole('checkbox', { name: 'Screenshot' })).toBeNull();
    expect(log.screenshotCalls).toBe(1);
  });

  test('a frame that lands after the reveal timeout draws no marker to strand on screen', async () => {
    stopPointerTracking = installPointerPositionTracker();
    movePointerTo(310, 190);

    const queued: FrameRequestCallback[] = [];
    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => queued.push(cb));

    const log = installBridge({ captureScreenshot: () => Promise.resolve(SCREENSHOT) });
    const { ReportBugDialog } = await import('./ReportBugDialog');
    render(
      <TooltipProvider>
        <ReportBugDialog open onOpenChange={() => {}} />
      </TooltipProvider>,
    );

    try {
      await vi.waitFor(() => expect(queued.length).toBeGreaterThan(0), { timeout: 5000 });
      await screen.findByRole('dialog', {}, { timeout: 5000 });
      expect(log.screenshotCalls).toBe(0);
    } finally {
      rafSpy.mockRestore();
    }

    await act(async () => {
      for (let i = 0; i < 4 && queued.length > 0; i += 1) {
        for (const cb of queued.splice(0)) cb(performance.now());
        await Promise.resolve();
      }
    });

    expect(document.querySelector('.ok-pointer-marker')).toBeNull();
    expect(log.screenshotCalls).toBe(0);
  });

  test('a crash invite draws no marker — it takes no screenshot to draw one into', async () => {
    stopPointerTracking = installPointerPositionTracker();
    movePointerTo(80, 90);

    const log = installBridge({ captureScreenshot: () => Promise.resolve(SCREENSHOT) });
    await renderDialog({ crashInvite: BOOT_INVITE });

    expect(log.screenshotCalls).toBe(0);
    expect(document.querySelector('.ok-pointer-marker')).toBeNull();
  });

  test('a launcher-borne capture draws no marker — the row it would mark is gone', async () => {
    stopPointerTracking = installPointerPositionTracker();
    movePointerTo(500, 300);

    const launcher = document.createElement('div');
    launcher.setAttribute('cmdk-root', '');
    document.body.appendChild(launcher);

    let markersAtCapture = -1;
    const log = installBridge({
      captureScreenshot: () => {
        markersAtCapture = document.querySelectorAll('.ok-pointer-marker').length;
        return Promise.resolve(SCREENSHOT);
      },
    });
    const { ReportBugDialog } = await import('./ReportBugDialog');
    render(
      <TooltipProvider>
        <ReportBugDialog open onOpenChange={() => {}} launcherBorne />
      </TooltipProvider>,
    );

    await waitFrames(3);
    launcher.remove();
    await screen.findByRole('dialog');

    expect(log.screenshotCalls).toBe(1);
    expect(markersAtCapture).toBe(0);
    expect(document.querySelector('.ok-pointer-marker')).toBeNull();
  });

  test('the capture waits for the launcher (⌘K palette) to clear before revealing', async () => {
    const launcher = document.createElement('div');
    launcher.setAttribute('cmdk-root', '');
    document.body.appendChild(launcher);

    let launcherAtCapture: boolean | null = null;
    const log = installBridge({
      captureScreenshot: () => {
        launcherAtCapture = document.querySelector('[cmdk-root]') !== null;
        return Promise.resolve(SCREENSHOT);
      },
    });
    const { ReportBugDialog } = await import('./ReportBugDialog');
    render(
      <TooltipProvider>
        <ReportBugDialog open onOpenChange={() => {}} launcherBorne />
      </TooltipProvider>,
    );

    await waitFrames(6);
    expect(log.screenshotCalls).toBe(0);
    expect(screen.queryByRole('dialog')).toBeNull();

    launcher.remove();
    await screen.findByRole('dialog');
    expect(log.screenshotCalls).toBe(1);
    expect(launcherAtCapture).toBe(false);
    expect(screen.getByRole('checkbox', { name: 'Screenshot' })).not.toBeNull();
  });

  test('a capture that rejects still reveals the dialog, with no screenshot option', async () => {
    const log = installBridge({
      captureScreenshot: () => Promise.reject(new Error('capture failed')),
    });
    await renderDialog();

    expect(screen.getByRole('dialog')).not.toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Screenshot' })).toBeNull();
    expect(log.screenshotCalls).toBe(1);
  });

  test('the crash-invite variant skips capture entirely — opens instantly, no screenshot', async () => {
    const log = installBridge({ captureScreenshot: () => Promise.resolve(SCREENSHOT) });
    await renderDialog({ crashInvite: BOOT_INVITE });

    expect(log.screenshotCalls).toBe(0);
    expect(screen.queryByRole('checkbox', { name: 'Screenshot' })).toBeNull();
    expect(screen.getByText('OpenKnowledge quit unexpectedly last time.')).not.toBeNull();
  });
});
