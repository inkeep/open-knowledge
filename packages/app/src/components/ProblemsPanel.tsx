// biome-ignore-all lint/plugin/no-raw-html-interactive-element: matches sibling OutlinePanel — positional list of <button> rows awaiting a shared shadcn list primitive; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit
import {
  type FrontmatterScope,
  isEditableTextDocFile,
  type ValidationAuditResponse,
  type ValidationDocResult,
} from '@inkeep/open-knowledge-core';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  AlertCircle,
  AlertTriangle,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  File as FileIcon,
  FilePlus2,
  Image as ImageIcon,
  Link2,
  type LucideIcon,
  RefreshCw,
  Sparkles,
  Wrench,
} from 'lucide-react';
import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import type { PanelTab } from '@/components/DocPanel';
import {
  consumePendingDocPanelRequest,
  type DocPanelTabRequest,
  subscribeToDocPanelTabRequests,
} from '@/components/doc-panel-events';
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
import {
  fixLintDoc,
  subscribeToLintConfigChanged,
  useProjectLintConfig,
} from '@/editor/lint-config-client';
import { localizedValidationMessage } from '@/editor/localized-validation-message';
import { rememberPendingSourceNavigation } from '@/editor/source-editor-navigation';
import { AUDIT_SUPERSEDED, runValidationAudit } from '@/editor/validation-audit-client';
import { createPageFromSeedAndUpdate } from '@/lib/create-page';
import { filePathToDocName, hashFromDocName } from '@/lib/doc-hash';
import { invalidatesLocalTargetAudit, subscribeToDocumentsChanged } from '@/lib/documents-events';
import {
  cancelProjectFixSweep,
  startProjectFixSweep,
  subscribeToProjectFixSweepSettled,
  useProjectFixSweep,
} from '@/lib/project-fix-sweep-store';
import { openProjectPluginsSettings } from '@/lib/use-settings-route';
import { cn } from '@/lib/utils';
import { replaceValidationFromAudit } from '@/lib/validation-store';

export interface LintNavDetail {
  docName: string;
  line: number;
  column: number;
  source?: string;
  frontmatterScope?: FrontmatterScope;
}

export const LINT_NAV_EVENT = 'open-knowledge:lint-nav';

export type DiagnosticLike = ValidationDocResult['diagnostics'][number];

function compareDiagnostics(a: DiagnosticLike, b: DiagnosticLike): number {
  return (
    a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character
  );
}

function lintNavDetailOf(docName: string, diagnostic: DiagnosticLike): LintNavDetail {
  return {
    docName,
    line: diagnostic.range.start.line + 1,
    column: diagnostic.range.start.character + 1,
    source: diagnostic.source,
    ...(diagnostic.frontmatterScope === undefined
      ? {}
      : { frontmatterScope: diagnostic.frontmatterScope }),
  };
}

type ProjectAuditState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; result: ValidationAuditResponse }
  | { status: 'failed' };

type LinkTargetKind = 'document' | 'file' | 'image' | 'unresolvable';

function linkTargetKindOf(diagnostic: DiagnosticLike): LinkTargetKind | null {
  if (diagnostic.source !== 'links') return null;
  const evidence = diagnostic.localTarget;
  if (evidence === undefined) return 'document';
  if (evidence.role === 'image') return 'image';
  if (evidence.targetKind === 'file') return 'file';
  if (evidence.targetKind === 'document') return 'document';
  return 'unresolvable';
}

const LINK_TARGET_ICON: Record<LinkTargetKind, LucideIcon> = {
  document: Link2,
  file: FileIcon,
  image: ImageIcon,
  unresolvable: Link2,
};

function canCreateMissingPage(diagnostic: DiagnosticLike): boolean {
  return diagnostic.linkTarget !== undefined && linkTargetKindOf(diagnostic) === 'document';
}

