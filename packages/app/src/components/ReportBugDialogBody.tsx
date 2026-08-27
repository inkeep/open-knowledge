/**
 * ReportBugDialog — the in-app "Report a bug" flow (compose → review → send).
 *
 * Two phases: compose (optional note + detail level) and review (inspect the
 * exact zip before consenting to send). The zip reviewed is byte-identical to
 * the zip sent — `zipPath` from create is handed to send untouched.
 *
 * Send is a hand-off, not a wait. It starts a background operation on the
 * module-level send manager and closes the dialog, so the upload outlives this
 * subtree — which has seven independent mount sites, any of which can unmount
 * mid-send. Progress and the outcome are surfaced by the send toast and the
 * report history, not by a phase here.
 *
 * A crash-detected invitation (`crashInvite`) reskins compose — banner,
 * "What were you doing?" label, pre-checked diagnostics, the crash-dump
 * opt-in, a "Not now" dismiss — while review and the send hand-off stay shared.
 *
 * Desktop-only surface: bundle creation and the upload both live in Electron
 * main behind `window.okDesktop.bugReport`. Mount sites gate on bridge
 * presence; without it, create degrades to the in-dialog error state.
 */

// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import type {
  OkBugReportCrashDetectedEvent,
  OkBugReportScreenshot,
  ReportBundleSummary,
} from '@inkeep/open-knowledge-core';
import { BUG_REPORT_SCREENSHOT_ZIP_ENTRY } from '@inkeep/open-knowledge-core';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { AlertCircleIcon, ArchiveIcon, ShieldIcon, TriangleAlertIcon } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { BugReportPreviousReports } from '@/components/BugReportHistory';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { bugReportSendManager } from '@/lib/bug-report-send-manager';
import { formatBundleSize, zipBasename } from '@/lib/bug-report-support';
import { revealInFileManagerLabel } from '@/lib/platform-labels';

export interface ReportBugCrashContext {
  /** Surface the error escaped from, e.g. 'document view' or 'app shell'. */
  source: string;
  /** Document that was active when the error surfaced, when known. */
  docName?: string;
  errorMessage?: string;
  /**
   * React's component stack for the throw, from the error boundary's
   * `errorInfo`. Production bundles minify both the error message (React ships
   * numeric codes) and the JS stack (mangled identifiers), so this is the only
   * frame-level signal in a packaged crash report that names real components.
   */
  componentStack?: string;
}

interface CreatedReport {
  zipPath: string;
  zipSizeBytes: number;
  summary: ReportBundleSummary;
}

/**
 * Crash details ride inside the note string so they reach the bundle's note
 * file, the upload metadata, and the mailto fallback body through the existing
 * IPC contract. Team-facing diagnostic text, deliberately not localized.
 *
 * Line one is no longer team-facing only: it is what the reporter reads back as
 * their own history row title, and what the intake names the ticket. Context
 * lines are appended rather than prepended so a typed note keeps that line, and
 * any originator that leads with context owes a first line naming the incident
 * rather than the machine that reported it.
 */
function composeNote(userNote: string, contextLines: string[] | undefined): string | undefined {
  const trimmed = userNote.trim();
  if (contextLines === undefined) return trimmed === '' ? undefined : trimmed;
  const context = contextLines.join('\n');
  return trimmed === '' ? context : `${trimmed}\n\n${context}`;
}

/**
 * Frames kept from the component stack. Deep trees can produce hundreds; the
 * innermost few identify the throw site, and the note is user-reviewed in the
 * compose box before sending, so an unbounded dump would swamp it.
 */
const COMPONENT_STACK_FRAME_LIMIT = 25;

/**
 * Reduce a frame's source location to `basename:line:col`.
 *
 * React emits fully-qualified locations, so an untrimmed frame carries the
 * absolute path the bundle was loaded from — which on a per-user install is
 * under the home directory. The directory is worthless for triage anyway: the
 * component name plus `file:line:col` is what maps back through a source map.
 */
function trimFrameLocation(frame: string): string {
  return frame.replace(/\(([^)]*)\)/, (whole, location: string) => {
    const leaf = location.split(/[/\\]/).pop();
    return leaf === undefined || leaf === '' ? whole : `(${leaf})`;
  });
}

