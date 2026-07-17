// biome-ignore-all lint/plugin/no-raw-html-interactive-element: matches sibling OutlinePanel — positional list of <button> rows awaiting a shared shadcn list primitive; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
import type { LintAuditResponse, LintDiagnostic, LintDocResult } from '@inkeep/open-knowledge-core';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  AlertCircle,
  AlertTriangle,
  ChevronRight,
  RefreshCw,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { type PanelScope, PanelScopeHeader } from '@/components/PanelScopeHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Panel,
  PanelBody,
  PanelCount,
  PanelEmpty,
  PanelError,
  PanelHeader,
  PanelTitle,
} from '@/components/ui/panel';
import { Skeleton } from '@/components/ui/skeleton';
import { fixLintDoc, runLintAudit } from '@/editor/lint-config-client';
import { rememberPendingSourceNavigation } from '@/editor/source-editor-navigation';
import { filePathToDocName, hashFromDocName } from '@/lib/doc-hash';
import { cn } from '@/lib/utils';

/** Jump-to-line intent dispatched when a problem row is clicked in source mode. */
export interface LintNavDetail {
  /** 1-based line in `Y.Text('source')` (full doc incl. frontmatter). */
  line: number;
  /** 1-based column. */
  column: number;
}

export const LINT_NAV_EVENT = 'open-knowledge:lint-nav';

/**
 * Wire-loose diagnostic shape from the audit response. The engine's
 * `LintDiagnostic` (doc scope) is a subtype — its `source` is a plugin-id
 * literal where the wire admits any string — so the row helpers below accept
 * this wider shape and serve both scopes.
 */
type DiagnosticLike = LintDocResult['diagnostics'][number];

/** Stable sort key: line, then column. */
function compareDiagnostics(a: DiagnosticLike, b: DiagnosticLike): number {
  return (
    a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character
  );
}

/** The nav contract is 1-based (CodeMirror lines); the diagnostic range is 0-based LSP. */
function lintNavDetailOf(diagnostic: DiagnosticLike): LintNavDetail {
  return {
    line: diagnostic.range.start.line + 1,
    column: diagnostic.range.start.character + 1,
  };
}

type ProjectAuditState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; result: LintAuditResponse }
  | { status: 'failed' };

/** Message line + `source/code · line` subline shared by doc- and project-scope rows. */
function DiagnosticRowBody({ diagnostic }: { diagnostic: DiagnosticLike }) {
  const { t } = useLingui();
  const Icon = diagnostic.severity === 'error' ? AlertCircle : AlertTriangle;
  const flatId = `${diagnostic.source}/${diagnostic.code}`;
  const displayLine = diagnostic.range.start.line + 1;
  return (
    <>
      <span className="flex items-start gap-1.5 text-sm">
        <Icon
          aria-hidden="true"
          className={cn(
            'mt-0.5 size-3.5 shrink-0',
            diagnostic.severity === 'error' ? 'text-destructive' : 'text-amber-500',
          )}
        />
        <span className="text-foreground">{diagnostic.message}</span>
      </span>
      <span className="ps-5 font-mono text-xs text-muted-foreground">
        {flatId} · {t`line ${displayLine}`}
      </span>
    </>
  );
}

function diagnosticKey(diagnostic: DiagnosticLike): string {
  return `${diagnostic.source}/${diagnostic.code}-${diagnostic.range.start.line}-${diagnostic.range.start.character}-${diagnostic.message}`;
}

/** How many of `diagnostics` carry a deterministic auto-fix. */
function countFixable(diagnostics: readonly DiagnosticLike[]): number {
  return diagnostics.reduce((n, d) => n + ((d.fixes?.length ?? 0) > 0 ? 1 : 0), 0);
}

/** "Fix all" action shared by both scopes — same look, same position in the
 *  actions row; only the click handler's blast radius differs. The label
 *  carries the deterministically-fixable problem count so the click's effect
 *  is sized before it happens; `children` overrides it (sweep progress). */
