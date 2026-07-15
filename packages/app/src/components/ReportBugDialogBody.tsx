/**
 * ReportBugDialog — the in-app "Report a bug" flow (compose → review → send).
 *
 * One dialog hosts six phases: compose (optional note + detail level),
 * review (inspect the exact zip before consenting to send), sending, success
 * (report reference + public GitHub follow-up), email (the designed
 * no-intake default — nothing was uploaded, the prefilled draft is the
 * transport), and failure (the same email fallback framed as an error, for
 * uploads that were attempted and failed). The zip reviewed is byte-identical
 * to the zip sent — `zipPath` from create is handed to send untouched.
 *
 * A crash-detected invitation (`crashInvite`) reskins compose — banner,
 * "What were you doing?" label, pre-checked diagnostics, the crash-dump
 * opt-in, a "Not now" dismiss — while review → send stay shared.
 *
 * Desktop-only surface: bundle creation and the upload both live in Electron
 * main behind `window.okDesktop.bugReport`. Mount sites gate on bridge
 * presence; without it, create degrades to the in-dialog error state.
 */

import type {
  OkBugReportCrashDetectedEvent,
  ReportBundleSummary,
} from '@inkeep/open-knowledge-core';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  AlertCircleIcon,
  ArchiveIcon,
  CheckIcon,
  FileTextIcon,
  Loader2,
  ShieldIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { scheduleClipboardWrite } from '@/lib/share/clipboard-adapter';

const GITHUB_NEW_ISSUE_URL = 'https://github.com/inkeep/open-knowledge/issues/new';