function componentStackLines(componentStack: string): string[] {
  const frames = componentStack
    .split('\n')
    .map((line) => trimFrameLocation(line.trim()))
    .filter((line) => line !== '');
  if (frames.length === 0) return [];
  const kept = frames.slice(0, COMPONENT_STACK_FRAME_LIMIT);
  const omitted = frames.length - kept.length;
  return [
    'Component stack:',
    ...kept,
    ...(omitted > 0 ? [`... ${omitted} more frame(s) omitted`] : []),
  ];
}

function crashContextLines(crashContext: ReportBugCrashContext): string[] {
  const lines = [`Crash source: ${crashContext.source}`];
  if (crashContext.docName !== undefined) lines.push(`Document: ${crashContext.docName}`);
  if (crashContext.errorMessage !== undefined) lines.push(`Error: ${crashContext.errorMessage}`);
  if (crashContext.componentStack !== undefined) {
    lines.push(...componentStackLines(crashContext.componentStack));
  }
  return lines;
}

function crashInviteLines(invite: OkBugReportCrashDetectedEvent): string[] {
  const source =
    invite.kind === 'render-process-gone'
      ? `renderer process crash (reason: ${invite.context.reason})`
      : invite.kind === 'child-process-gone'
        ? `${invite.context.processType} process crash (reason: ${invite.context.reason})`
        : invite.context.dirtyShutdown
          ? 'previous session ended without a clean quit'
          : 'new crash dump found from the previous session';
  // The event id keys the crash to main's local acknowledgment/minidump state
  // during triage (it encodes the crashed session or dump timestamp).
  const lines = [`Crash source: ${source}`, `Crash event: ${invite.eventId}`];
  // Appended, never prepended: with an empty note the context lines ARE the
  // note, and the intake takes its ticket title from the note's first line.
  //
  // Stated even when it matches the version the report itself is stamped with.
  // The pair is the diagnostic: two versions side by side say an update landed
  // between the crash and the report, and one repeated says it did not — a
  // line that appeared only on disagreement would leave a reader unable to
  // tell agreement from a build too old to answer.
  if (invite.kind === 'boot' && invite.crashedAppVersion !== undefined) {
    lines.push(`Crashed app version: ${invite.crashedAppVersion}`);
  }
  return lines;
}

type Phase =
  | { step: 'compose'; creating: boolean; createError: string | null }
  | { step: 'review'; report: CreatedReport };

const COMPOSE_IDLE: Phase = { step: 'compose', creating: false, createError: null };

/**
 * The one artifact whose rawness the review card must call out is the opted-in
 * crash minidump under `extra/` — process memory that text redaction cannot
 * scrub. The card must qualify its "secrets redacted" claim whenever one is
 * present. The opted-in screenshot also lands under `extra/`
 * but is excluded here: the user previewed it before including it, so it needs
 * no after-the-fact "not redacted" caveat. The summary's file inventory, not
 * the dialog's checkbox state, is the truth: opting in with no dump on disk
 * adds nothing to the bundle.
 */
function reportIncludesRawDump(report: CreatedReport): boolean {
  return report.summary.files.some(
    (file) => file.startsWith('extra/') && file !== BUG_REPORT_SCREENSHOT_ZIP_ENTRY,
  );
}

export interface ReportBugDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * No project is open in this window (Navigator) — the bundle will be
   * system-wide (user-level logs + sysinfo), and the what's-included summary
   * says so up front.
   */
  systemWide?: boolean;
  /**
   * Present when an error-boundary fallback opened the dialog. Defaults the
   * bundle to full detail and folds the crash details into the report's note.
   */
  crashContext?: ReportBugCrashContext;
  /**
   * Present when a crash-detected invitation opened the dialog
   * (`ReportBugCrashInviteTrigger`). Switches compose to the crash-invite
   * variant: banner, "What were you doing?" note label, detailed diagnostics
   * pre-checked, the crash-dump row (only when the event's `minidumpAvailable`
   * is true; default on, opt-out), and a "Not now" dismiss. The event's kind
   * and id fold into the report's note.
   */
  crashInvite?: OkBugReportCrashDetectedEvent;
  /**
   * Screenshot of the app captured (by the gate) before this dialog painted,
   * or `null` when none is available (web, capture failed, or capture timed
   * out). When present, compose shows a preview + a default-on "Screenshot"
   * checkbox; keeping it checked stages the full-resolution image into the
   * bundle. The gate owns capture so every trigger gets the screenshot without
   * threading it through each mount site.
   */
  screenshot?: OkBugReportScreenshot | null;
  /**
   * The captured image carries a ring drawn at the pointer's last position.
   * Only the immediate-capture triggers draw one, and only when the pointer has
   * moved since load, so the hint below has to say which image the user is
   * actually looking at rather than promise a marker on all of them.
   */
  pointerMarked?: boolean;
  /**
   * Whether main is holding a crash dump this report could carry, as probed by
   * the gate for a report the user opened themselves. Ignored under
   * `crashInvite`, which carries main's answer for its own crash on the event.
   */
  crashDumpAvailable?: boolean;
}