function FixAllButton({
  count,
  disabled,
  onClick,
  children,
}: {
  count: number;
  disabled: boolean;
  onClick: () => void;
  children?: ReactNode;
}) {
  const { t } = useLingui();
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-6 shrink-0 px-2 text-xs"
      disabled={disabled}
      onClick={onClick}
      // When `children` is present (project sweep: "Fixing 3/10"), drop the
      // static label so the visible progress text is the accessible name —
      // otherwise the aria-label would override it and freeze the announcement.
      aria-label={children === undefined ? t`Fix all ${count} fixable problems` : undefined}
      data-testid="problems-fix-all"
    >
      <Wrench aria-hidden="true" className="size-3" />
      {children ?? <Trans>Fix all ({count})</Trans>}
    </Button>
  );
}

/**
 * Lint diagnostics panel in the right-hand doc rail, scoped per-doc or
 * project-wide. Doc scope is live and mode-agnostic: `useDocDiagnostics`
 * lints `Y.Text('source')` directly, so the list is populated in WYSIWYG mode
 * too (where no CodeMirror view exists); clicking a row jumps to that line in
 * source mode, or to the containing block in WYSIWYG (the visible editor
 * consumes the nav event). Project scope audits the whole content dir strictly
 * on demand (scope activation or the refresh button — never on mount, never
 * polled) and keeps the last snapshot across scope flips; its rows navigate to
 * the offending doc by hash.
 */
