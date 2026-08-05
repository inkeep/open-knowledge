// biome-ignore-all lint/plugin/no-raw-html-interactive-element: matches sibling OutlinePanel — positional list of <button> rows awaiting a shared shadcn list primitive; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
import type { ValidationAuditResponse, ValidationDocResult } from '@inkeep/open-knowledge-core';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  AlertCircle,
  AlertTriangle,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FilePlus2,
  Link2,
  RefreshCw,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { type ReactElement, type ReactNode, useEffect, useRef, useState } from 'react';
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
import {
  fixLintDoc,
  subscribeToLintConfigChanged,
  useProjectLintConfig,
} from '@/editor/lint-config-client';
import { rememberPendingSourceNavigation } from '@/editor/source-editor-navigation';
import { AUDIT_SUPERSEDED, runValidationAudit } from '@/editor/validation-audit-client';
import { createPageFromSeedAndUpdate } from '@/lib/create-page';
import { filePathToDocName, hashFromDocName } from '@/lib/doc-hash';
import {
  cancelProjectFixSweep,
  startProjectFixSweep,
  subscribeToProjectFixSweepSettled,
  useProjectFixSweep,
} from '@/lib/project-fix-sweep-store';
import { openProjectPluginsSettings } from '@/lib/use-settings-route';
import { cn } from '@/lib/utils';
import { replaceValidationFromAudit } from '@/lib/validation-store';

/** Jump-to-line intent dispatched when a problem row is clicked in source mode. */
export interface LintNavDetail {
  /** The document that owns this navigation request. */
  docName: string;
  /** 1-based line in `Y.Text('source')` (full doc incl. frontmatter). */
  line: number;
  /** 1-based column. */
  column: number;
  /**
   * Producing plugin id. WYSIWYG needs it to decline navigation for
   * diagnostics that have no body anchor: a `frontmatter` violation reports on
   * the region's opening fence, which on a doc with no frontmatter is line 1 —
   * following it would select the first body block, which is not the problem.
   * Source mode anchors by line and consumes every source alike.
   */
  source?: string;
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
function lintNavDetailOf(docName: string, diagnostic: DiagnosticLike): LintNavDetail {
  return {
    docName,
    line: diagnostic.range.start.line + 1,
    column: diagnostic.range.start.character + 1,
    source: diagnostic.source,
  };
}

type ProjectAuditState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; result: ValidationAuditResponse }
  | { status: 'failed' };

