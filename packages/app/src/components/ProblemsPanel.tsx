// biome-ignore-all lint/plugin/no-raw-html-interactive-element: matches sibling OutlinePanel — positional list of <button> rows awaiting a shared shadcn list primitive; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
import type { ValidationAuditResponse, ValidationDocResult } from '@inkeep/open-knowledge-core';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  AlertCircle,
  AlertTriangle,
  ChevronRight,
  FilePlus2,
  Link2,
  RefreshCw,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useOptionalPageList } from '@/components/PageListContext';
import { type PanelScope, PanelScopeHeader } from '@/components/PanelScopeHeader';
import { LINT_PLUGIN_META, type LintPluginMeta } from '@/components/settings/lint-plugin-meta';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { fixLintDoc, useProjectLintConfig } from '@/editor/lint-config-client';
import { rememberPendingSourceNavigation } from '@/editor/source-editor-navigation';
import { runValidationAudit } from '@/editor/validation-audit-client';
import { createPageFromSeedAndUpdate } from '@/lib/create-page';
import { filePathToDocName, hashFromDocName } from '@/lib/doc-hash';
import { openProjectPluginsSettings } from '@/lib/use-settings-route';
import { cn } from '@/lib/utils';
import { replaceValidationFromAudit } from '@/lib/validation-store';

/** Jump-to-line intent dispatched when a problem row is clicked in source mode. */
export interface LintNavDetail {
  /** 1-based line in `Y.Text('source')` (full doc incl. frontmatter). */
  line: number;
  /** 1-based column. */
  column: number;
}

export const LINT_NAV_EVENT = 'open-knowledge:lint-nav';

/**
 * Wire-loose diagnostic shape from the unified audit response. The engine's
 * `LintDiagnostic` (doc scope) is a subtype — its `source` is a plugin-id
 * literal where the wire admits any string — so the row helpers below accept
 * this wider shape and serve both scopes.
 */
export type DiagnosticLike = ValidationDocResult['diagnostics'][number];

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
  | { status: 'loaded'; result: ValidationAuditResponse }
  | { status: 'failed' };

