/**
 * ReportBugDialog state-machine tests: compose → review → send with the
 * success, failure→email-fallback, cancel, and note-preservation paths, all
 * against a scripted `window.okDesktop` bridge. Copy assertions pin the
 * approved copy deck strings; the path-identity assertions pin that the zip
 * reviewed is the zip sent.
 *
 * Substrate: jsdom via `bun run test:dom`.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import type {
  OkBugReportCrashDetectedEvent,
  OkBugReportCreateResult,
  OkBugReportScreenshot,
  OkBugReportSendMetadata,
  OkBugReportSendResult,
  ReportBundleSummary,
} from '@inkeep/open-knowledge-core';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
    <>{(value === 1 ? one : other).replace('#', String(value))}</>
  ),
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

// Radix Dialog (focus trap) reaches for DOM globals the jsdom preload does not
// expose on globalThis. Same hoist as CloneDialog.dom.test.tsx.
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
  zipSizeBytes: 7130316, // renders as "6.8 MB"
  summary: SUMMARY,
};
const SCREENSHOT: OkBugReportScreenshot = {
  // A 1x1 transparent PNG stands in for the captured preview.
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
type SendRequest = { zipPath: string; metadata: OkBugReportSendMetadata };

interface BridgeLog {
  createCalls: CreateRequest[];
  sendCalls: SendRequest[];
  revealed: string[];
  opened: string[];
  clipboard: string[];
  screenshotCalls: number;
}

function installBridge(
  handlers: {
    create?: (request: CreateRequest) => Promise<OkBugReportCreateResult>;
    send?: (request: SendRequest) => Promise<OkBugReportSendResult>;
    /** Omit to model a build without capture (the gate reveals with no screenshot). */
    captureScreenshot?: () => Promise<OkBugReportScreenshot | null>;
  } = {},
): BridgeLog {
  const log: BridgeLog = {
    createCalls: [],
    sendCalls: [],
    revealed: [],
    opened: [],
    clipboard: [],
    screenshotCalls: 0,
  };
  const bridge = {
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
      // Only present when a handler is supplied, so the default suite exercises
      // the no-capture reveal path (matching a non-desktop / older bridge).
      ...(handlers.captureScreenshot
        ? {
            captureScreenshot: () => {
              log.screenshotCalls += 1;
              return handlers.captureScreenshot?.() ?? Promise.resolve(null);
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
  // The component reads `window.okDesktop`; the shared clipboard adapter reads
  // `globalThis.okDesktop` — the jsdom preload keeps those objects distinct.
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
) {
  const { ReportBugDialog } = await import('./ReportBugDialog');
  const openChangeCalls: boolean[] = [];
  render(
    <TooltipProvider>
      <ReportBugDialog open={true} onOpenChange={(next) => openChangeCalls.push(next)} {...props} />
    </TooltipProvider>,
  );
  // ReportBugDialog is lazy-loaded — wait for the body chunk to resolve and
  // mount before returning so callers' synchronous queries see the dialog.
  await screen.findByRole('dialog');
  return { openChangeCalls };
}

async function createReport(note?: string) {
  if (note !== undefined) {
    await userEvent.type(screen.getByRole('textbox', { name: /what happened/i }), note);
  }
  await userEvent.click(screen.getByRole('button', { name: 'Create report' }));
  await screen.findByRole('heading', { name: 'Review your report' });
}

describe('ReportBugDialog', () => {
  afterEach(() => {
    cleanup();
    clearBridge();
    // Drop any launcher stand-in a test appended so it can't stall the next
    // test's capture (the gate waits for these to clear before shooting).
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
        "Tell us what went wrong and we'll gather the logs. Nothing leaves your Mac until you've reviewed it.",
      ),
    ).not.toBeNull();

    const noteBox = screen.getByRole('textbox', { name: /what happened\? \(optional\)/i });
    expect(noteBox.getAttribute('placeholder')).toBe(
      'e.g. The editor froze after I pasted a large table',
    );

    expect(screen.getByText('What to include')).not.toBeNull();

    // The base tier is always included: checked and non-interactive.
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
        'Adds telemetry, server state, and runtime info when available. Document names are anonymized.',
      ),
    ).not.toBeNull();

    expect(
      screen.getByText('Secrets like API keys and tokens are redacted automatically.'),
    ).not.toBeNull();

    expect(screen.getByRole('button', { name: 'Cancel' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Create report' })).not.toBeNull();
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

  test('sending uploads the reviewed zip and lands on the reference with copy and GitHub follow-up', async () => {
    const send = deferred<OkBugReportSendResult>();
    const log = installBridge({ send: () => send.promise });
    const { openChangeCalls } = await renderDialog();
    await createReport('upload me');

    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));

    await screen.findByRole('heading', { name: 'Sending report' });
    expect(screen.getByText('Uploading securely')).not.toBeNull();
    // Transport-neutral announcement — the default (no intake endpoint)
    // configuration never uploads, so the copy must not claim one.
    expect(screen.getByText('Your report is being sent.')).not.toBeNull();
    // Only the honest total — no fabricated transferred-bytes counter.
    expect(screen.getByText(/6\.8 MB total/)).not.toBeNull();
    expect(screen.queryByText(/MB of/)).toBeNull();
    expect(screen.getByRole('progressbar')).not.toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Send report' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await act(async () => {
      send.resolve({ ok: true, reference: 'OK-8H3KQD' });
      await Promise.resolve();
    });

    await screen.findByRole('heading', { name: 'Thanks for the report!' });
    expect(log.sendCalls).toEqual([
      {
        zipPath: ZIP_PATH,
        metadata: {
          level: 'standard',
          systemWide: false,
          projectSlug: 'demo-project',
          note: 'upload me',
        },
      },
    ]);
    expect(screen.getByDisplayValue('OK-8H3KQD')).not.toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await screen.findByRole('button', { name: 'Copied!' });
    expect(log.clipboard).toEqual(['OK-8H3KQD']);

    await userEvent.click(screen.getByRole('button', { name: 'Open GitHub issue' }));
    expect(log.opened).toHaveLength(1);
    expect(log.opened[0]).toContain('https://github.com/inkeep/open-knowledge/issues/new?');
    expect(log.opened[0]).toContain('OK-8H3KQD');
    // Privacy pin: the public GitHub prefill carries the reference in title
    // and body only — no diagnostics, bundle-path, or attachment params may
    // ever ride along.
    const issueUrl = new URL(log.opened[0] ?? '');
    expect([...issueUrl.searchParams.keys()].sort()).toEqual(['body', 'title']);

    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(openChangeCalls).toEqual([false]);
  });

  test('a failed send falls back to email with the note preserved for the retry', async () => {
    let sendAttempts = 0;
    const log = installBridge({
      send: () => {
        sendAttempts += 1;
        return sendAttempts === 1
          ? Promise.resolve({
              ok: false,
              reason: 'send-failed',
              fallback: { mailtoUrl: 'mailto:support@inkeep.com?subject=OpenKnowledge%20bug' },
            })
          : Promise.resolve({ ok: true, reference: 'OK-RETRY1' });
      },
    });
    await renderDialog();
    await createReport('still my note');

    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));

    await screen.findByRole('heading', { name: "Couldn't send the report" });
    expect(
      screen.getByText("Your report couldn't be sent. Try again or email it instead."),
    ).not.toBeNull();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain("The report service couldn't be reached.");
    expect(alert.textContent).toContain(
      'Your report is saved on this Mac, so nothing was lost. You can email it to us instead.',
    );
    expect(screen.getByText('2026-07-10T00-00-00-bugreport.zip')).not.toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }));
    expect(log.revealed).toEqual([ZIP_PATH]);

    await userEvent.click(screen.getByRole('button', { name: 'Open email draft' }));
    expect(log.opened).toEqual(['mailto:support@inkeep.com?subject=OpenKnowledge%20bug']);

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { name: 'Thanks for the report!' });
    expect(log.sendCalls).toHaveLength(2);
    expect(log.sendCalls[1].zipPath).toBe(ZIP_PATH);
    expect(log.sendCalls[1].metadata.note).toBe('still my note');
  });

  test('with no report service configured, send resolves to the email flow — no fake upload, no failure framing', async () => {
    const log = installBridge({
      send: () =>
        Promise.resolve({
          ok: false,
          reason: 'email-draft',
          fallback: { mailtoUrl: 'mailto:support@inkeep.com?subject=OpenKnowledge%20bug' },
        }),
    });
    await renderDialog();
    await createReport('no intake configured');

    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));

    await screen.findByRole('heading', { name: 'Send your report by email' });
    expect(
      screen.getByText(
        'Nothing was uploaded. The report stays on this Mac until you email it to us.',
      ),
    ).not.toBeNull();
    // An informational state, not an error: no alert, no unreachable-service
    // claim, and nothing to retry — the draft is the transport.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/couldn't be reached/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByText('2026-07-10T00-00-00-bugreport.zip')).not.toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }));
    expect(log.revealed).toEqual([ZIP_PATH]);

    await userEvent.click(screen.getByRole('button', { name: 'Open email draft' }));
    expect(log.opened).toEqual(['mailto:support@inkeep.com?subject=OpenKnowledge%20bug']);
  });

  test('cancel during sending returns to review and the late result is ignored', async () => {
    const send = deferred<OkBugReportSendResult>();
    const { openChangeCalls } = await (async () => {
      installBridge({ send: () => send.promise });
      return renderDialog();
    })();
    await createReport();

    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await screen.findByRole('heading', { name: 'Sending report' });

    // Escape must not dismiss the dialog mid-upload — Cancel is the only exit.
    await userEvent.keyboard('{Escape}');
    expect(openChangeCalls).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('heading', { name: 'Review your report' });

    await act(async () => {
      send.resolve({ ok: true, reference: 'OK-LATE99' });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText('OK-LATE99')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Review your report' })).not.toBeNull();
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
    await screen.findByRole('heading', { name: 'Thanks for the report!' });
    expect(log.sendCalls[0].metadata.note).toBe(
      'It crashed while I typed\n\nCrash source: document view\nDocument: alpha.md\nError: boom',
    );
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
  };

  test('a crash invite reskins compose: banner, crash note label, pre-checked diagnostics, off-by-default dump, Not now', async () => {
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

    // The base logs row is always-on in the crash variant too.
    const logsCheckbox = screen.getByRole('checkbox', { name: /Logs & system info/ });
    expect(logsCheckbox.getAttribute('aria-checked')).toBe('true');
    expect(logsCheckbox.hasAttribute('disabled')).toBe(true);

    expect(
      screen.getByRole('checkbox', { name: 'Detailed diagnostics' }).getAttribute('aria-checked'),
    ).toBe('true');

    const dumpBox = screen.getByRole('checkbox', { name: 'Crash dump' });
    expect(dumpBox.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(/a memory snapshot from the crash\./i)).not.toBeNull();
    expect(screen.getByText(/can't be redacted/i)).not.toBeNull();

    expect(screen.getByRole('button', { name: 'Not now' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    // The redaction note is suppressed here: the crash-dump row already
    // qualifies redaction, and the banner carries the review-gate reassurance.
    expect(screen.queryByText(/secrets like api keys and tokens are redacted/i)).toBeNull();
  });

  test('crash-invite create folds the crash details in and leaves the dump out unless opted in', async () => {
    const log = installBridge();
    await renderDialog({ crashInvite: BOOT_INVITE });

    await userEvent.click(screen.getByRole('button', { name: 'Create report' }));
    await screen.findByRole('heading', { name: 'Review your report' });

    expect(log.createCalls).toEqual([
      {
        level: 'full',
        note: 'Crash source: previous session ended without a clean quit\nCrash event: boot:1751871600000',
        includeCrashDump: false,
      },
    ]);
  });

  test('checking Crash dump opts the minidump into create', async () => {
    const log = installBridge();
    await renderDialog({ crashInvite: BOOT_INVITE });

    await userEvent.click(screen.getByRole('checkbox', { name: 'Crash dump' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create report' }));
    await screen.findByRole('heading', { name: 'Review your report' });

    expect(log.createCalls[0]?.includeCrashDump).toBe(true);
  });

  test('the plain compose never renders the crash-dump opt-in and never sends the flag', async () => {
    const log = installBridge();
    await renderDialog();

    expect(screen.queryByRole('checkbox', { name: 'Crash dump' })).toBeNull();

    await createReport();
    expect(log.createCalls).toEqual([{ level: 'standard' }]);
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

    await userEvent.click(screen.getByRole('checkbox', { name: 'Crash dump' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create report' }));
    await screen.findByRole('heading', { name: 'Review your report' });

    // The dump is copied byte-for-byte, so the last screen before send must
    // not let "secrets redacted" stand unqualified.
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

    // Captured exactly once — before the dialog was revealed.
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

    // The screenshot rides under extra/, but the user already previewed it, so
    // it must NOT trip the crash-dump "not redacted" wording.
    expect(screen.getByText(/6\.8 MB · secrets redacted · 3 files/)).not.toBeNull();
    expect(screen.queryByText(/crash dump not redacted/)).toBeNull();
  });

  test('the capture waits for the launcher (⌘K palette) to clear before revealing', async () => {
    // Stand in for the command palette still animating out as the dialog opens
    // (the reported leak: the palette was opened only to reach Report a bug).
    const launcher = document.createElement('div');
    launcher.setAttribute('cmdk-root', '');
    document.body.appendChild(launcher);

    const log = installBridge({ captureScreenshot: () => Promise.resolve(SCREENSHOT) });
    const { ReportBugDialog } = await import('./ReportBugDialog');
    render(
      <TooltipProvider>
        <ReportBugDialog open onOpenChange={() => {}} />
      </TooltipProvider>,
    );

    // While the launcher is on screen the shot is held back: nothing captured
    // and the dialog stays hidden.
    await Promise.resolve();
    expect(log.screenshotCalls).toBe(0);
    expect(screen.queryByRole('dialog')).toBeNull();

    // Launcher unmounts → capture fires and the dialog reveals with the preview.
    launcher.remove();
    await screen.findByRole('dialog');
    expect(log.screenshotCalls).toBe(1);
    expect(screen.getByRole('checkbox', { name: 'Screenshot' })).not.toBeNull();
  });

  test('a capture that rejects still reveals the dialog, with no screenshot option', async () => {
    const log = installBridge({
      captureScreenshot: () => Promise.reject(new Error('capture failed')),
    });
    await renderDialog();

    // The gate's capture `.catch(() => settle(null))` must degrade gracefully:
    // the dialog opens (no stranded user), just without a screenshot to offer.
    expect(screen.getByRole('dialog')).not.toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Screenshot' })).toBeNull();
    expect(log.screenshotCalls).toBe(1);
  });

  test('the crash-invite variant skips capture entirely — opens instantly, no screenshot', async () => {
    const log = installBridge({ captureScreenshot: () => Promise.resolve(SCREENSHOT) });
    await renderDialog({ crashInvite: BOOT_INVITE });

    // The crash invite opens itself the moment main reports a crash, so the
    // gate must not hold it closed for a capture (that would delay an already
    // unprompted dialog) nor offer a screenshot — the crash dump is its artifact.
    expect(log.screenshotCalls).toBe(0);
    expect(screen.queryByRole('checkbox', { name: 'Screenshot' })).toBeNull();
    // Still the crash-invite compose (its banner renders).
    expect(screen.getByText('OpenKnowledge quit unexpectedly last time.')).not.toBeNull();
  });
});