/** Message line + producer chip + `code · line` subline shared by doc- and project-scope rows. */
function DiagnosticRowBody({
  diagnostic,
  instanceCount,
}: {
  diagnostic: DiagnosticLike;
  /** When above 1, the row counts occurrences instead of naming a single line. */
  instanceCount?: number;
}) {
  const { t } = useLingui();
  const Icon = diagnostic.severity === 'error' ? AlertCircle : AlertTriangle;
  const displayLine = diagnostic.range.start.line + 1;
  const isLink = diagnostic.source === 'links';
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
        <span className="min-w-0 flex-1 text-foreground">{diagnostic.message}</span>
        {grouped ? (
          // Count and disclosure both sit on the right so a grouped row keeps
          // the exact left edge of an ungrouped one — a leading chevron indents
          // the icon and message and leaves the list visibly ragged, and
          // reserving a twistie gutter on every row would cost width this panel
          // does not have. The count rides the message line — the `flex-1`
          // element that absorbs panel narrowing and wraps — not the subline,
          // whose code text already ellipsis-truncates.
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
        {/* The chip names the validator that PRODUCED the finding, not a generic
            category — `frontmatter/required` and `markdownlint/MD041` are
            otherwise indistinguishable at a glance, and the plane keeps
            absorbing validators. Rendered from the machine `source` verbatim so
            a new validator needs no table here, and untranslated because those
            ids are brand names. (The header and settings sidebar show the
            friendlier `lint-plugin-meta` label instead — e.g. `frontmatter` →
            "Frontmatter schemas" — which `links` has no entry for.) The subline
            then carries the bare rule code, not the redundant `source/code`. */}
        <Badge
          variant="gray"
          data-testid="problems-source-tag"
          className={cn(
            'h-4 shrink-0 px-1 font-sans text-[10px] uppercase leading-none',
            isLink && 'gap-0.5',
          )}
        >
          {isLink ? <Link2 aria-hidden="true" className="size-2.5" /> : null}
          {diagnostic.source}
        </Badge>
        {/* A group spans many lines, so only a single finding names one. */}
        <span className="min-w-0 truncate">
          {grouped ? diagnostic.code : `${diagnostic.code} · ${t`line ${displayLine}`}`}
        </span>
      </span>
    </>
  );
}

/** Repeats of one finding — same producer, rule, message and link target. */
interface DiagnosticGroup {
  key: string;
  /** At least one, ordered by line then column. */
  instances: [DiagnosticLike, ...DiagnosticLike[]];
}

/**
 * Collapse repeats of one finding into a single group. A schema rule that fires
 * on every document property (or a hard-tab rule on every indented line) would
 * otherwise bury the rest of the plane under identical rows. Insertion order is
 * first occurrence, so the grouped list stays line-sorted.
 */
function groupDiagnostics(sorted: readonly DiagnosticLike[]): DiagnosticGroup[] {
  const byKey = new Map<string, DiagnosticGroup>();
  for (const diagnostic of sorted) {
    // NUL-joined: the message is free text and could otherwise forge a key
    // that collides with another rule's group.
    const key = `${diagnostic.source}/${diagnostic.code}\u0000${diagnostic.linkTarget ?? ''}\u0000${diagnostic.message}`;
    const existing = byKey.get(key);
    if (existing === undefined) byKey.set(key, { key, instances: [diagnostic] });
    else existing.instances.push(diagnostic);
  }
  return [...byKey.values()];
}

/**
 * One row per distinct finding. A lone occurrence renders exactly as before; a
 * repeated one collapses behind an instance count and expands to per-line
 * occurrences, each keeping its own actions (a fix is per-occurrence).
 */
function DiagnosticGroupItem({
  group,
  onNavigate,
  navTitle,
  renderActions,
}: {
  group: DiagnosticGroup;
  onNavigate: (diagnostic: DiagnosticLike) => void;
  /** Hover title for one occurrence. */
  navTitle: (diagnostic: DiagnosticLike) => string;
  /** Hover-revealed actions for one occurrence; null when it offers none. The
   *  consumer keys the overlay on a strict `=== null`, so the sentinel must be
   *  `null` (not `undefined`/`false`) — hence `ReactElement | null`, not `ReactNode`. */
  renderActions: (diagnostic: DiagnosticLike) => ReactElement | null;
}) {
  const { t } = useLingui();
  // `groupDiagnostics` seeds every group with one instance and only ever pushes,
  // so the non-empty tuple type guarantees a first element.
  const first = group.instances[0];

  if (group.instances.length === 1) {
    const actions = renderActions(first);
    return (
      <li className="group relative rounded transition-colors hover:bg-muted">
        {/* Full-width message: the actions are pulled out of flow (absolute,
            below) so the diagnostic text uses the whole row and wraps, instead
            of being squeezed to make room for the buttons. */}
        <button
          type="button"
          onClick={() => onNavigate(first)}
          className="flex w-full cursor-pointer flex-col gap-0.5 rounded px-2 py-1.5 text-left"
          title={navTitle(first)}
        >
          <DiagnosticRowBody diagnostic={first} />
        </button>
        {actions === null ? null : (
          // Bottom-right, revealed on hover/focus. `bg-muted` matches the row's
          // own hover background so it cleanly occludes the subline underneath.
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
        {/* Same padding and column layout as the single-finding row above, so
            both left edges line up; the disclosure chevron rides the right. */}
        <CollapsibleTrigger className="group flex w-full cursor-pointer flex-col gap-0.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-muted">
          <DiagnosticRowBody diagnostic={first} instanceCount={group.instances.length} />
        </CollapsibleTrigger>
        <CollapsibleContent className="overflow-hidden data-[state=open]:animate-[collapsible-down_150ms_ease-out] data-[state=closed]:animate-[collapsible-up_150ms_ease-in] motion-reduce:animate-none">
          <ul
            aria-label={t`Occurrences of ${first.message}`}
            className="flex flex-col gap-0.5 pb-1 ps-5"
            data-testid="problems-duplicate-instances"
          >
            {group.instances.map((diagnostic) => {
              const actions = renderActions(diagnostic);
              const displayLine = diagnostic.range.start.line + 1;
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
                    // The visible text is just the line number; the message
                    // rides the accessible name so the occurrence still reads
                    // as a whole finding out of list context.
                    aria-label={t`${diagnostic.message} at line ${displayLine}`}
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

/**
 * Wraps a possibly-disabled action in a tooltip. A disabled button emits no
 * pointer events, so the trigger hangs off a wrapper span that still receives
 * hover — the whole point here is explaining why Auto-fix is greyed out, which
 * is exactly when the button itself cannot report it. Keyboard users get the
 * same reason from the button's own `aria-label`, since the tooltip describes
 * the span rather than the control.
 */
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
        {/* `shrink-0` rides the span, not the button: the span is what the
            actions row lays out, so without it a narrow rail squeezes the
            wrapper and truncates the label the count lives in. */}
        <span className="inline-flex shrink-0">{children}</span>
      </TooltipTrigger>
      <TooltipContent data-testid={testId}>{tip}</TooltipContent>
    </Tooltip>
  );
}

/** Deterministic-fix action shared by both scopes — same look, same position in
 *  the actions row; only the click handler's blast radius differs. "Auto-fix"
 *  names the mechanism, so it reads as distinct from the AI action beside it
 *  rather than as a smaller version of it; the count sizes the click before it
 *  happens. `children` overrides the label (sweep progress). */
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
          // Deliberately state-agnostic: the project scope also reports zero
          // problems while its audit is loading, idle, or failed, so this must
          // hold without claiming the list is clean.
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
        // When `children` is present (project sweep: "Fixing 3/10"), drop the
        // static label so the visible progress text is the accessible name —
        // otherwise the aria-label would override it and freeze the announcement.
        // A disabled button spells its reason out instead: the tooltip describes
        // the wrapper span, so the name is all a screen-reader user gets from
        // the control. Everything else falls back to the visible label.
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

/** Bulk AI hand-off beside Auto-fix. Counts EVERY problem, not the complement
 *  of the auto-fixable ones: the two buttons are "the mechanical subset" and
 *  "the whole list", so the user picks a lane instead of reasoning about which
 *  problems fall in which set. Clicking Auto-fix first simply leaves this one
 *  pointed at what survived. */
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
  onAutoFix,
  onAskAi,
  onFixWithAi,
}: {
  docName: string;
  /** Live lint diagnostics for the open doc PLUS its broken-link findings —
   *  wire-loose so both the in-process lint shape and the audit plane fit. */
  diagnostics: DiagnosticLike[];
  /** Apply a fixable diagnostic's auto-fix (this-doc scope only). When absent
   *  (e.g. unit harness), fixable rows render no Fix button. */
  onFix?: (diagnostic: DiagnosticLike) => void;
  /** Apply every fixable diagnostic's auto-fix in this doc. When absent, the
   *  doc-scope Auto-fix button is not rendered. */
  onAutoFix?: () => void;
  /** Hand one diagnostic to the docked terminal's agent as a grounded fix
   *  prompt. Desktop-only — absent on web, where rows render no Ask AI button.
   *  Offered on every row, fixable or not: AI is most useful exactly where no
   *  deterministic fix exists. */
  onAskAi?: (diagnostic: DiagnosticLike) => void;
  /** Hand this scope's problems to the agent in one prompt. Passes only the
   *  scope: the prompt names it and the agent reads its own list, so the panel
   *  ships no diagnostics. The caller composes and dispatches, so the panel
   *  needs no opinion about which agent receives it. Desktop-only, as `onAskAi`. */
  onFixWithAi?: (scope: PanelScope) => void;
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
  // The sweep itself lives in a module store, not here, so it outlives this
  // panel — a tab switch unmounts the Problems tab, and the run must not end
  // with it. The panel only reads progress and drives start/stop.
  const projectFixing = useProjectFixSweep();
  // The dead-link "Create page" one-shot (target being created, else null).
  // Optional context: the panel is always under PageListProvider in the app;
  // the null branch only serves bare unit harnesses (create renders disabled).
  const pageList = useOptionalPageList();
  const [creatingTarget, setCreatingTarget] = useState<string | null>(null);
  // Tracks whether the panel is still mounted so async work owned BY the panel
  // (the audit walk, the dead-link page create) can stop early instead of
  // setState-ing into an unmounted tree. Deliberately not consulted by the
  // sweep, which the store owns and which must survive this panel.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // Latest-ref for the config-change subscription below: that subscription is
  // installed once and must not be torn down and re-added on every render, so it
  // calls through this instead of closing over a particular render's state.
  const onLintConfigChangedRef = useRef<() => void>(() => {});
  // Latest-ref for the sweep-settled subscription, same reason as above.
  const onSweepSettledRef = useRef<() => void>(() => {});
  // The last SETTLED audit plane, i.e. what an abandoned walk falls back to.
  // A latest-ref rather than the `audit` closure because `loadAudit` runs from
  // callbacks that outlive their render (a project sweep, a page create), and
  // `loading` is deliberately never recorded so chained supersessions restore
  // the last real plane instead of the spinner the previous one left behind.
  const settledAuditRef = useRef<ProjectAuditState>({ status: 'idle' });
  useEffect(() => {
    if (audit.status !== 'loading') settledAuditRef.current = audit;
  });
  // Load generation, so restoring an abandoned walk's fallback cannot clobber a
  // replacement load that started after it.
  const loadGenRef = useRef(0);

  const sorted = [...diagnostics].sort(compareDiagnostics);
  const docFixableCount = countFixable(sorted);

  // Declared ahead of its callers: the React Compiler cannot lower a reference
  // to a function hoisted from below ("[PruneHoistedContexts] Rewrite hoisted
  // function references"), and several of them sit below this declaration.
  async function loadAudit() {
    loadGenRef.current += 1;
    const generation = loadGenRef.current;
    const fallback = settledAuditRef.current;
    setAudit({ status: 'loading' });
    const result = await runValidationAudit();
    // A superseded walk carries no plane, so the panel keeps the one it had —
    // briefly-stale counts, with the refresh affordance back. It must not wait
    // for the replacement the config change schedules: the `lint-config` push
    // that would deliver it has no reconnect replay, so a socket drop inside the
    // server's debounce window loses it and leaves the panel on a spinner with
    // refresh disabled, which nothing else can clear. A first activation has no
    // plane to keep, so it degrades to the retryable failure state instead —
    // that state's refresh button is the way out.
    if (result === AUDIT_SUPERSEDED) {
      // Skipped when a later load is already in flight: its own settlement is
      // fresher than this fallback, and it owns the panel from here.
      if (loadGenRef.current === generation && mountedRef.current) {
        setAudit(fallback.status === 'idle' ? { status: 'failed' } : fallback);
      }
      return;
    }
    // A successful whole-project audit is full-plane truth — refresh the
    // shared validation store (freshness trigger 1) so the file tree's tints
    // update in the same pass. Deliberately BEFORE the mounted guard: the
    // store outlives this panel, and the fetch already completed.
    if (result !== null) replaceValidationFromAudit(result.files);
    // Don't setState into an unmounted tree: loadAudit is awaited from a
    // settled sweep, the refresh button, and scope activation.
    if (!mountedRef.current) return;
    setAudit(result === null ? { status: 'failed' } : { status: 'loaded', result });
  }

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

  const projectFixableFiles =
    audit.status === 'loaded'
      ? audit.result.files.filter((file) =>
          file.diagnostics.some((d) => (d.fixes?.length ?? 0) > 0),
        )
      : [];

  function fixAllProjectFiles() {
    // The store owns the sweep loop, the progress it publishes, and the toast
    // that reports how it ended. It fixes the files sequentially with a small
    // inter-file pace and capacity-aware retry because each fix lands through the
    // agent-write spine (disk + git flush) and holds a server session, so an
    // unpaced sweep saturates the shared session pool and starves concurrent
    // agent writes.
    void startProjectFixSweep({
      items: projectFixableFiles,
      fixItem: (file) => fixLintDoc(filePathToDocName(file.file)),
    });
  }

  function handleScopeChange(next: PanelScope) {
    setScope(next);
    // Only the first activation fetches; afterwards the snapshot is served
    // until an explicit refresh (a failed run keeps its error until retried).
    if (next === 'project' && audit.status === 'idle') void loadAudit();
  }

  // A loaded project snapshot was computed under a lint config that a rule
  // toggle has now replaced, so serving it on is showing problems for rules the
  // project no longer has (and hiding ones it just gained). Refresh in place —
  // only when a snapshot exists, so a config change never provokes a
  // whole-project walk for a panel sitting in doc scope. The server can coalesce
  // this with the file-tree freshness pass firing off the same event, but only
  // while both requests are in flight together: this one goes out immediately
  // and that pass debounces first, so the common case is two walks, not one.
  useEffect(() => {
    onLintConfigChangedRef.current = () => {
      // Also while a walk is in flight: a config change landing mid-walk
      // supersedes that walk, and this is what starts its replacement — the
      // abandoned walk only restores the plane it had, which is stale under the
      // new config. Still skipped when the panel has never loaded (a config
      // change must not provoke a walk for one sitting in doc scope) and when a
      // run failed, where the refresh affordance is deliberately the only retry.
      if (audit.status === 'idle' || audit.status === 'failed') return;
      void loadAudit();
    };
  });
  useEffect(() => subscribeToLintConfigChanged(() => onLintConfigChangedRef.current()), []);

  // A settled sweep leaves the loaded plane describing problems it just fixed.
  // Refresh it in place — but only for a panel that is actually mounted and
  // showing one; a sweep that outlives this panel has nothing to refresh, and
  // the remount reloads the plane from scratch anyway. Latest-ref for the same
  // reason as the config subscription above: installed once, never re-added.
  useEffect(() => {
    onSweepSettledRef.current = () => {
      if (audit.status === 'idle' || audit.status === 'failed') return;
      // Guard the re-audit against an unexpected throw past the fetch: a failed
      // audit already resolves to a null plane (logged `[audit]` and handled
      // above), so only a genuine bug lands here. Surface the "Try again" state
      // instead of an unhandled rejection off this fire-and-forget subscriber,
      // and log it like the sibling `[lint]` failure sites so a swallowed bug
      // still leaves a trail.
      void loadAudit().catch((err) => {
        console.warn('[lint] post-sweep re-audit failed', err);
        if (mountedRef.current) setAudit({ status: 'failed' });
      });
    };
  });
  useEffect(() => subscribeToProjectFixSweepSettled(() => onSweepSettledRef.current()), []);

  function handleNav(diagnostic: DiagnosticLike) {
    const detail = lintNavDetailOf(docName, diagnostic);
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
      detail: lintNavDetailOf(targetDocName, diagnostic),
    });
    // The focused document changes asynchronously. Keep this navigation banked
    // until the target's own editor is active instead of sending a live event to
    // another visible split pane.
    window.location.hash = hashFromDocName(targetDocName);
  }

  /** Per-occurrence actions in doc scope: create the missing page, fix, ask AI. */
  function renderDocActions(diagnostic: DiagnosticLike): ReactElement | null {
    const fixable = onFix !== undefined && (diagnostic.fixes?.length ?? 0) > 0;
    const canCreate = diagnostic.linkTarget !== undefined && pageList !== null;
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
              {onAutoFix !== undefined || onFixWithAi !== undefined ? (
                // Wraps rather than clips: the buttons are `shrink-0` so their
                // counts stay readable, which in a hand-narrowed rail means the
                // second one drops to its own right-aligned line.
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
  /** Auto-fixable diagnostics across the loaded audit (same unit the doc
   *  scope's Auto-fix counts — problems, not files). */
  fixableCount: number;
  /** Every diagnostic across the loaded audit, fixable or not. */
  problemCount: number;
  /** Sweep progress while a project auto-fix is running, else null. */
  fixing: { done: number; total: number } | null;
  onAutoFix: () => void;
  /** Stop a running sweep at the next file boundary. Files already fixed stay
   *  fixed; the panel re-audits so the count reflects what actually remains. */
  onCancelFix: () => void;
  /** Hand the whole audit to the agent; absent on web and until the audit
   *  loads (there is nothing to describe before then). */
  onFixWithAi?: () => void;
  /** Create a dead-link row's missing target page; absent in bare harnesses. */
  onCreateTarget?: (diagnostic: DiagnosticLike) => void;
  creatingTarget: string | null;
}) {
  const { t } = useLingui();
  const loading = audit.status === 'loading' || audit.status === 'idle';
  const loadedFiles = audit.status === 'loaded' ? audit.result.files : [];
  const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(() => new Set());
  // Every group is open only when the set covers all of them; that is exactly
  // when the one control flips from "expand all" to "collapse all".
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
      {/* Two rows, not one: the count summary plus two labelled actions plus
          refresh need ~400px, and the rail is narrower than that — on one row
          the buttons (deliberately `shrink-0`, so a count is never truncated)
          squeezed the summary into a three-line wrap mid-phrase. Refresh rides
          with the summary because both concern the audit data rather than the
          problems, which also leaves the action row matching the doc scope's. */}
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
            {/* Groups now mount collapsed, so this restores the fully-expanded
                view in one action; present only once there are groups to act on. */}
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
            {/* Icon-only, so the label lives in a tooltip as well as the
                accessible name — nothing on the button says what it does. */}
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
          {/* The Auto-fix button is disabled during a sweep, so AT can't focus it
              to hear the "Fixing N/M" progress — announce it from a live region
              instead. Rendered only while sweeping so it never coexists with the
              loading skeleton's own role="status". */}
          {fixing !== null ? (
            <span className="sr-only" role="status">
              {t`Fixing ${fixing.done} of ${fixing.total} files`}
            </span>
          ) : null}
          {/* Auto-fix disables itself while sweeping, so without this the only
              way out of a started sweep is a page reload. Rendered only during a
              sweep, beside the disabled Auto-fix it replaces the use of. */}
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
              // The sweep rewrites the same files this would hand over, so a
              // mid-sweep hand-off would describe problems that are already gone.
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
  /** File paths whose group is open. Groups mount collapsed, so a fresh
   *  project plane renders headers only until the reader drills in. */
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
  /** Controlled by the parent so the one expand/collapse-all control can drive
   *  every group at once; a closed group leaves its diagnostic rows unmounted. */
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
              // Same hover-revealed overlay contract as the doc scope, minus
              // the fix / ask-AI actions (both are this-doc only).
              renderActions={(diagnostic) =>
                diagnostic.linkTarget === undefined || onCreateTarget === undefined ? null : (
                  <CreatePageButton
                    target={diagnostic.linkTarget}
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
