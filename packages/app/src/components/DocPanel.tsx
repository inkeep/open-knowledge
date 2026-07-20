import { t } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { AlertTriangle, Clock, Link2, ListTree, Network } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { composeLintFixTerminalPaste } from '@/components/handoff/compose-lint-fix-prompt';
import { useTerminalLaunch } from '@/components/handoff/TerminalLaunchContext';
import { requestActiveTerminalInput } from '@/components/handoff/terminal-input-events';
import { LinksPanel } from '@/components/LinksPanel';
import { OutlinePanel } from '@/components/OutlinePanel';
import { ProblemsPanel } from '@/components/ProblemsPanel';
import { TimelineContent } from '@/components/TimelinePanel';
import { Badge } from '@/components/ui/badge';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { applyLintFixes, collectFixes } from '@/editor/apply-lint-fix';
import { useDocumentContext } from '@/editor/DocumentContext';
import { useDocLintConfig } from '@/editor/lint-config-client';
import { useDocDiagnostics } from '@/editor/useDocDiagnostics';
import { useSingleFileMode } from '@/lib/single-file-mode';

export type PanelTab = 'outline' | 'links' | 'graph' | 'timeline' | 'problems';

export const TABS: { id: PanelTab; icon: typeof ListTree }[] = [
  { id: 'outline', icon: ListTree },
  { id: 'links', icon: Link2 },
  { id: 'graph', icon: Network },
  { id: 'timeline', icon: Clock },
  { id: 'problems', icon: AlertTriangle },
];

/** Localized display label for a doc-panel tab. */
function tabLabel(id: PanelTab): string {
  if (id === 'outline') return t`Outline`;
  if (id === 'links') return t`Links`;
  if (id === 'graph') return t`Graph`;
  if (id === 'problems') return t`Problems`;
  return t`Timeline`;
}

/**
 * Top-level mode for the DocPanel container. Two values:
 *   - `'doc'`:   existing per-document info tabs (outline / links / …).
 *   - `'agent'`: Agent Activity view keyed to a `connectionId`.
 *
 * The mode is a drill-in, not a persistent toggle: agent avatar click enters
 * `'agent'` mode; the back arrow (shown only in `'agent'` mode) returns to
 * `'doc'` mode via `closeActivityPanel()`.
 */
type DocPanelMode = 'doc' | 'agent';

function loadGraphPanelModule() {
  return import('@/components/GraphPanel');
}

const LazyGraphPanel = lazy(async () => {
  const mod = await loadGraphPanelModule();
  return { default: mod.GraphPanel };
});

const LazyActivityModeContent = lazy(async () => {
  const mod = await import('@/components/ActivityModeContent');
  return { default: mod.ActivityModeContent };
});

interface DocPanelProps {
  docName: string;
  isSourceMode: boolean;
  activeTab: PanelTab;
  onActiveTabChange: (tab: PanelTab) => void;
  /** Active mode — controlled by presence-bar avatar clicks + the back arrow. */
  mode: DocPanelMode;
}