export interface ReportBugCrashContext {
  /** Surface the error escaped from, e.g. 'document view' or 'app shell'. */
  source: string;
  /** Document that was active when the error surfaced, when known. */
  docName?: string;
  errorMessage?: string;
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
 */
function composeNote(userNote: string, contextLines: string[] | undefined): string | undefined {
  const trimmed = userNote.trim();
  if (contextLines === undefined) return trimmed === '' ? undefined : trimmed;
  const context = contextLines.join('\n');
  return trimmed === '' ? context : `${trimmed}\n\n${context}`;
}

function crashContextLines(crashContext: ReportBugCrashContext): string[] {
  const lines = [`Crash source: ${crashContext.source}`];
  if (crashContext.docName !== undefined) lines.push(`Document: ${crashContext.docName}`);
  if (crashContext.errorMessage !== undefined) lines.push(`Error: ${crashContext.errorMessage}`);
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
  return [`Crash source: ${source}`, `Crash event: ${invite.eventId}`];
}

type Phase =
  | { step: 'compose'; creating: boolean; createError: string | null }
  | { step: 'review'; report: CreatedReport }
  | { step: 'sending'; report: CreatedReport }
  | { step: 'success'; report: CreatedReport; reference: string }
  | { step: 'email'; report: CreatedReport; mailtoUrl: string }
  | { step: 'failure'; report: CreatedReport; mailtoUrl: string };

const COMPOSE_IDLE: Phase = { step: 'compose', creating: false, createError: null };

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${bytes} B`;
}

function zipBasename(zipPath: string): string {
  return zipPath.split(/[\\/]/).pop() ?? zipPath;
}

/**
 * The one artifact bundled raw is the opted-in crash minidump under `extra/`
 * — process memory that text redaction cannot scrub. The review/email/failure
 * cards must qualify their "secrets redacted" claim whenever one is present.
 * The summary's file inventory, not the dialog's checkbox state, is the
 * truth: opting in with no dump on disk adds nothing to the bundle.
 */
function reportIncludesRawDump(report: CreatedReport): boolean {
  return report.summary.files.some((file) => file.startsWith('extra/'));
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
   * pre-checked, the crash-dump opt-in row (default off), and a "Not now"
   * dismiss. The event's kind and id fold into the report's note.
   */
  crashInvite?: OkBugReportCrashDetectedEvent;
}

function ReportBugDialog({
  open,
  onOpenChange,
  systemWide = false,
  crashContext,
  crashInvite,
}: ReportBugDialogProps) {
  const { t } = useLingui();
  const [phase, setPhase] = useState<Phase>(COMPOSE_IDLE);
  const [note, setNote] = useState('');
  const [detailed, setDetailed] = useState(crashContext !== undefined || crashInvite !== undefined);
  const [includeDump, setIncludeDump] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sentFraction, setSentFraction] = useState(0);
  // Bumped whenever the current async create/send no longer owns the dialog
  // (cancel, close): the awaiting handler compares and drops its result.
  const opSeqRef = useRef(0);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const noteId = useId();
  const detailedId = useId();
  const detailedHintId = useId();
  const dumpId = useId();
  const dumpHintId = useId();

  const sending = phase.step === 'sending';
  const noteContextLines =
    crashContext !== undefined
      ? crashContextLines(crashContext)
      : crashInvite !== undefined
        ? crashInviteLines(crashInvite)
        : undefined;

  // Fake-determinate upload progress: main exposes no byte-level progress
  // events (the upload is one awaited IPC call), so ease toward 90% and let
  // the terminal phase change deliver the rest — the bar never claims done.
  useEffect(() => {
    if (!sending) return;
    setSentFraction(0);
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      setSentFraction(Math.min(0.9, 1 - Math.exp(-elapsedSeconds / 3)));
    }, 200);
    return () => {
      clearInterval(timer);
    };
  }, [sending]);

  useEffect(() => {
    return () => {
      clearTimeout(copyResetRef.current);
    };
  }, []);

  function handleOpenChange(nextOpen: boolean) {
    // Mid-upload the footer Cancel is the only way out — swallowing Radix's
    // Escape/outside-click close keeps the result from landing in a void.
    if (!nextOpen && phase.step === 'sending') return;
    if (!nextOpen) {
      opSeqRef.current += 1;
      // Reset the form on any concluded close (success, email draft, or upload
      // failure) so the next open starts clean — not just on success.
      if (phase.step === 'success' || phase.step === 'email' || phase.step === 'failure') {
        setNote('');
        setDetailed(crashContext !== undefined || crashInvite !== undefined);
        setIncludeDump(false);
      }
      setPhase(COMPOSE_IDLE);
      setCopied(false);
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
      // Only the crash invite ever asks for the dump — the plain compose has
      // no opt-in surface, so it must not even send the flag.
      ...(crashInvite !== undefined ? { includeCrashDump: includeDump } : {}),
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

  async function handleSend(report: CreatedReport) {
    const bugReport = window.okDesktop?.bugReport;
    if (!bugReport) return;
    const seq = ++opSeqRef.current;
    setPhase({ step: 'sending', report });
    const result = await bugReport.send({
      zipPath: report.zipPath,
      metadata: {
        level: report.summary.level,
        systemWide: report.summary.systemWide,
        projectSlug: report.summary.projectSlug,
        note: composeNote(note, noteContextLines),
      },
    });
    if (opSeqRef.current !== seq) return;
    if (result.ok) {
      setPhase({ step: 'success', report, reference: result.reference });
    } else if (result.reason === 'email-draft') {
      // The designed default (no intake endpoint configured): nothing was
      // attempted and nothing failed, so the email flow renders without any
      // failure framing.
      setPhase({ step: 'email', report, mailtoUrl: result.fallback.mailtoUrl });
    } else {
      setPhase({ step: 'failure', report, mailtoUrl: result.fallback.mailtoUrl });
    }
  }

  function handleCancelSend(report: CreatedReport) {
    // The IPC upload has no abort path — abandon the wait and let the seq
    // guard drop whatever it eventually resolves to.
    opSeqRef.current += 1;
    setPhase({ step: 'review', report });
  }

  function revealZip(zipPath: string) {
    void window.okDesktop?.shell.showItemInFolder(zipPath);
  }

  function openExternal(url: string) {
    void window.okDesktop?.shell.openExternal(url);
  }

  function handleCopyReference(reference: string) {
    void scheduleClipboardWrite(reference)
      .then(() => {
        setCopied(true);
        clearTimeout(copyResetRef.current);
        copyResetRef.current = setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {
        // Every clipboard path refused — the reference stays selectable text.
      });
  }

  function handleOpenGithubIssue(reference: string) {
    const params = new URLSearchParams({
      title: t`Bug report ${reference}`,
      // The reference is the only private↔public correlation key; the bundle
      // itself never leaves the private channel.
      body: t`Report reference: ${reference}`,
    });
    openExternal(`${GITHUB_NEW_ISSUE_URL}?${params}`);
  }

  const uploadPct = Math.round(sentFraction * 100);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md" showCloseButton={!sending}>
        {phase.step === 'compose' && (
          <>
            <DialogHeader>
              <DialogTitle>
                <Trans>Report a bug</Trans>
              </DialogTitle>
              {crashInvite === undefined && (
                <DialogDescription>
                  <Trans>
                    Package logs and system info into a report you can review, then send it
                    privately to the OpenKnowledge team.
                  </Trans>
                </DialogDescription>
              )}
            </DialogHeader>
            <DialogBody className="flex flex-col gap-4">
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
                    <Trans>Include detailed diagnostics</Trans>
                  </label>
                  <p id={detailedHintId} className="text-xs text-muted-foreground">
                    <Trans>
                      Adds telemetry, server state, and runtime info when available. Document names
                      are anonymized.
                    </Trans>
                  </p>
                </div>
              </div>
              {crashInvite !== undefined && (
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
                      <Trans>Include crash dump</Trans>
                    </label>
                    <p id={dumpHintId} className="text-xs text-muted-foreground">
                      <Trans>
                        A memory snapshot from the crash. It can contain document content and can't
                        be redacted — leave off unless you're comfortable sharing it.
                      </Trans>
                    </p>
                  </div>
                </div>
              )}
              {crashInvite === undefined && (
                <div className="flex flex-col gap-2 rounded-md border bg-muted/50 px-3 py-2.5 text-xs">
                  <div className="flex items-start gap-2">
                    <FileTextIcon
                      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span>
                      {systemWide ? (
                        <Trans>
                          App & system info, recent app logs — no project is open, so no project
                          logs are included.
                        </Trans>
                      ) : (
                        <Trans>App & system info, recent app logs, project server logs</Trans>
                      )}
                    </span>
                  </div>
                  {crashContext !== undefined && (
                    <div className="flex items-start gap-2">
                      <AlertCircleIcon
                        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <span>
                        <Trans>Details about the error you just hit are included.</Trans>
                      </span>
                    </div>
                  )}
                  <div className="flex items-start gap-2 border-t pt-2 text-muted-foreground">
                    <ShieldIcon
                      className="mt-0.5 size-3.5 shrink-0 text-chart-2"
                      aria-hidden="true"
                    />
                    <span>
                      <Trans>
                        Secrets like API keys and tokens are redacted automatically. You'll review
                        the report before it's sent.
                      </Trans>
                    </span>
                  </div>
                </div>
              )}
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
                {phase.creating && (
                  <Loader2
                    className="size-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                )}
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
                <Trans>Take a look if you'd like — this exact file is what we receive.</Trans>
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
                <ShieldIcon className="mt-0.5 size-3.5 shrink-0 text-chart-2" aria-hidden="true" />
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
              <Button onClick={() => void handleSend(phase.report)}>
                <Trans>Send report</Trans>
              </Button>
            </DialogFooter>
          </>
        )}

        {phase.step === 'sending' && (
          <>
            <DialogHeader>
              <DialogTitle>
                <Trans>Sending report</Trans>
              </DialogTitle>
              {/* Transport-neutral on purpose: in the default (no intake
                  endpoint) configuration Send never uploads — it resolves to
                  an email draft — so the announcement must not claim one. */}
              <DialogDescription className="sr-only">
                <Trans>Your report is being sent.</Trans>
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="flex flex-col gap-3">
              <div role="status" className="flex items-center gap-2.5 text-sm">
                <Loader2
                  className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none"
                  aria-hidden="true"
                />
                <Trans>Uploading securely</Trans>
                {/* No byte-level progress crosses the IPC boundary, so the only
                    honest number here is the total size. */}
                <span className="ml-auto text-xs text-muted-foreground">
                  <Trans>{formatSize(phase.report.zipSizeBytes)} total</Trans>
                </span>
              </div>
              {/* The width animation is a time-eased estimate, not real
                  transfer progress, so the machine-readable state stays
                  indeterminate (no aria-valuenow) — assistive tech must not
                  hear invented percentages. */}
              <div
                role="progressbar"
                aria-label={t`Sending report`}
                className="h-1.5 overflow-hidden rounded-full bg-secondary"
              >
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${uploadPct}%` }}
                />
              </div>
            </DialogBody>
            <DialogFooter className="sm:justify-between">
              <Button
                variant="ghost"
                className="font-mono uppercase"
                onClick={() => handleCancelSend(phase.report)}
              >
                <Trans>Cancel</Trans>
              </Button>
              <Button disabled>
                <Trans>Send report</Trans>
              </Button>
            </DialogFooter>
          </>
        )}

        {phase.step === 'success' && (
          <>
            <DialogBody>
              <div role="status" className="flex flex-col items-center gap-2.5 py-2 text-center">
                <div
                  className="grid size-11 place-items-center rounded-full bg-chart-2/15 text-chart-2"
                  aria-hidden="true"
                >
                  <CheckIcon className="size-5" />
                </div>
                <DialogTitle>
                  <Trans>Report sent — thank you</Trans>
                </DialogTitle>
                <DialogDescription>
                  <Trans>We've filed it with the team and attached your logs.</Trans>
                </DialogDescription>
                <div className="flex items-center gap-2.5 rounded-md border border-dashed px-3.5 py-2 font-mono text-sm font-semibold tracking-wide">
                  {phase.reference}
                  <Button
                    variant="link"
                    className="h-auto p-0 font-sans text-xs font-medium"
                    // Bare "Copy" is self-describing next to the reference
                    // visually, but generic when a screen reader tabs past it.
                    // The visible text stays a prefix of the accessible name
                    // (WCAG 2.5.3 label-in-name).
                    aria-label={copied ? t`Copied report reference` : t`Copy report reference`}
                    onClick={() => handleCopyReference(phase.reference)}
                  >
                    {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">
                  <Trans>
                    Want to follow along? Open a GitHub issue and mention your reference.
                  </Trans>
                </p>
                <p className="text-sm text-muted-foreground">
                  <Trans>
                    Or write to{' '}
                    <code className="font-mono text-xs text-foreground">support@inkeep.com</code>
                  </Trans>
                </p>
              </div>
            </DialogBody>
            <DialogFooter className="sm:justify-center">
              <Button
                variant="outline"
                className="font-mono uppercase"
                onClick={() => handleOpenGithubIssue(phase.reference)}
              >
                <Trans>Open GitHub issue</Trans>
              </Button>
              <Button onClick={() => handleOpenChange(false)}>
                <Trans>Done</Trans>
              </Button>
            </DialogFooter>
          </>
        )}

        {phase.step === 'email' && (
          <>
            <DialogHeader>
              <DialogTitle>
                <Trans>Send your report by email</Trans>
              </DialogTitle>
              {/* An informational state, not an error: with no report service
                  configured, the prefilled draft is how reports travel — no
                  upload happened, so no alert banner belongs here. */}
              <DialogDescription>
                <Trans>
                  Nothing was uploaded — the report stays on this Mac until you email it to us.
                </Trans>
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
              <p className="text-sm text-muted-foreground">
                <Trans>
                  Attach the file in an email to{' '}
                  <code className="font-mono text-xs text-foreground">support@inkeep.com</code>
                </Trans>
              </p>
            </DialogBody>
            <DialogFooter className="sm:justify-between">
              <Button
                variant="ghost"
                className="font-mono uppercase"
                onClick={() => handleOpenChange(false)}
              >
                <Trans>Close</Trans>
              </Button>
              <Button onClick={() => openExternal(phase.mailtoUrl)}>
                <Trans>Open email draft</Trans>
              </Button>
            </DialogFooter>
          </>
        )}

        {phase.step === 'failure' && (
          <>
            <DialogHeader>
              <DialogTitle>
                <Trans>Couldn't send the report</Trans>
              </DialogTitle>
              <DialogDescription className="sr-only">
                <Trans>Your report couldn't be sent — try again or email it instead.</Trans>
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="flex flex-col gap-4">
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
                    <Trans>The report service couldn't be reached.</Trans>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    <Trans>
                      Your report is saved on this Mac — nothing was lost. You can email it to us
                      instead.
                    </Trans>
                  </p>
                </div>
              </div>
              <ZipCard
                zipPath={phase.report.zipPath}
                zipSizeBytes={phase.report.zipSizeBytes}
                fileCount={null}
                rawDumpIncluded={reportIncludesRawDump(phase.report)}
                onReveal={revealZip}
              />
              <p className="text-sm text-muted-foreground">
                <Trans>
                  Attach the file in an email to{' '}
                  <code className="font-mono text-xs text-foreground">support@inkeep.com</code>
                </Trans>
              </p>
            </DialogBody>
            <DialogFooter className="sm:justify-between">
              <Button
                variant="ghost"
                className="font-mono uppercase"
                onClick={() => handleOpenChange(false)}
              >
                <Trans>Close</Trans>
              </Button>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <Button
                  variant="outline"
                  className="font-mono uppercase"
                  onClick={() => void handleSend(phase.report)}
                >
                  <Trans>Try again</Trans>
                </Button>
                <Button onClick={() => openExternal(phase.mailtoUrl)}>
                  <Trans>Open email draft</Trans>
                </Button>
              </div>
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
  /** `null` hides the file count (the failure card omits it). */
  fileCount: number | null;
  /** The bundle carries a raw crash dump — the redaction claim must be qualified. */
  rawDumpIncluded: boolean;
  onReveal: (zipPath: string) => void;
}

function ZipCard({ zipPath, zipSizeBytes, fileCount, rawDumpIncluded, onReveal }: ZipCardProps) {
  const name = zipBasename(zipPath);
  const sizeText = formatSize(zipSizeBytes);
  return (
    <div className="flex items-center gap-2.5 rounded-md border px-3 py-2.5">
      <ArchiveIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-xs" title={name}>
          {name}
        </p>
        <p className="text-xs text-muted-foreground">
          {fileCount === null ? (
            rawDumpIncluded ? (
              <Trans>{sizeText} · secrets redacted · crash dump not redacted</Trans>
            ) : (
              <Trans>{sizeText} · secrets redacted</Trans>
            )
          ) : rawDumpIncluded ? (
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
        <Trans>Reveal in Finder</Trans>
      </Button>
    </div>
  );
}

// Default export lets the thin `ReportBugDialog.tsx` gate consume this body via
// `React.lazy()`, keeping the ~800-line dialog out of the main app chunk.
export default ReportBugDialog;