export function ProblemsPanel({
  docName,
  diagnostics,
  onFix,
  onFixAll,
  onAskAi,
}: {
  docName: string;
  diagnostics: LintDiagnostic[];
  /** Apply a fixable diagnostic's auto-fix (this-doc scope only). When absent
   *  (e.g. unit harness), fixable rows render no Fix button. */
  onFix?: (diagnostic: LintDiagnostic) => void;
  /** Apply every fixable diagnostic's auto-fix in this doc. When absent, the
   *  doc-scope Fix all button is not rendered. */
  onFixAll?: () => void;
  /** Hand one diagnostic to the docked terminal's agent as a grounded fix
   *  prompt. Desktop-only — absent on web, where rows render no Ask AI button.
   *  Offered on every row, fixable or not: AI is most useful exactly where no
   *  deterministic fix exists. */
  onAskAi?: (diagnostic: LintDiagnostic) => void;
}) {
  const { t } = useLingui();
  const [scope, setScope] = useState<PanelScope>('doc');
  const [audit, setAudit] = useState<ProjectAuditState>({ status: 'idle' });
  const [projectFixing, setProjectFixing] = useState<{ done: number; total: number } | null>(null);
  // Tracks whether the panel is still mounted so the async project sweep can
  // stop early instead of posting fixes and setState-ing into an unmounted tree.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const sorted = [...diagnostics].sort(compareDiagnostics);

  async function loadAudit() {
    setAudit({ status: 'loading' });
    const result = await runLintAudit();
    // Match the sweep's mounted guard: don't setState into an unmounted tree
    // (loadAudit is awaited from the sweep, the refresh button, and scope
    // activation).
    if (!mountedRef.current) return;
    setAudit(result === null ? { status: 'failed' } : { status: 'loaded', result });
  }

  const projectFixableFiles =
    audit.status === 'loaded'
      ? audit.result.files.filter((file) =>
          file.diagnostics.some((d) => (d.fixes?.length ?? 0) > 0),
        )
      : [];

  async function fixAllProjectFiles() {
    if (projectFixing !== null || projectFixableFiles.length === 0) return;
    setProjectFixing({ done: 0, total: projectFixableFiles.length });
    const failures: { file: string; detail: string | null }[] = [];
    // Sequential on purpose: each fix lands through the agent-write spine and
    // flushes disk + git — parallel posts contend on the git flush and multiply
    // CRDT sessions. Failures (conflict, symlink refusal, capacity) don't stop
    // the sweep; the re-audit below shows what remains.
    for (const file of projectFixableFiles) {
      const outcome = await fixLintDoc(filePathToDocName(file.file));
      // Bail if the panel unmounted mid-sweep (tab switch, agent-mode flip): the
      // user walked away, so stop posting fixes and skip the state updates React
      // would no-op anyway (mirrors the `cancelled` guard in useDocLintConfig).
      if (!mountedRef.current) return;
      if (!outcome.ok) failures.push({ file: file.file, detail: outcome.errorDetail });
      setProjectFixing((prev) => (prev === null ? prev : { ...prev, done: prev.done + 1 }));
    }
    setProjectFixing(null);
    if (failures.length > 0) {
      // Name the first casualty so the toast is actionable — "1 of 10 failed"
      // alone gives the user nothing to act on. The detail is the server's
      // problem+json title (untranslated, like the rule-write error toasts).
      const first = failures[0];
      toast.error(t`Could not fix ${failures.length} of ${projectFixableFiles.length} files.`, {
        description:
          first === undefined
            ? undefined
            : `${first.file}${first.detail === null ? '' : ` — ${first.detail}`}`,
      });
    }
    // Guard the re-audit so a failure surfaces the "Try again" state instead of
    // an unhandled rejection off the fire-and-forget `void fixAllProjectFiles()`.
    try {
      await loadAudit();
    } catch {
      if (mountedRef.current) setAudit({ status: 'failed' });
    }
  }

  function handleScopeChange(next: PanelScope) {
    setScope(next);
    // Only the first activation fetches; afterwards the snapshot is served
    // until an explicit refresh (a failed run keeps its error until retried).
    if (next === 'project' && audit.status === 'idle') void loadAudit();
  }

  function handleNav(diagnostic: DiagnosticLike) {
    const detail = lintNavDetailOf(diagnostic);
    // Banked unconditionally: the visible editor (source line-jump, or the
    // WYSIWYG block-jump in markdown-lint-decorations) consumes the event live
    // and clears the intent; when neither can anchor it (frontmatter
    // diagnostics in WYSIWYG), the intent waits (bounded by the registry TTL)
    // for the next source-mode activation.
    rememberPendingSourceNavigation(docName, { kind: 'lint', detail });
    window.dispatchEvent(new CustomEvent(LINT_NAV_EVENT, { detail }));
  }

  function handleProjectNav(filePath: string, diagnostic: DiagnosticLike) {
    const targetDocName = filePathToDocName(filePath);
    if (targetDocName === docName) {
      handleNav(diagnostic);
      return;
    }
    rememberPendingSourceNavigation(targetDocName, {
      kind: 'lint',
      detail: lintNavDetailOf(diagnostic),
    });
    // No LINT_NAV_EVENT here: the event carries no docName and would move the
    // cursor in the doc that is still open. The banked intent replays once
    // the target doc's source editor activates.
    window.location.hash = hashFromDocName(targetDocName);
  }

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>
          <Trans>Problems</Trans>
        </PanelTitle>
        {scope === 'doc' && sorted.length > 0 && <PanelCount>{sorted.length}</PanelCount>}
      </PanelHeader>
      <PanelScopeHeader scope={scope} onScopeChange={handleScopeChange} />
      {scope === 'doc' ? (
        <PanelBody className="px-2 py-2">
          {sorted.length === 0 ? (
            <PanelEmpty className="px-2">
              <Trans>No problems found.</Trans>
            </PanelEmpty>
          ) : (
            <>
              {onFixAll !== undefined && (
                <div className="flex items-center justify-end gap-2 px-2 pb-1">
                  <FixAllButton
                    count={countFixable(sorted)}
                    disabled={countFixable(sorted) === 0}
                    onClick={onFixAll}
                  />
                </div>
              )}
              <ul aria-label={t`Problems`} className="flex flex-col gap-0.5">
                {sorted.map((diagnostic) => {
                  const displayLine = diagnostic.range.start.line + 1;
                  const fixable = onFix !== undefined && (diagnostic.fixes?.length ?? 0) > 0;
                  const flatId = `${diagnostic.source}/${diagnostic.code}`;
                  return (
                    <li
                      key={diagnosticKey(diagnostic)}
                      className="group relative rounded transition-colors hover:bg-muted"
                    >
                      {/* Full-width message: the actions are pulled out of flow
                          (absolute, below) so the diagnostic text uses the whole
                          row and wraps like the project scope, instead of being
                          squeezed to make room for the buttons. */}
                      <button
                        type="button"
                        onClick={() => handleNav(diagnostic)}
                        className="flex w-full cursor-pointer flex-col gap-0.5 rounded px-2 py-1.5 text-left"
                        title={t`Go to line ${displayLine}`}
                      >
                        <DiagnosticRowBody diagnostic={diagnostic} />
                      </button>
                      {fixable || onAskAi !== undefined ? (
                        // Bottom-right, revealed on hover/focus. `bg-muted`
                        // matches the row's own hover background so it cleanly
                        // occludes the `source/code · line` subline underneath
                        // if a long id would otherwise run beneath it.
                        <div className="absolute bottom-1 right-1 flex items-center gap-1 rounded bg-muted opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none">
                          {fixable ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 shrink-0 px-2 text-xs"
                              onClick={() => onFix?.(diagnostic)}
                              aria-label={t`Fix ${flatId}`}
                              data-testid="problems-fix"
                            >
                              <Wrench aria-hidden="true" className="size-3" />
                              <Trans>Fix</Trans>
                            </Button>
                          ) : null}
                          {onAskAi !== undefined ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 shrink-0 px-2 text-xs"
                              onClick={() => onAskAi(diagnostic)}
                              aria-label={t`Ask AI to fix ${flatId}`}
                              data-testid="problems-ask-ai"
                            >
                              <Sparkles aria-hidden="true" className="size-3" />
                              <Trans>Ask AI</Trans>
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </PanelBody>
      ) : (
        <ProjectAuditBody
          audit={audit}
          onRefresh={() => void loadAudit()}
          onNavigate={handleProjectNav}
          fixableCount={projectFixableFiles.reduce((n, f) => n + countFixable(f.diagnostics), 0)}
          fixing={projectFixing}
          onFixAll={() => void fixAllProjectFiles()}
        />
      )}
    </Panel>
  );
}

function ProjectAuditBody({
  audit,
  onRefresh,
  onNavigate,
  fixableCount,
  fixing,
  onFixAll,
}: {
  audit: ProjectAuditState;
  onRefresh: () => void;
  onNavigate: (filePath: string, diagnostic: DiagnosticLike) => void;
  /** Auto-fixable diagnostics across the loaded audit (same unit the doc
   *  scope's Fix all counts — problems, not files). */
  fixableCount: number;
  /** Sweep progress while a project Fix all is running, else null. */
  fixing: { done: number; total: number } | null;
  onFixAll: () => void;
}) {
  const { t } = useLingui();
  const loading = audit.status === 'loading' || audit.status === 'idle';
  return (
    <PanelBody className="px-2 py-2" data-testid="problems-project-scope">
      <div className="flex items-center justify-between gap-2 px-2 pb-1">
        <p className="text-xs text-muted-foreground" data-testid="problems-audit-summary">
          {audit.status === 'loaded' && (
            <>
              <Plural value={audit.result.errorCount} one="# error" other="# errors" />
              {' · '}
              <Plural value={audit.result.warningCount} one="# warning" other="# warnings" />
            </>
          )}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          {/* The Fix all button is disabled during a sweep, so AT can't focus it
              to hear the "Fixing N/M" progress — announce it from a live region
              instead. Rendered only while sweeping so it never coexists with the
              loading skeleton's own role="status". */}
          {fixing !== null ? (
            <span className="sr-only" role="status">
              {t`Fixing ${fixing.done} of ${fixing.total} files`}
            </span>
          ) : null}
          <FixAllButton
            count={fixableCount}
            disabled={loading || fixing !== null || fixableCount === 0}
            onClick={onFixAll}
          >
            {fixing !== null ? (
              <Trans>
                Fixing {fixing.done}/{fixing.total}
              </Trans>
            ) : undefined}
          </FixAllButton>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 text-muted-foreground"
            aria-label={t`Refresh audit`}
            data-testid="problems-audit-refresh"
            disabled={loading || fixing !== null}
            onClick={onRefresh}
          >
            <RefreshCw aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
      </div>

      {loading && (
        <div
          className="flex flex-col gap-1"
          role="status"
          aria-busy="true"
          aria-label={t`Running project audit`}
        >
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-start gap-2.5 rounded px-2 py-1.5">
              <Skeleton className="mt-0.5 size-3.5 shrink-0 rounded" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-3 w-40" />
              </div>
            </div>
          ))}
        </div>
      )}

      {audit.status === 'failed' && (
        <PanelError className="px-2 text-xs">
          <Trans>The audit could not be completed. Try again.</Trans>
        </PanelError>
      )}

      {audit.status === 'loaded' && (
        <ProjectAuditResults result={audit.result} onNavigate={onNavigate} />
      )}
    </PanelBody>
  );
}

function ProjectAuditResults({
  result,
  onNavigate,
}: {
  result: LintAuditResponse;
  onNavigate: (filePath: string, diagnostic: DiagnosticLike) => void;
}) {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-1">
      {result.warnings.length > 0 && (
        <ul aria-label={t`Configuration warnings`} className="flex flex-col gap-0.5 pb-1">
          {result.warnings.map((warning, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the warnings array is a static audit snapshot (no reorder/insert between renders), and identical config warnings can legitimately repeat — a text-only key would collide.
            <li key={`${index}-${warning}`} className="flex items-start gap-1.5 px-2 text-xs">
              <AlertTriangle
                aria-hidden="true"
                className="mt-0.5 size-3.5 shrink-0 text-amber-500"
              />
              <span className="min-w-0 text-foreground">{warning}</span>
            </li>
          ))}
        </ul>
      )}
      {result.files.length === 0 ? (
        <PanelEmpty className="px-2">
          <Plural
            value={result.fileCount}
            one="No problems across # document."
            other="No problems across # documents."
          />
        </PanelEmpty>
      ) : (
        result.files.map((file) => (
          <ProjectFileGroup key={file.file} file={file} onNavigate={onNavigate} />
        ))
      )}
    </div>
  );
}

function ProjectFileGroup({
  file,
  onNavigate,
}: {
  file: LintDocResult;
  onNavigate: (filePath: string, diagnostic: DiagnosticLike) => void;
}) {
  const { t } = useLingui();
  const sorted = [...file.diagnostics].sort(compareDiagnostics);
  return (
    <Collapsible defaultOpen data-testid="problems-audit-group">
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-1.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-muted">
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
        />
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs text-foreground"
          title={file.file}
        >
          {file.file}
        </span>
        <Badge variant="gray" data-testid="problems-audit-file-count" className="shrink-0">
          {sorted.length}
        </Badge>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=open]:animate-[collapsible-down_150ms_ease-out] data-[state=closed]:animate-[collapsible-up_150ms_ease-in]">
        <ul aria-label={t`Problems in ${file.file}`} className="flex flex-col gap-0.5 pb-1 ps-3">
          {sorted.map((diagnostic) => {
            const displayLine = diagnostic.range.start.line + 1;
            return (
              <li key={diagnosticKey(diagnostic)}>
                <button
                  type="button"
                  onClick={() => onNavigate(file.file, diagnostic)}
                  className="flex w-full cursor-pointer flex-col gap-0.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-muted"
                  title={t`Go to line ${displayLine} in ${file.file}`}
                >
                  <DiagnosticRowBody diagnostic={diagnostic} />
                </button>
              </li>
            );
          })}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