export function DocPanel({
  docName,
  isSourceMode,
  activeTab,
  onActiveTabChange,
  mode,
}: DocPanelProps) {
  const { t } = useLingui();
  // Live, mode-agnostic lint diagnostics for the active doc — drives both the
  // Problems tab badge and the panel itself. Reads `Y.Text('source')`, so it
  // works in WYSIWYG mode too. Gated to the matching provider during nav.
  const { activeProvider, activeDocName } = useDocumentContext();
  const { data: lintConfig } = useDocLintConfig(docName);
  const lintProvider = activeDocName === docName ? activeProvider : null;
  const diagnostics = useDocDiagnostics(lintProvider, lintConfig?.effective ?? null);
  // Apply a diagnostic's auto-fix to the source CRDT. `lintProvider` is the
  // active provider only when it matches this doc, so a fix always targets the
  // document the user is viewing.
  const handleFix = (diagnostic: (typeof diagnostics)[number]) => {
    if (lintProvider !== null && diagnostic.fixes && diagnostic.fixes.length > 0) {
      applyLintFixes(lintProvider, diagnostic.fixes);
    }
  };
  const handleFixAll = () => {
    if (lintProvider !== null) {
      applyLintFixes(lintProvider, collectFixes(diagnostics));
    }
  };
  // Hand one diagnostic to the docked terminal's agent as a grounded prompt
  // (live TUI reuse or a fresh Claude launch — the host decides). Desktop-only:
  // on web nothing subscribes to the terminal-input event, so the button is
  // withheld entirely by not passing `onAskAi`.
  const terminalLaunch = useTerminalLaunch();
  const handleAskAi = (diagnostic: (typeof diagnostics)[number]) => {
    if (lintProvider === null) return;
    const source = lintProvider.document.getText('source').toString();
    const lineText = source.split('\n')[diagnostic.range.start.line];
    requestActiveTerminalInput(composeLintFixTerminalPaste(docName, diagnostic, lineText));
  };
  // Single-file `ok <file>` keeps only the Outline + Problems tabs. Links/Graph
  // need a multi-doc knowledge base, and Timeline is git history — all empty or
  // inert for a lone git-off file; linting applies to any single file. Coerce a
  // persisted now-hidden selection back to outline so the rail never renders a
  // hidden panel.
  const singleFile = useSingleFileMode();
  const tabs = singleFile
    ? TABS.filter((tab) => tab.id === 'outline' || tab.id === 'problems')
    : TABS;
  const effectiveTab: PanelTab = tabs.some((tab) => tab.id === activeTab) ? activeTab : 'outline';
  const showTabStrip = mode === 'doc' && tabs.length > 1;
  return (
    <>
      {/* In `'doc'` mode: the info sub-tabs render as the panel header.
          In `'agent'` mode: no header row — `ActivityModeContent` owns its
          own header (avatar + back-arrow), which eliminates the empty-row
          footprint the standalone back-arrow used to have. */}
      {showTabStrip ? (
        <div className="flex flex-row items-center justify-center gap-3 p-2">
          <ToggleGroup
            type="single"
            variant="outline"
            value={effectiveTab}
            onValueChange={(value: PanelTab) => {
              if (value) onActiveTabChange(value);
            }}
            aria-label={t`Document panels`}
          >
            {tabs.map(({ id, icon: Icon }) => {
              const label = tabLabel(id);
              const showBadge = id === 'problems' && diagnostics.length > 0;
              return (
                <Tooltip key={id}>
                  <ToggleGroupItem
                    value={id}
                    role="tab"
                    id={`tab-${id}`}
                    aria-controls={`panel-${id}`}
                    aria-label={showBadge ? t`${label} (${diagnostics.length})` : label}
                    asChild
                  >
                    <TooltipTrigger className="relative">
                      <Icon />
                      {showBadge && (
                        <Badge
                          variant="destructive"
                          aria-hidden="true"
                          className="absolute -right-1.5 -top-1.5 h-4 min-w-4 rounded-full px-1 text-[10px] leading-none"
                        >
                          {diagnostics.length > 99 ? '99+' : diagnostics.length}
                        </Badge>
                      )}
                    </TooltipTrigger>
                  </ToggleGroupItem>
                  <TooltipContent side="bottom">{label}</TooltipContent>
                </Tooltip>
              );
            })}
          </ToggleGroup>
        </div>
      ) : null}

      {mode === 'doc' ? (
        <div
          // Tabpanel semantics only apply when the tab strip (tablist) is shown.
          // In single-file mode the strip is dropped, so the Outline renders as
          // a plain region with no dangling `aria-labelledby` to a missing tab.
          {...(showTabStrip
            ? {
                role: 'tabpanel' as const,
                id: `panel-${effectiveTab}`,
                'aria-labelledby': `tab-${effectiveTab}`,
              }
            : {})}
          className="min-h-0 flex-1"
        >
          {effectiveTab === 'outline' && (
            <OutlinePanel docName={docName} isSourceMode={isSourceMode} />
          )}
          {effectiveTab === 'links' && <LinksPanel docName={docName} />}
          {effectiveTab === 'graph' && (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  <Trans>Loading graph</Trans>
                </div>
              }
            >
              <LazyGraphPanel activeDocName={docName} />
            </Suspense>
          )}
          {effectiveTab === 'timeline' && <TimelineContent docName={docName} />}
          {effectiveTab === 'problems' && (
            <ProblemsPanel
              docName={docName}
              diagnostics={diagnostics}
              onFix={lintProvider !== null ? handleFix : undefined}
              onFixAll={lintProvider !== null ? handleFixAll : undefined}
              onAskAi={lintProvider !== null && terminalLaunch !== null ? handleAskAi : undefined}
            />
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <Suspense
            fallback={
              <div
                role="status"
                aria-busy="true"
                className="flex h-full items-center justify-center text-sm text-muted-foreground"
              >
                <Trans>Loading agent activity</Trans>
              </div>
            }
          >
            <LazyActivityModeContent />
          </Suspense>
        </div>
      )}
    </>
  );
}