function ReportBugDialog({
  open,
  onOpenChange,
  systemWide = false,
  crashContext,
  crashInvite,
  screenshot = null,
  pointerMarked = false,
  crashDumpAvailable: probedCrashDumpAvailable = false,
}: ReportBugDialogProps) {
  const { t } = useLingui();
  const [phase, setPhase] = useState<Phase>(COMPOSE_IDLE);
  const [note, setNote] = useState('');
  const [detailed, setDetailed] = useState(crashContext !== undefined || crashInvite !== undefined);
  // The crash-dump opt-in only exists when main confirmed a minidump is on
  // disk; a dump-less invite (e.g. a dirty shutdown that left no native crash)
  // offers no dead checkbox. An invite answers for its own crash off the event;
  // a report the user opened themselves takes the gate's probe, so a crash that
  // never prompted still gets its dump into the report filed about it.
  const crashDumpAvailable =
    crashInvite !== undefined ? crashInvite.minidumpAvailable === true : probedCrashDumpAvailable;
  // Default ON only for an invite: the crash is the whole reason for that
  // report, and its minidump is the artifact triage most needs. A manual report
  // is about whatever the user came to say, so unredactable process memory
  // rides along only on an explicit check. Either way consent is preserved
  // without a silent send — the row states the memory is unredactable and the
  // review step flags "crash dump not redacted" before the user sends.
  const [includeDump, setIncludeDump] = useState(crashInvite?.minidumpAvailable === true);
  // Default-on per the spec: when a screenshot was captured it rides along
  // unless the user unchecks it. Only ever sent to `create` when one exists.
  const [includeScreenshot, setIncludeScreenshot] = useState(true);
  // Bumped whenever the in-flight create no longer owns the dialog (a close):
  // the awaiting handler compares and drops its result.
  const opSeqRef = useRef(0);
  const noteId = useId();
  const logsId = useId();
  const logsHintId = useId();
  const detailedId = useId();
  const detailedHintId = useId();
  const dumpId = useId();
  const dumpHintId = useId();
  const screenshotId = useId();
  const screenshotHintId = useId();
  const whatToIncludeId = useId();

  const noteContextLines =
    crashContext !== undefined
      ? crashContextLines(crashContext)
      : crashInvite !== undefined
        ? crashInviteLines(crashInvite)
        : undefined;

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      opSeqRef.current += 1;
      setPhase(COMPOSE_IDLE);
    }
    onOpenChange(nextOpen);
  }

  async function handleCreate() {
    const bugReport = window.okDesktop?.bugReport;
    if (!bugReport) {
      setPhase({
        step: 'compose',
        creating: false,
        createError: t`Bug reporting needs the OpenKnowledge desktop app.`,
      });
      return;
    }
    const seq = ++opSeqRef.current;
    setPhase({ step: 'compose', creating: true, createError: null });
    const result = await bugReport.create({
      level: detailed ? 'full' : 'standard',
      note: composeNote(note, noteContextLines),
      // Only a crash invite with an available dump exposes the opt-in, so only
      // then is the flag sent — plain compose and dump-less invites omit it.
      ...(crashDumpAvailable ? { includeCrashDump: includeDump } : {}),
      // Only send the flag when a screenshot was actually captured — absent
      // means main has nothing staged, so it must not claim an inclusion.
      ...(screenshot !== null ? { includeScreenshot } : {}),
    });
    if (opSeqRef.current !== seq) return;
    if (result.ok) {
      setPhase({
        step: 'review',
        report: {
          zipPath: result.zipPath,
          zipSizeBytes: result.zipSizeBytes,
          summary: result.summary,
        },
      });
    } else {
      setPhase({ step: 'compose', creating: false, createError: result.error });
    }
  }

  function handleSend(report: CreatedReport) {
    bugReportSendManager.startBugReportSend({
      kind: 'created-report',
      report,
      note: composeNote(note, noteContextLines),
      // Read consent off the bundle's own inventory rather than the checkbox
      // state: the inventory is what `create` acted on and what the reporter
      // reviewed, so it cannot drift from the artifact being sent if the checkbox
      // is toggled after create. Main uses this to decide whether to upload the
      // screenshot separately for inline display in the ticket.
      includeScreenshot: report.summary.files.includes(BUG_REPORT_SCREENSHOT_ZIP_ENTRY),
    });
    // The draft is spent once its send is under way, so it is cleared here and
    // nowhere else: resetting on every close would silently discard a note the
    // reporter backed out of to come back to.
    setNote('');
    setDetailed(crashContext !== undefined || crashInvite !== undefined);
    setIncludeDump(crashInvite?.minidumpAvailable === true);
    // Re-default the screenshot to on so the next open (which captures a fresh
    // screenshot) starts checked, matching the compose default.
    setIncludeScreenshot(true);
    // Closing through the shared path, never a bespoke one: mount sites hang
    // their own work off `onOpenChange` — the crash invite acks its event there
    // — so a close that skips it silently drops that work.
    handleOpenChange(false);
  }

  function revealZip(zipPath: string) {
    void window.okDesktop?.shell.showItemInFolder(zipPath);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {phase.step === 'compose' && (
          <>
            <DialogHeader>
              <DialogTitle>
                <Trans>Report a bug</Trans>
              </DialogTitle>
              {crashInvite === undefined && (
                <DialogDescription>
                  <Trans>
                    Tell us what went wrong and we'll gather the logs. Nothing leaves your computer
                    until you've reviewed it.
                  </Trans>
                </DialogDescription>
              )}
            </DialogHeader>
            <DialogBody className="flex flex-col gap-5">
              {crashInvite !== undefined && (
                <div className="flex items-start gap-2.5 rounded-md border border-chart-3/35 bg-chart-3/10 px-3 py-2.5 text-sm">
                  <TriangleAlertIcon
                    className="mt-0.5 size-4 shrink-0 text-chart-3"
                    aria-hidden="true"
                  />
                  <div>
                    <p className="font-medium">
                      <Trans>OpenKnowledge quit unexpectedly last time.</Trans>
                    </p>
                    {/* Rendered as the dialog's Description so the banner's
                        reassurance line is what screen readers announce for
                        the crash variant (no header description here). */}
                    <DialogDescription className="mt-0.5 text-xs">
                      <Trans>
                        A report helps us find the cause. Nothing is sent until you review it.
                      </Trans>
                    </DialogDescription>
                  </div>
                </div>
              )}
              {phase.createError !== null && (
                <div
                  role="alert"
                  className="flex items-start gap-2.5 rounded-md border border-destructive/35 bg-destructive/10 px-3 py-2.5 text-sm"
                >
                  <AlertCircleIcon
                    className="mt-0.5 size-4 shrink-0 text-destructive"
                    aria-hidden="true"
                  />
                  <div>
                    <p className="font-medium">
                      <Trans>Couldn't create the report</Trans>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{phase.createError}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      <Trans>
                        You can also create one from a terminal with{' '}
                        <code className="font-mono">ok bug-report</code>.
                      </Trans>
                    </p>
                  </div>
                </div>
              )}
              <div className="flex flex-col gap-2">
                <label htmlFor={noteId} className="text-sm font-medium">
                  {crashInvite !== undefined ? (
                    <Trans>What were you doing?</Trans>
                  ) : (
                    <Trans>What happened?</Trans>
                  )}{' '}
                  <span className="font-normal text-muted-foreground">
                    <Trans>(optional)</Trans>
                  </span>
                </label>
                <Textarea
                  id={noteId}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={
                    crashInvite !== undefined
                      ? t`e.g. Switching projects while a sync was running`
                      : t`e.g. The editor froze after I pasted a large table`
                  }
                  rows={3}
                  className="resize-none"
                  disabled={phase.creating}
                />
              </div>
              {/* One group so the heading reads as owning the rows below it:
                  tighter than the body's gap-5, looser inside than the label
                  sits to its notes. */}
              {/* biome-ignore lint/a11y/useSemanticElements: role="group" + aria-labelledby groups the checkboxes under the heading without <fieldset>/<legend>'s layout-reset and legend-flow quirks. */}
              <div role="group" aria-labelledby={whatToIncludeId} className="flex flex-col gap-3.5">
                <div className="flex flex-col gap-1.5">
                  <p id={whatToIncludeId} className="text-sm font-medium">
                    <Trans>What to include</Trans>
                  </p>
                  {/* Suppressed on two independent grounds. An invite's banner
                      already carries the "nothing is sent until you review it"
                      line; and wherever a crash dump is on offer the blanket
                      "secrets are redacted" claim would sit directly above a
                      row whose own hint says that dump cannot be redacted. The
                      second test is what covers a manual or crashContext report
                      that the availability probe found a dump for. crashContext
                      and crashInvite never co-occur, so this also gates the
                      error-details note. */}
                  {crashInvite === undefined && !crashDumpAvailable && (
                    <p className="text-1sm text-muted-foreground">
                      {crashContext !== undefined ? (
                        <Trans>
                          Details about the error you just hit are included. Secrets like API keys
                          and tokens are redacted automatically.
                        </Trans>
                      ) : (
                        <Trans>Secrets like API keys and tokens are redacted automatically.</Trans>
                      )}
                    </p>
                  )}
                </div>
                {/* Base tier: logs are in every report. A checked+disabled box
                  states that non-negotiably while staying visually parallel to
                  the optional row below. The label, badge, and hint are real
                  text, so the fact is conveyed even where a disabled control is
                  skipped by assistive tech. */}
                <div className="flex items-start gap-2.5">
                  <Checkbox
                    id={logsId}
                    checked
                    disabled
                    aria-describedby={logsHintId}
                    className="mt-0.5"
                  />
                  <div className="flex flex-col gap-0.5">
                    <label
                      htmlFor={logsId}
                      className="flex items-center gap-2 text-sm font-medium text-foreground"
                    >
                      <Trans>Logs & system info</Trans>
                      <Badge variant="primary" className="text-2xs">
                        <Trans>Always included</Trans>
                      </Badge>
                    </label>
                    <p id={logsHintId} className="text-1sm text-muted-foreground">
                      {systemWide ? (
                        <Trans>
                          App & system info and recent app logs. No project is open, so project logs
                          aren't included.
                        </Trans>
                      ) : (
                        <Trans>
                          App & system info, recent app logs, and project server logs: the
                          essentials we need to reproduce the issue.
                        </Trans>
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-2.5">
                  <Checkbox
                    id={detailedId}
                    checked={detailed}
                    onCheckedChange={(value) => setDetailed(value === true)}
                    aria-describedby={detailedHintId}
                    disabled={phase.creating}
                    className="mt-0.5"
                  />
                  <div className="flex flex-col gap-0.5">
                    <label htmlFor={detailedId} className="text-sm font-medium">
                      <Trans>Detailed diagnostics</Trans>
                    </label>
                    <p id={detailedHintId} className="text-1sm text-muted-foreground">
                      <Trans>
                        Adds telemetry, server state, and runtime info when available. Credentials
                        are always removed; document names, if included, appear in cleartext (not
                        redacted).
                      </Trans>
                    </p>
                  </div>
                </div>
                {screenshot !== null && (
                  <div className="flex items-start gap-2.5">
                    <Checkbox
                      id={screenshotId}
                      checked={includeScreenshot}
                      onCheckedChange={(value) => setIncludeScreenshot(value === true)}
                      aria-describedby={screenshotHintId}
                      disabled={phase.creating}
                      className="mt-0.5"
                    />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <label htmlFor={screenshotId} className="text-sm font-medium">
                        <Trans>Screenshot</Trans>
                      </label>
                      <p id={screenshotHintId} className="text-1sm text-muted-foreground">
                        {pointerMarked ? (
                          <Trans>
                            A picture of the app from just before you opened this, with a marker
                            showing where your pointer was. It isn't redacted, so check the preview
                            and uncheck it if anything shouldn't be shared.
                          </Trans>
                        ) : (
                          <Trans>
                            A picture of the app from just before you opened this. It isn't
                            redacted, so check the preview and uncheck it if anything shouldn't be
                            shared.
                          </Trans>
                        )}
                      </p>
                      {/* Preview dims when excluded so the checkbox state reads
                          at a glance; the label above already names it. */}
                      <div className="mt-2 overflow-hidden rounded-md border bg-muted/40">
                        <img
                          src={screenshot.dataUrl}
                          alt={t`Preview of the screenshot`}
                          className={`block max-h-44 w-full object-contain transition-opacity motion-reduce:transition-none ${
                            includeScreenshot ? 'opacity-100' : 'opacity-40'
                          }`}
                        />
                      </div>
                    </div>
                  </div>
                )}
                {crashDumpAvailable && (
                  <div className="flex items-start gap-2.5">
                    <Checkbox
                      id={dumpId}
                      checked={includeDump}
                      onCheckedChange={(value) => setIncludeDump(value === true)}
                      aria-describedby={dumpHintId}
                      disabled={phase.creating}
                      className="mt-0.5"
                    />
                    <div className="flex flex-col gap-0.5">
                      <label htmlFor={dumpId} className="text-sm font-medium">
                        <Trans>Crash dump</Trans>
                      </label>
                      <p id={dumpHintId} className="text-1sm text-muted-foreground">
                        <Trans>
                          A memory snapshot from the crash, and the artifact that helps us most. It
                          can contain document content and can't be redacted, so uncheck it if you'd
                          rather not share it.
                        </Trans>
                      </p>
                    </div>
                  </div>
                )}
              </div>
              {/* A lightweight disclosure of prior reports so a user can resend
                  one they already made without regenerating. Only in the plain
                  flow — the crash variants stay focused on the report at hand,
                  and it renders nothing until there is history to show. */}
              {crashInvite === undefined && crashContext === undefined ? (
                <BugReportPreviousReports />
              ) : null}
            </DialogBody>
            <DialogFooter>
              <Button
                variant="ghost"
                className="font-mono uppercase"
                onClick={() => handleOpenChange(false)}
              >
                {crashInvite !== undefined ? <Trans>Not now</Trans> : <Trans>Cancel</Trans>}
              </Button>
              <Button onClick={() => void handleCreate()} disabled={phase.creating}>
                {phase.creating && <Spinner className="size-4" aria-hidden="true" />}
                <Trans>Create report</Trans>
              </Button>
            </DialogFooter>
          </>
        )}

        {phase.step === 'review' && (
          <>
            <DialogHeader>
              <DialogTitle>
                <Trans>Review your report</Trans>
              </DialogTitle>
              <DialogDescription>
                <Trans>Take a look if you'd like. This exact file is what we receive.</Trans>
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="flex flex-col gap-4">
              <ZipCard
                zipPath={phase.report.zipPath}
                zipSizeBytes={phase.report.zipSizeBytes}
                fileCount={phase.report.summary.files.length}
                rawDumpIncluded={reportIncludesRawDump(phase.report)}
                onReveal={revealZip}
              />
              <div className="flex items-start gap-2 rounded-md border bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground">
                <ShieldIcon
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span>
                  <Trans>
                    Sent privately to the OpenKnowledge team, along with your note and app version.
                    Never posted publicly.
                  </Trans>
                </span>
              </div>
            </DialogBody>
            <DialogFooter className="sm:justify-between">
              <Button
                variant="ghost"
                className="font-mono uppercase"
                onClick={() => setPhase(COMPOSE_IDLE)}
              >
                <Trans>Back</Trans>
              </Button>
              <Button onClick={() => handleSend(phase.report)}>
                <Trans>Send report</Trans>
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface ZipCardProps {
  zipPath: string;
  zipSizeBytes: number;
  fileCount: number;
  /** The bundle carries a raw crash dump — the redaction claim must be qualified. */
  rawDumpIncluded: boolean;
  onReveal: (zipPath: string) => void;
}

function ZipCard({ zipPath, zipSizeBytes, fileCount, rawDumpIncluded, onReveal }: ZipCardProps) {
  const name = zipBasename(zipPath);
  const sizeText = formatBundleSize(zipSizeBytes);
  return (
    <div className="flex items-center gap-2.5 rounded-md border px-3 py-2.5">
      <div className="flex items-center justify-center size-8 rounded-md bg-muted">
        <ArchiveIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="truncate text-1sm" title={name}>
          {name}
        </p>
        <p className="text-xs text-muted-foreground">
          {rawDumpIncluded ? (
            <Trans>
              {sizeText} · secrets redacted ·{' '}
              <Plural value={fileCount} one="# file" other="# files" /> · crash dump not redacted
            </Trans>
          ) : (
            <Trans>
              {sizeText} · secrets redacted ·{' '}
              <Plural value={fileCount} one="# file" other="# files" />
            </Trans>
          )}
        </p>
      </div>
      <Button
        variant="link"
        className="h-auto shrink-0 p-0 text-xs"
        onClick={() => onReveal(zipPath)}
      >
        {revealInFileManagerLabel(
          typeof window !== 'undefined' ? window.okDesktop?.platform : undefined,
        )}
      </Button>
    </div>
  );
}

// Default export lets the thin `ReportBugDialog.tsx` gate consume this body via
// `React.lazy()`, keeping the ~800-line dialog out of the main app chunk.
export default ReportBugDialog;
