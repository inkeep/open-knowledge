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
  source: string;
  docName?: string;
  errorMessage?: string;
  componentStack?: string;
}

interface CreatedReport {
  zipPath: string;
  zipSizeBytes: number;
  summary: ReportBundleSummary;
}

function composeNote(userNote: string, contextLines: string[] | undefined): string | undefined {
  const trimmed = userNote.trim();
  if (contextLines === undefined) return trimmed === '' ? undefined : trimmed;
  const context = contextLines.join('\n');
  return trimmed === '' ? context : `${trimmed}\n\n${context}`;
}

const COMPONENT_STACK_FRAME_LIMIT = 25;

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
  const lines = [`Crash source: ${source}`, `Crash event: ${invite.eventId}`];
  if (invite.kind === 'boot' && invite.crashedAppVersion !== undefined) {
    lines.push(`Crashed app version: ${invite.crashedAppVersion}`);
  }
  return lines;
}

type Phase =
  | { step: 'compose'; creating: boolean; createError: string | null }
  | { step: 'review'; report: CreatedReport };

const COMPOSE_IDLE: Phase = { step: 'compose', creating: false, createError: null };

function reportIncludesRawDump(report: CreatedReport): boolean {
  return report.summary.files.some(
    (file) => file.startsWith('extra/') && file !== BUG_REPORT_SCREENSHOT_ZIP_ENTRY,
  );
}

export interface ReportBugDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  systemWide?: boolean;
  crashContext?: ReportBugCrashContext;
  crashInvite?: OkBugReportCrashDetectedEvent;
  screenshot?: OkBugReportScreenshot | null;
  pointerMarked?: boolean;
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
  const isMacOS =
    (typeof window !== 'undefined' ? window.okDesktop?.platform : undefined) === 'darwin';
  const [phase, setPhase] = useState<Phase>(COMPOSE_IDLE);
  const [note, setNote] = useState('');
  const [detailed, setDetailed] = useState(crashContext !== undefined || crashInvite !== undefined);
  const crashDumpAvailable =
    crashInvite !== undefined ? crashInvite.minidumpAvailable === true : probedCrashDumpAvailable;
  const [includeDump, setIncludeDump] = useState(crashInvite?.minidumpAvailable === true);
  const [includeScreenshot, setIncludeScreenshot] = useState(true);
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
      ...(crashDumpAvailable ? { includeCrashDump: includeDump } : {}),
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
      includeScreenshot: report.summary.files.includes(BUG_REPORT_SCREENSHOT_ZIP_ENTRY),
    });
    setNote('');
    setDetailed(crashContext !== undefined || crashInvite !== undefined);
    setIncludeDump(crashInvite?.minidumpAvailable === true);
    setIncludeScreenshot(true);
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
                    {}
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
              {}
              {/* biome-ignore lint/a11y/useSemanticElements: role="group" + aria-labelledby groups the checkboxes under the heading without <fieldset>/<legend>'s layout-reset and legend-flow quirks. */}
              <div role="group" aria-labelledby={whatToIncludeId} className="flex flex-col gap-3.5">
                <div className="flex flex-col gap-1.5">
                  <p id={whatToIncludeId} className="text-sm font-medium">
                    <Trans>What to include</Trans>
                  </p>
                  {}
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
                {}
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
                      </Trans>{' '}
                      {isMacOS && (
                        <Trans>
                          It also adds the crash reports macOS recorded for OpenKnowledge and its
                          helper processes, only ours and never another app's.
                        </Trans>
                      )}
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
                      {}
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
              {}
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

export default ReportBugDialog;
