// biome-ignore-all lint/plugin/no-raw-html-interactive-element: matches sibling OutlinePanel — positional list of <button> rows awaiting a shared shadcn list primitive; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
import type { LintAuditResponse, LintDiagnostic, LintDocResult } from '@inkeep/open-knowledge-core';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { AlertCircle, AlertTriangle, ChevronRight, RefreshCw, Wrench } from 'lucide-react';
import { useState } from 'react';
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
import { runLintAudit } from '@/editor/lint-config-client';
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
}: {
  docName: string;
  diagnostics: LintDiagnostic[];
  /** Apply a fixable diagnostic's auto-fix (this-doc scope only). When absent
   *  (e.g. unit harness), fixable rows render no Fix button. */
  onFix?: (diagnostic: LintDiagnostic) => void;
}) {
  const { t } = useLingui();
  const [scope, setScope] = useState<PanelScope>('doc');
  const [audit, setAudit] = useState<ProjectAuditState>({ status: 'idle' });

  const sorted = [...diagnostics].sort(compareDiagnostics);

  async function loadAudit() {
    setAudit({ status: 'loading' });
    const result = await runLintAudit();
    setAudit(result === null ? { status: 'failed' } : { status: 'loaded', result });
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
            <ul aria-label={t`Problems`} className="flex flex-col gap-0.5">
              {sorted.map((diagnostic) => {
                const displayLine = diagnostic.range.start.line + 1;
                const fixable = onFix !== undefined && (diagnostic.fixes?.length ?? 0) > 0;
                const flatId = `${diagnostic.source}/${diagnostic.code}`;
                return (
                  <li
                    key={diagnosticKey(diagnostic)}
                    className="group flex items-start gap-1 rounded transition-colors hover:bg-muted"
                  >
                    <button
                      type="button"
                      onClick={() => handleNav(diagnostic)}
                      className="flex flex-1 cursor-pointer flex-col gap-0.5 rounded px-2 py-1.5 text-left"
                      title={t`Go to line ${displayLine}`}
                    >
                      <DiagnosticRowBody diagnostic={diagnostic} />
                    </button>
                    {fixable ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="mt-1 mr-1 h-6 shrink-0 px-2 text-xs opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                        onClick={() => onFix?.(diagnostic)}
                        aria-label={t`Fix ${flatId}`}
                        data-testid="problems-fix"
                      >
                        <Wrench aria-hidden="true" className="size-3" />
                        <Trans>Fix</Trans>
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </PanelBody>
      ) : (
        <ProjectAuditBody
          audit={audit}
          onRefresh={() => void loadAudit()}
          onNavigate={handleProjectNav}
        />
      )}
    </Panel>
  );
}

function ProjectAuditBody({
  audit,
  onRefresh,
  onNavigate,
}: {
  audit: ProjectAuditState;
  onRefresh: () => void;
  onNavigate: (filePath: string, diagnostic: DiagnosticLike) => void;
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
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 text-muted-foreground"
          aria-label={t`Refresh audit`}
          data-testid="problems-audit-refresh"
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCw className="size-3.5" />
        </Button>
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