/** Message line + source chip + `source/code · line` subline shared by doc- and project-scope rows. */
function DiagnosticRowBody({ diagnostic }: { diagnostic: DiagnosticLike }) {
  const { t } = useLingui();
  const Icon = diagnostic.severity === 'error' ? AlertCircle : AlertTriangle;
  const flatId = `${diagnostic.source}/${diagnostic.code}`;
  const displayLine = diagnostic.range.start.line + 1;
  const isLink = diagnostic.source === 'links';
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
      <span className="flex items-center gap-1.5 ps-5 font-mono text-xs text-muted-foreground">
        {/* Source tag: the unified plane mixes validators per file, so every
            row names its category at a glance (the flatId spells the full
            validator id for the detail-oriented). */}
        <Badge
          variant="gray"
          data-testid="problems-source-tag"
          className={cn(
            'h-4 shrink-0 px-1 font-sans text-[10px] uppercase leading-none',
            isLink && 'gap-0.5',
          )}
        >
          {isLink ? (
            <>
              <Link2 aria-hidden="true" className="size-2.5" />
              <Trans>link</Trans>
            </>
          ) : (
            <Trans>lint</Trans>
          )}
        </Badge>
        <span className="min-w-0 truncate">
          {flatId} · {t`line ${displayLine}`}
        </span>
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

/**
 * One-shot "create the missing page" action for a dead-link row — the same
 * action as the Links panel's amber missing-page affordance, surfaced where
 * the problem is listed. Deliberately outside Fix all (a broken link may be a
 * typo; bulk-creating targets would mint duplicate files).
 */
function CreatePageButton({
  target,
  creating,
  disabled,
  onCreate,
}: {
  target: string;
  creating: boolean;
  disabled: boolean;
  onCreate: () => void;
}) {
  const { t } = useLingui();
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-6 shrink-0 px-2 text-xs"
      disabled={disabled}
      onClick={onCreate}
      aria-label={t`Create missing page ${target}`}
      data-testid="problems-create-page"
    >
      <FilePlus2 aria-hidden="true" className="size-3" />
      {creating ? <Trans>Creating</Trans> : <Trans>Create page</Trans>}
    </Button>
  );
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
  /** Live lint diagnostics for the open doc PLUS its broken-link findings —
   *  wire-loose so both the in-process lint shape and the audit plane fit. */
  diagnostics: DiagnosticLike[];
  /** Apply a fixable diagnostic's auto-fix (this-doc scope only). When absent
   *  (e.g. unit harness), fixable rows render no Fix button. */
  onFix?: (diagnostic: DiagnosticLike) => void;
  /** Apply every fixable diagnostic's auto-fix in this doc. When absent, the
   *  doc-scope Fix all button is not rendered. */
  onFixAll?: () => void;
  /** Hand one diagnostic to the docked terminal's agent as a grounded fix
   *  prompt. Desktop-only — absent on web, where rows render no Ask AI button.
   *  Offered on every row, fixable or not: AI is most useful exactly where no
   *  deterministic fix exists. */
  onAskAi?: (diagnostic: DiagnosticLike) => void;
}) {
  const { t } = useLingui();
  const [scope, setScope] = useState<PanelScope>('doc');
  // Which lint plugins actually check content, from the server-resolved
  // effective config (the same truth the diagnostics come from). Null while
  // the config hasn't loaded — the panel then makes no claim either way.
  const { data: lintConfig } = useProjectLintConfig();
  const activePlugins: LintPluginMeta[] | null =
    lintConfig === null
      ? null
      : lintConfig.effective.enabled
        ? LINT_PLUGIN_META.filter((plugin) => lintConfig.effective.plugins[plugin.id].enabled)
        : [];
  const noPluginsEnabled = activePlugins !== null && activePlugins.length === 0;
  const [audit, setAudit] = useState<ProjectAuditState>({ status: 'idle' });
  const [projectFixing, setProjectFixing] = useState<{ done: number; total: number } | null>(null);
  // The dead-link "Create page" one-shot (target being created, else null).
  // Optional context: the panel is always under PageListProvider in the app;
  // the null branch only serves bare unit harnesses (create renders disabled).
  const pageList = useOptionalPageList();
  const [creatingTarget, setCreatingTarget] = useState<string | null>(null);
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

  /**
   * One-shot fix for a dead link: create the missing target page (the same
   * action as the Links panel's amber "missing page" affordance). Deliberately
   * NOT part of Fix all — a broken link may be a typo, and bulk-creating
   * targets would silently mint duplicate files.
   */
  async function createLinkTarget(diagnostic: DiagnosticLike) {
    const target = diagnostic.linkTarget;
    if (target === undefined || creatingTarget !== null || pageList === null) return;
    setCreatingTarget(target);
    // No try/finally: the React Compiler cannot lower a finalizer clause, so
    // both exits clear the creating flag explicitly.
    try {
      await createPageFromSeedAndUpdate(
        { initialDir: '', suggestedName: target },
        { addPage: pageList.addPage },
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t`Failed to create page`);
      if (mountedRef.current) setCreatingTarget(null);
      return;
    }
    toast.success(t`Created ${target}`);
    if (mountedRef.current) setCreatingTarget(null);
    // The doc scope heals itself (the create emits the backlinks relay the
    // link-findings hook listens to); a loaded project snapshot is stale
    // truth, so refresh it in place.
    if (mountedRef.current && audit.status === 'loaded') await loadAudit();
  }

  async function loadAudit() {
    setAudit({ status: 'loading' });
    const result = await runValidationAudit();
    // A successful whole-project audit is full-plane truth — refresh the
    // shared validation store (freshness trigger 1) so the file tree's tints
    // update in the same pass. Deliberately BEFORE the mounted guard: the
    // store outlives this panel, and the fetch already completed.
    if (result !== null) replaceValidationFromAudit(result.files);
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
        <div className="flex min-w-0 items-center gap-2">
          <PanelTitle>
            <Trans>Problems</Trans>
          </PanelTitle>
          {activePlugins !== null && activePlugins.length > 0 && (
            <Tooltip>
              {/* Bare trigger = a real (focusable) button, so keyboard focus
                  opens the tooltip too; dressed as a PanelCount pill to match
                  the Graph header's node/link counts. */}
              <TooltipTrigger
                className="shrink-0 cursor-default rounded-md bg-muted-foreground/5 px-2 py-1 font-mono text-xs text-muted-foreground"
                data-testid="problems-active-plugins"
              >
                <Plural value={activePlugins.length} one="# plugin" other="# plugins" />
              </TooltipTrigger>
              <TooltipContent data-testid="problems-active-plugins-tooltip">
                <Trans>Checked by: {activePlugins.map((plugin) => plugin.label).join(', ')}</Trans>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {scope === 'doc' && sorted.length > 0 && <PanelCount>{sorted.length}</PanelCount>}
      </PanelHeader>
      <PanelScopeHeader scope={scope} onScopeChange={handleScopeChange} />
      {scope === 'doc' ? (
        <PanelBody className="px-2 py-2">
          {sorted.length === 0 ? (
            noPluginsEnabled ? (
              // Zero lint plugins narrows the plane to link validation alone —
              // say so instead of an unqualified "no problems", and point at
              // the switch. Only the empty list carries the hint: link
              // findings still render, so the body is never blanked.
              <>
                <PanelEmpty className="px-2" data-testid="problems-no-plugins">
                  <Trans>
                    No problems found — but no lint plugins are enabled, so only links are checked.
                  </Trans>
                </PanelEmpty>
                <div className="px-2 pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={openProjectPluginsSettings}
                    data-testid="problems-enable-plugins"
                  >
                    <Trans>Enable plugins</Trans>
                  </Button>
                </div>
              </>
            ) : (
              <PanelEmpty className="px-2">
                <Trans>No problems found.</Trans>
              </PanelEmpty>
            )
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
                  const canCreate = diagnostic.linkTarget !== undefined && pageList !== null;
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
                      {fixable || onAskAi !== undefined || canCreate ? (
                        // Bottom-right, revealed on hover/focus. `bg-muted`
                        // matches the row's own hover background so it cleanly
                        // occludes the `source/code · line` subline underneath
                        // if a long id would otherwise run beneath it.
                        <div className="absolute bottom-1 right-1 flex items-center gap-1 rounded bg-muted opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none">
                          {canCreate ? (
                            <CreatePageButton
                              target={diagnostic.linkTarget ?? ''}
                              creating={creatingTarget === diagnostic.linkTarget}
                              disabled={creatingTarget !== null}
                              onCreate={() => void createLinkTarget(diagnostic)}
                            />
                          ) : null}
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
          onCreateTarget={pageList !== null ? (d) => void createLinkTarget(d) : undefined}
          creatingTarget={creatingTarget}
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
  onCreateTarget,
  creatingTarget,
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
  /** Create a dead-link row's missing target page; absent in bare harnesses. */
  onCreateTarget?: (diagnostic: DiagnosticLike) => void;
  creatingTarget: string | null;
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
        <ProjectAuditResults
          result={audit.result}
          onNavigate={onNavigate}
          onCreateTarget={onCreateTarget}
          creatingTarget={creatingTarget}
        />
      )}
    </PanelBody>
  );
}

function ProjectAuditResults({
  result,
  onNavigate,
  onCreateTarget,
  creatingTarget,
}: {
  result: ValidationAuditResponse;
  onNavigate: (filePath: string, diagnostic: DiagnosticLike) => void;
  onCreateTarget?: (diagnostic: DiagnosticLike) => void;
  creatingTarget: string | null;
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
          <ProjectFileGroup
            key={file.file}
            file={file}
            onNavigate={onNavigate}
            onCreateTarget={onCreateTarget}
            creatingTarget={creatingTarget}
          />
        ))
      )}
    </div>
  );
}

function ProjectFileGroup({
  file,
  onNavigate,
  onCreateTarget,
  creatingTarget,
}: {
  file: ValidationDocResult;
  onNavigate: (filePath: string, diagnostic: DiagnosticLike) => void;
  onCreateTarget?: (diagnostic: DiagnosticLike) => void;
  creatingTarget: string | null;
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
            const canCreate = diagnostic.linkTarget !== undefined && onCreateTarget !== undefined;
            return (
              <li
                key={diagnosticKey(diagnostic)}
                className="group relative rounded transition-colors hover:bg-muted"
              >
                <button
                  type="button"
                  onClick={() => onNavigate(file.file, diagnostic)}
                  className="flex w-full cursor-pointer flex-col gap-0.5 rounded px-2 py-1.5 text-left"
                  title={t`Go to line ${displayLine} in ${file.file}`}
                >
                  <DiagnosticRowBody diagnostic={diagnostic} />
                </button>
                {canCreate ? (
                  // Same hover-revealed overlay contract as the doc scope's
                  // Fix / Ask AI actions.
                  <div className="absolute bottom-1 right-1 flex items-center gap-1 rounded bg-muted opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none">
                    <CreatePageButton
                      target={diagnostic.linkTarget ?? ''}
                      creating={creatingTarget === diagnostic.linkTarget}
                      disabled={creatingTarget !== null}
                      onCreate={() => onCreateTarget?.(diagnostic)}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