function DiagnosticRowBody({
  diagnostic,
  instanceCount,
}: {
  diagnostic: DiagnosticLike;
  instanceCount?: number;
}) {
  const { t } = useLingui();
  const Icon = diagnostic.severity === 'error' ? AlertCircle : AlertTriangle;
  const displayLine = diagnostic.range.start.line + 1;
  const targetKind = linkTargetKindOf(diagnostic);
  const KindIcon = targetKind === null ? null : LINK_TARGET_ICON[targetKind];
  const grouped = instanceCount !== undefined && instanceCount > 1;
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
        <span className="min-w-0 flex-1 text-foreground">
          {localizedValidationMessage(diagnostic)}
        </span>
        {grouped ? (
          <span className="mt-0.5 flex shrink-0 items-center gap-1">
            <Badge
              variant="gray"
              data-testid="problems-instance-count"
              className="h-4 px-1 font-sans text-[10px] leading-none"
            >
              <Plural value={instanceCount} one="# instance" other="# instances" />
            </Badge>
            <ChevronRight
              aria-hidden="true"
              className="size-3 text-muted-foreground transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
            />
          </span>
        ) : null}
      </span>
      <span className="flex items-center gap-1.5 ps-5 font-mono text-xs text-muted-foreground">
        {}
        <Badge
          variant="gray"
          data-testid="problems-source-tag"
          data-target-kind={targetKind ?? undefined}
          className={cn(
            'h-4 shrink-0 px-1 font-sans text-[10px] uppercase leading-none',
            KindIcon !== null && 'gap-0.5',
          )}
        >
          {KindIcon !== null ? <KindIcon aria-hidden="true" className="size-2.5" /> : null}
          {diagnostic.source}
        </Badge>
        {}
        <span className="min-w-0 truncate">
          {grouped ? diagnostic.code : `${diagnostic.code} · ${t`line ${displayLine}`}`}
        </span>
      </span>
    </>
  );
}

interface DiagnosticGroup {
  key: string;
  instances: [DiagnosticLike, ...DiagnosticLike[]];
}

function groupDiagnostics(sorted: readonly DiagnosticLike[]): DiagnosticGroup[] {
  const byKey = new Map<string, DiagnosticGroup>();
  for (const diagnostic of sorted) {
    const key = `${diagnostic.source}/${diagnostic.code}\u0000${diagnostic.linkTarget ?? ''}\u0000${diagnostic.message}`;
    const existing = byKey.get(key);
    if (existing === undefined) byKey.set(key, { key, instances: [diagnostic] });
    else existing.instances.push(diagnostic);
  }
  return [...byKey.values()];
}

