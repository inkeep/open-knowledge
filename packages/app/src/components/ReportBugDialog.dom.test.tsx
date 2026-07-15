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
  OkBugReportSendMetadata,
  OkBugReportSendResult,
  ReportBundleSummary,
} from '@inkeep/open-knowledge-core';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
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

type CreateRequest = { level: 'standard' | 'full'; note?: string; includeCrashDump?: boolean };
type SendRequest = { zipPath: string; metadata: OkBugReportSendMetadata };

interface BridgeLog {
  createCalls: CreateRequest[];
  sendCalls: SendRequest[];
  revealed: string[];
  opened: string[];
  clipboard: string[];
}

function installBridge(
  handlers: {
    create?: (request: CreateRequest) => Promise<OkBugReportCreateResult>;
    send?: (request: SendRequest) => Promise<OkBugReportSendResult>;
  } = {},
): BridgeLog {
  const log: BridgeLog = {
    createCalls: [],
    sendCalls: [],
    revealed: [],
    opened: [],
    clipboard: [],
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
    <ReportBugDialog open={true} onOpenChange={(next) => openChangeCalls.push(next)} {...props} />,
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
  });

  test('compose state offers a labeled optional note, an off-by-default diagnostics checkbox, and the privacy summary', async () => {
    installBridge();
    await renderDialog();

    expect(screen.getByRole('dialog')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Report a bug' })).not.toBeNull();
    expect(
      screen.getByText(
        'Package logs and system info into a report you can review, then send it privately to the OpenKnowledge team.',
      ),
    ).not.toBeNull();

    const noteBox = screen.getByRole('textbox', { name: /what happened\? \(optional\)/i });
    expect(noteBox.getAttribute('placeholder')).toBe(
      'e.g. The editor froze after I pasted a large table',
    );

    const checkbox = screen.getByRole('checkbox', { name: 'Include detailed diagnostics' });
    expect(checkbox.getAttribute('aria-checked')).toBe('false');
    expect(
      screen.getByText(
        'Adds telemetry, server state, and runtime info when available. Document names are anonymized.',
      ),
    ).not.toBeNull();

    expect(
      screen.getByText('App & system info, recent app logs, project server logs'),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "Secrets like API keys and tokens are redacted automatically. You'll review the report before it's sent.",
      ),
    ).not.toBeNull();

    expect(screen.getByRole('button', { name: 'Cancel' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Create report' })).not.toBeNull();
  });

  test('a system-wide report says up front that no project logs are included', async () => {
    installBridge();
    await renderDialog({ systemWide: true });

    expect(
      screen.getByText(
        'App & system info, recent app logs — no project is open, so no project logs are included.',
      ),
    ).not.toBeNull();
  });

  test('creating a report builds a standard bundle with the note and shows the review card for the exact zip', async () => {
    const log = installBridge();
    await renderDialog();

    await createReport('The editor froze');

    expect(log.createCalls).toEqual([{ level: 'standard', note: 'The editor froze' }]);
    expect(
      screen.getByText("Take a look if you'd like — this exact file is what we receive."),
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

    await userEvent.click(screen.getByRole('checkbox', { name: 'Include detailed diagnostics' }));
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

    await screen.findByRole('heading', { name: 'Report sent — thank you' });
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
    expect(screen.getByText('OK-8H3KQD')).not.toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Copy report reference' }));
    await screen.findByRole('button', { name: 'Copied report reference' });
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
      screen.getByText("Your report couldn't be sent — try again or email it instead."),
    ).not.toBeNull();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain("The report service couldn't be reached.");
    expect(alert.textContent).toContain(
      'Your report is saved on this Mac — nothing was lost. You can email it to us instead.',
    );
    expect(screen.getByText('2026-07-10T00-00-00-bugreport.zip')).not.toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }));
    expect(log.revealed).toEqual([ZIP_PATH]);

    await userEvent.click(screen.getByRole('button', { name: 'Open email draft' }));
    expect(log.opened).toEqual(['mailto:support@inkeep.com?subject=OpenKnowledge%20bug']);

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { name: 'Report sent — thank you' });
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
        'Nothing was uploaded — the report stays on this Mac until you email it to us.',
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

    const checkbox = screen.getByRole('checkbox', { name: 'Include detailed diagnostics' });
    expect(checkbox.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Details about the error you just hit are included.')).not.toBeNull();

    await createReport('It crashed while I typed');

    expect(log.createCalls).toEqual([
      {
        level: 'full',
        note: 'It crashed while I typed\n\nCrash source: document view\nDocument: alpha.md\nError: boom',
      },
    ]);

    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));
    await screen.findByRole('heading', { name: 'Report sent — thank you' });
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

    expect(
      screen
        .getByRole('checkbox', { name: 'Include detailed diagnostics' })
        .getAttribute('aria-checked'),
    ).toBe('true');

    const dumpBox = screen.getByRole('checkbox', { name: 'Include crash dump' });
    expect(dumpBox.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(/a memory snapshot from the crash\./i)).not.toBeNull();
    expect(screen.getByText(/can't be redacted/i)).not.toBeNull();

    expect(screen.getByRole('button', { name: 'Not now' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    // The banner carries the consent line, so the what's-included box yields.
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

  test('checking Include crash dump opts the minidump into create', async () => {
    const log = installBridge();
    await renderDialog({ crashInvite: BOOT_INVITE });

    await userEvent.click(screen.getByRole('checkbox', { name: 'Include crash dump' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create report' }));
    await screen.findByRole('heading', { name: 'Review your report' });

    expect(log.createCalls[0]?.includeCrashDump).toBe(true);
  });

  test('the plain compose never renders the crash-dump opt-in and never sends the flag', async () => {
    const log = installBridge();
    await renderDialog();

    expect(screen.queryByRole('checkbox', { name: 'Include crash dump' })).toBeNull();

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

    await userEvent.click(screen.getByRole('checkbox', { name: 'Include crash dump' }));
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
});