function DiagnosticGroupItem({
  group,
  onNavigate,
  navTitle,
  renderActions,
}: {
  group: DiagnosticGroup;
  onNavigate: (diagnostic: DiagnosticLike) => void;
  navTitle: (diagnostic: DiagnosticLike) => string;
  renderActions: (diagnostic: DiagnosticLike) => ReactElement | null;
}) {
  const { t } = useLingui();
  const first = group.instances[0];
  const localizedFirstMessage = localizedValidationMessage(first);

  if (group.instances.length === 1) {
    const actions = renderActions(first);
    return (
      <li className="group relative rounded transition-colors hover:bg-muted">
        {}
        <button
          type="button"
          onClick={() => onNavigate(first)}
          className="flex w-full cursor-pointer flex-col gap-0.5 rounded px-2 py-1.5 text-left"
          title={navTitle(first)}
        >
          <DiagnosticRowBody diagnostic={first} />
        </button>
        {actions === null ? null : (
          <div className="absolute bottom-1 right-1 flex items-center gap-1 rounded bg-muted opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none">
            {actions}
          </div>
        )}
      </li>
    );
  }

  return (
    <li className="rounded" data-testid="problems-duplicate-group">
      <Collapsible>
        {}
        <CollapsibleTrigger className="group flex w-full cursor-pointer flex-col gap-0.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-muted">
          <DiagnosticRowBody diagnostic={first} instanceCount={group.instances.length} />
        </CollapsibleTrigger>
        <CollapsibleContent className="overflow-hidden data-[state=open]:animate-[collapsible-down_150ms_ease-out] data-[state=closed]:animate-[collapsible-up_150ms_ease-in] motion-reduce:animate-none">
          <ul
            aria-label={t`Occurrences of ${localizedFirstMessage}`}
            className="flex flex-col gap-0.5 pb-1 ps-5"
            data-testid="problems-duplicate-instances"
          >
            {group.instances.map((diagnostic) => {
              const actions = renderActions(diagnostic);
              const displayLine = diagnostic.range.start.line + 1;
              const localizedMessage = localizedValidationMessage(diagnostic);
              return (
                <li
                  key={diagnosticKey(diagnostic)}
                  className="group relative rounded transition-colors hover:bg-muted"
                >
                  <button
                    type="button"
                    onClick={() => onNavigate(diagnostic)}
                    className="flex w-full cursor-pointer rounded px-2 py-1 text-left font-mono text-xs text-muted-foreground"
                    title={navTitle(diagnostic)}
                    aria-label={t`${localizedMessage} at line ${displayLine}`}
                  >
                    {t`line ${displayLine}`}
                  </button>
                  {actions === null ? null : (
                    <div className="absolute bottom-0.5 right-1 flex items-center gap-1 rounded bg-muted opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none">
                      {actions}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function diagnosticKey(diagnostic: DiagnosticLike): string {
  return `${diagnostic.source}/${diagnostic.code}-${diagnostic.range.start.line}-${diagnostic.range.start.character}-${diagnostic.message}`;
}

function countFixable(diagnostics: readonly DiagnosticLike[]): number {
  return diagnostics.reduce((n, d) => n + ((d.fixes?.length ?? 0) > 0 ? 1 : 0), 0);
}

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

function ActionTooltip({
  tip,
  testId,
  children,
}: {
  tip: ReactNode;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {}
        <span className="inline-flex shrink-0">{children}</span>
      </TooltipTrigger>
      <TooltipContent data-testid={testId}>{tip}</TooltipContent>
    </Tooltip>
  );
}

function AutoFixButton({
  count,
  problemCount,
  aiAvailable,
  disabled,
  onClick,
  children,
}: {
  count: number;
  problemCount: number;
  aiAvailable: boolean;
  disabled: boolean;
  onClick: () => void;
  children?: ReactNode;
}) {
  const { t } = useLingui();
  return (
    <ActionTooltip
      testId="problems-auto-fix-tip"
      tip={
        count > 0 ? (
          <Plural
            value={count}
            one="Instantly fixes the # problem that has a known automatic fix."
            other="Instantly fixes the # problems that have a known automatic fix."
          />
        ) : problemCount === 0 ? (
          <Trans>Auto-fix applies only to problems with a known mechanical fix.</Trans>
        ) : aiAvailable ? (
          <Trans>None of these problems have an automatic fix. Try Fix all with AI.</Trans>
        ) : (
          <Trans>None of these problems have an automatic fix.</Trans>
        )
      }
    >
      <Button
        size="sm"
        variant="ghost"
        className="h-6 shrink-0 px-2 text-xs"
        disabled={disabled}
        onClick={onClick}
        aria-label={
          children !== undefined
            ? undefined
            : problemCount === 0
              ? t`Auto-fix — nothing to fix`
              : count === 0
                ? t`Auto-fix — no problems here have an automatic fix`
                : undefined
        }
        data-testid="problems-auto-fix"
      >
        <Wrench aria-hidden="true" className="size-3" />
        {children ?? <Trans>Auto-fix ({count})</Trans>}
      </Button>
    </ActionTooltip>
  );
}

function FixWithAiButton({
  count,
  disabled,
  onClick,
}: {
  count: number;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <ActionTooltip
      testId="problems-fix-with-ai-tip"
      tip={
        <Plural
          value={count}
          one="Hands the # problem to your AI agent, including what has no automatic fix."
          other="Hands all # problems to your AI agent, including what has no automatic fix."
        />
      }
    >
      <Button
        size="sm"
        variant="ghost"
        className="h-6 shrink-0 px-2 text-xs"
        disabled={disabled}
        onClick={onClick}
        data-testid="problems-fix-with-ai"
      >
        <Sparkles aria-hidden="true" className="size-3" />
        <Trans>Fix all with AI ({count})</Trans>
      </Button>
    </ActionTooltip>
  );
}

export function ProblemsPanel({
  docName,
  diagnostics,
  linkFindingsStatus = 'loaded',
  onFix,
  onAutoFix,
  onAskAi,
  onFixWithAi,
}: {
  docName: string;
  diagnostics: DiagnosticLike[];
  linkFindingsStatus?: 'idle' | 'loading' | 'loaded' | 'failed';
  onFix?: (diagnostic: DiagnosticLike) => void;
  onAutoFix?: () => void;
  onAskAi?: (diagnostic: DiagnosticLike) => void;
  onFixWithAi?: (scope: PanelScope) => void;
}) {
  const { t } = useLingui();
  const panelRef = useRef<HTMLElement>(null);
  const panelTitleId = useId();
  const [scope, setScope] = useState<PanelScope>('doc');
  const markdownChecksApply = !isEditableTextDocFile(docName);
  const { data: lintConfig } = useProjectLintConfig();
  const activePlugins: LintPluginMeta[] | null =
    lintConfig === null
      ? null
      : lintConfig.effective.enabled
        ? LINT_PLUGIN_META.filter((plugin) => lintConfig.effective.plugins[plugin.id].enabled)
        : [];
  const noPluginsEnabled = activePlugins !== null && activePlugins.length === 0;
  const showActivePluginsPill =
    (scope === 'project' || markdownChecksApply) &&
    activePlugins !== null &&
    activePlugins.length > 0;
  const [audit, setAudit] = useState<ProjectAuditState>({ status: 'idle' });
  const projectFixing = useProjectFixSweep();
  const pageList = useOptionalPageList();
  const [creatingTarget, setCreatingTarget] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const onLintConfigChangedRef = useRef<() => void>(() => {});
  const onSweepSettledRef = useRef<() => void>(() => {});
  const settledAuditRef = useRef<ProjectAuditState>({ status: 'idle' });
  useEffect(() => {
    if (audit.status !== 'loading') settledAuditRef.current = audit;
  });
  const loadGenRef = useRef(0);

  const sorted = [...diagnostics].sort(compareDiagnostics);
  const docFixableCount = countFixable(sorted);

  async function loadAudit() {
    loadGenRef.current += 1;
    const generation = loadGenRef.current;
    const fallback = settledAuditRef.current;
    setAudit({ status: 'loading' });
    const result = await runValidationAudit();
    if (result === AUDIT_SUPERSEDED) {
      if (loadGenRef.current === generation && mountedRef.current) {
        setAudit(fallback.status === 'idle' ? { status: 'failed' } : fallback);
      }
      return;
    }
    if (result !== null) replaceValidationFromAudit(result.files);
    if (!mountedRef.current) return;
    setAudit(result === null ? { status: 'failed' } : { status: 'loaded', result });
  }

  async function createLinkTarget(diagnostic: DiagnosticLike) {
    const target = diagnostic.linkTarget;
    if (target === undefined || creatingTarget !== null || pageList === null) return;
    setCreatingTarget(target);
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
    if (mountedRef.current && audit.status === 'loaded') await loadAudit();
  }

  const projectFixableFiles =
    audit.status === 'loaded'
      ? audit.result.files.filter((file) =>
          file.diagnostics.some((d) => (d.fixes?.length ?? 0) > 0),
        )
      : [];

  function fixAllProjectFiles() {
    void startProjectFixSweep({
      items: projectFixableFiles,
      fixItem: (file) => fixLintDoc(filePathToDocName(file.file)),
    });
  }

  function handleScopeChange(next: PanelScope) {
    setScope(next);
    if (next === 'project' && audit.status === 'idle') void loadAudit();
  }

  useEffect(() => {
    onLintConfigChangedRef.current = () => {
      if (audit.status === 'idle' || audit.status === 'failed') return;
      void loadAudit();
    };
  });
  useEffect(() => subscribeToLintConfigChanged(() => onLintConfigChangedRef.current()), []);
  useEffect(
    () =>
      subscribeToDocumentsChanged((channels) => {
        if (invalidatesLocalTargetAudit(channels)) onLintConfigChangedRef.current();
      }),
    [],
  );

  const onDocPanelTabRequest = useEffectEvent((tab: PanelTab, request: DocPanelTabRequest) => {
    if (tab !== 'problems') return;
    consumePendingDocPanelRequest('problems');
    if (request.scope !== undefined) handleScopeChange(request.scope);
    if (request.focus === 'panel') panelRef.current?.focus({ preventScroll: true });
  });
  useEffect(() => {
    const pending = consumePendingDocPanelRequest('problems');
    if (pending !== null) onDocPanelTabRequest('problems', pending);
    return subscribeToDocPanelTabRequests(onDocPanelTabRequest);
  }, []);

  useEffect(() => {
    onSweepSettledRef.current = () => {
      if (audit.status === 'idle' || audit.status === 'failed') return;
      void loadAudit().catch((err) => {
        console.warn('[lint] post-sweep re-audit failed', err);
        if (mountedRef.current) setAudit({ status: 'failed' });
      });
    };
  });
  useEffect(() => subscribeToProjectFixSweepSettled(() => onSweepSettledRef.current()), []);

  function handleNav(diagnostic: DiagnosticLike) {
    const detail = lintNavDetailOf(docName, diagnostic);
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
      detail: lintNavDetailOf(targetDocName, diagnostic),
    });
    window.location.hash = hashFromDocName(targetDocName);
  }

  function renderDocActions(diagnostic: DiagnosticLike): ReactElement | null {
    const fixable = onFix !== undefined && (diagnostic.fixes?.length ?? 0) > 0;
    const canCreate = canCreateMissingPage(diagnostic) && pageList !== null;
    if (!fixable && !canCreate && onAskAi === undefined) return null;
    const flatId = `${diagnostic.source}/${diagnostic.code}`;
    return (
      <>
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
      </>
    );
  }

  return (
    <Panel ref={panelRef} tabIndex={-1} aria-labelledby={panelTitleId} data-testid="problems-panel">
      <PanelHeader>
        <div className="flex min-w-0 items-center gap-2">
          <PanelTitle id={panelTitleId}>
            <Trans>Problems</Trans>
          </PanelTitle>
          {showActivePluginsPill && (
            <Tooltip>
              {}
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
          {linkFindingsStatus === 'idle' || linkFindingsStatus === 'loading' ? (
            <PanelEmpty
              className="px-2 pb-2"
              role="status"
              aria-live="polite"
              data-testid="problems-links-loading"
            >
              <Trans>Checking links</Trans>
            </PanelEmpty>
          ) : linkFindingsStatus === 'failed' ? (
            <PanelError className="px-2 pb-2" role="status" data-testid="problems-links-failed">
              {sorted.length > 0 ? (
                <Trans>Link validation is unavailable. Showing last known problems.</Trans>
              ) : (
                <Trans>Link validation is unavailable.</Trans>
              )}
            </PanelError>
          ) : null}
          {sorted.length === 0 ? (
            linkFindingsStatus !== 'loaded' ? null : !markdownChecksApply ? (
              <PanelEmpty className="px-2" data-testid="problems-markdown-not-applicable">
                <Trans>Markdown checks do not apply to this file.</Trans>
              </PanelEmpty>
            ) : noPluginsEnabled ? (
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
              {onAutoFix !== undefined || onFixWithAi !== undefined ? (
                <div className="flex flex-wrap items-center justify-end gap-1 px-2 pb-1">
                  {onAutoFix !== undefined && (
                    <AutoFixButton
                      count={docFixableCount}
                      problemCount={sorted.length}
                      aiAvailable={onFixWithAi !== undefined}
                      disabled={docFixableCount === 0}
                      onClick={onAutoFix}
                    />
                  )}
                  {onFixWithAi !== undefined && (
                    <FixWithAiButton
                      count={sorted.length}
                      disabled={false}
                      onClick={() => onFixWithAi('doc')}
                    />
                  )}
                </div>
              ) : null}
              <ul aria-label={t`Problems`} className="flex flex-col gap-0.5">
                {groupDiagnostics(sorted).map((group) => (
                  <DiagnosticGroupItem
                    key={group.key}
                    group={group}
                    onNavigate={handleNav}
                    navTitle={(diagnostic) => t`Go to line ${diagnostic.range.start.line + 1}`}
                    renderActions={renderDocActions}
                  />
                ))}
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
          problemCount={
            audit.status === 'loaded'
              ? audit.result.files.reduce((n, f) => n + f.diagnostics.length, 0)
              : 0
          }
          fixing={projectFixing}
          onAutoFix={fixAllProjectFiles}
          onCancelFix={cancelProjectFixSweep}
          onFixWithAi={
            onFixWithAi === undefined || audit.status !== 'loaded'
              ? undefined
              : () => onFixWithAi('project')
          }
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
  problemCount,
  fixing,
  onAutoFix,
  onCancelFix,
  onFixWithAi,
  onCreateTarget,
  creatingTarget,
}: {
  audit: ProjectAuditState;
  onRefresh: () => void;
  onNavigate: (filePath: string, diagnostic: DiagnosticLike) => void;
  fixableCount: number;
  problemCount: number;
  fixing: { done: number; total: number } | null;
  onAutoFix: () => void;
  onCancelFix: () => void;
  onFixWithAi?: () => void;
  onCreateTarget?: (diagnostic: DiagnosticLike) => void;
  creatingTarget: string | null;
}) {
  const { t } = useLingui();
  const loading = audit.status === 'loading' || audit.status === 'idle';
  const loadedFiles = audit.status === 'loaded' ? audit.result.files : [];
  const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(() => new Set());
  const allExpanded =
    loadedFiles.length > 0 && loadedFiles.every((file) => expandedFiles.has(file.file));
  function toggleFile(file: string, open: boolean) {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (open) next.add(file);
      else next.delete(file);
      return next;
    });
  }
  function toggleAll() {
    setExpandedFiles(allExpanded ? new Set() : new Set(loadedFiles.map((file) => file.file)));
  }
  return (
    <PanelBody className="px-2 py-2" data-testid="problems-project-scope">
      {}
      <div className="flex flex-col gap-1 px-2 pb-1">
        <div className="flex items-center justify-between gap-2">
          <p
            className="min-w-0 truncate text-xs text-muted-foreground"
            data-testid="problems-audit-summary"
          >
            {audit.status === 'loaded' && (
              <>
                <Plural value={audit.result.errorCount} one="# error" other="# errors" />
                {' · '}
                <Plural value={audit.result.warningCount} one="# warning" other="# warnings" />
              </>
            )}
          </p>
          <div className="flex shrink-0 items-center gap-1">
            {}
            {loadedFiles.length > 0 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0 text-muted-foreground"
                    aria-label={
                      allExpanded ? t`Collapse all file groups` : t`Expand all file groups`
                    }
                    data-testid="problems-audit-expand-toggle"
                    onClick={toggleAll}
                  >
                    {allExpanded ? (
                      <ChevronsDownUp aria-hidden="true" className="size-3.5" />
                    ) : (
                      <ChevronsUpDown aria-hidden="true" className="size-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent data-testid="problems-audit-expand-toggle-tooltip">
                  {allExpanded ? (
                    <Trans>Collapse all file groups</Trans>
                  ) : (
                    <Trans>Expand all file groups</Trans>
                  )}
                </TooltipContent>
              </Tooltip>
            ) : null}
            {}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 shrink-0 text-muted-foreground"
                  aria-label={t`Re-run the project audit`}
                  data-testid="problems-audit-refresh"
                  disabled={loading || fixing !== null}
                  onClick={onRefresh}
                >
                  <RefreshCw aria-hidden="true" className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent data-testid="problems-audit-refresh-tooltip">
                <Trans>Re-run the project audit</Trans>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1">
          {}
          {fixing !== null ? (
            <span className="sr-only" role="status">
              {t`Fixing ${fixing.done} of ${fixing.total} files`}
            </span>
          ) : null}
          {}
          {fixing !== null ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 px-2 text-muted-foreground"
                  aria-label={t`Stop fixing files`}
                  data-testid="problems-cancel-fix"
                  onClick={onCancelFix}
                >
                  <Trans>Stop</Trans>
                </Button>
              </TooltipTrigger>
              <TooltipContent data-testid="problems-cancel-fix-tooltip">
                <Trans>Stop fixing. Files already fixed stay fixed.</Trans>
              </TooltipContent>
            </Tooltip>
          ) : null}
          <AutoFixButton
            count={fixableCount}
            problemCount={problemCount}
            aiAvailable={onFixWithAi !== undefined}
            disabled={loading || fixing !== null || fixableCount === 0}
            onClick={onAutoFix}
          >
            {fixing !== null ? (
              <Trans>
                Fixing {fixing.done}/{fixing.total}
              </Trans>
            ) : undefined}
          </AutoFixButton>
          {onFixWithAi !== undefined && problemCount > 0 ? (
            <FixWithAiButton
              count={problemCount}
              disabled={fixing !== null}
              onClick={onFixWithAi}
            />
          ) : null}
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
          expandedFiles={expandedFiles}
          onToggleFile={toggleFile}
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
  expandedFiles,
  onToggleFile,
}: {
  result: ValidationAuditResponse;
  onNavigate: (filePath: string, diagnostic: DiagnosticLike) => void;
  onCreateTarget?: (diagnostic: DiagnosticLike) => void;
  creatingTarget: string | null;
  expandedFiles: ReadonlySet<string>;
  onToggleFile: (file: string, open: boolean) => void;
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
            open={expandedFiles.has(file.file)}
            onOpenChange={(open) => onToggleFile(file.file, open)}
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
  open,
  onOpenChange,
}: {
  file: ValidationDocResult;
  onNavigate: (filePath: string, diagnostic: DiagnosticLike) => void;
  onCreateTarget?: (diagnostic: DiagnosticLike) => void;
  creatingTarget: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const sorted = [...file.diagnostics].sort(compareDiagnostics);
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} data-testid="problems-audit-group">
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
      <CollapsibleContent className="overflow-hidden data-[state=open]:animate-[collapsible-down_150ms_ease-out] data-[state=closed]:animate-[collapsible-up_150ms_ease-in] motion-reduce:animate-none">
        <ul aria-label={t`Problems in ${file.file}`} className="flex flex-col gap-0.5 pb-1 ps-3">
          {groupDiagnostics(sorted).map((group) => (
            <DiagnosticGroupItem
              key={group.key}
              group={group}
              onNavigate={(diagnostic) => onNavigate(file.file, diagnostic)}
              navTitle={(diagnostic) =>
                t`Go to line ${diagnostic.range.start.line + 1} in ${file.file}`
              }
              renderActions={(diagnostic) =>
                !canCreateMissingPage(diagnostic) || onCreateTarget === undefined ? null : (
                  <CreatePageButton
                    target={diagnostic.linkTarget ?? ''}
                    creating={creatingTarget === diagnostic.linkTarget}
                    disabled={creatingTarget !== null}
                    onCreate={() => onCreateTarget(diagnostic)}
                  />
                )
              }
            />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
