// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { t } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { AlertTriangle, Clock, Link2, ListTree, MessageSquare, Network } from 'lucide-react';
import { lazy, Suspense, useEffect } from 'react';
import { CommentsTab } from '@/comments/CommentsTab';
import { setCommentsPanelOnScreen } from '@/comments/comments-panel-visibility';
import {
  composeFixAllProblemsTerminalPaste,
  composeLintFixTerminalPaste,
} from '@/components/handoff/compose-lint-fix-prompt';
import { useTerminalLaunch } from '@/components/handoff/TerminalLaunchContext';
import { requestActiveTerminalInput } from '@/components/handoff/terminal-input-events';
import { LinksPanel } from '@/components/LinksPanel';
import { OutlinePanel } from '@/components/OutlinePanel';
import type { PanelScope } from '@/components/PanelScopeHeader';
import { type DiagnosticLike, ProblemsPanel } from '@/components/ProblemsPanel';
import { TimelineContent } from '@/components/TimelinePanel';
import { Badge } from '@/components/ui/badge';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { applyLintFixes, collectFixes } from '@/editor/apply-lint-fix';
import { useDocumentContext } from '@/editor/DocumentContext';
import { useDocLintConfig } from '@/editor/lint-config-client';
import { useDocDiagnostics } from '@/editor/useDocDiagnostics';
import { useDocLinkFindings } from '@/editor/validation-audit-client';
import { useSingleFileMode } from '@/lib/single-file-mode';
import { type DocProblemCounts, patchDocValidationSource } from '@/lib/validation-store';

export type PanelTab = 'outline' | 'links' | 'graph' | 'timeline' | 'problems' | 'comments';

export const TABS: { id: PanelTab; icon: typeof ListTree }[] = [
  { id: 'outline', icon: ListTree },
  { id: 'links', icon: Link2 },
  { id: 'graph', icon: Network },
  { id: 'timeline', icon: Clock },
  { id: 'problems', icon: AlertTriangle },
  { id: 'comments', icon: MessageSquare },
];

const SINGLE_FILE_TABS: readonly PanelTab[] = ['outline', 'problems', 'comments'];

function countsOf(diagnostics: readonly { severity: string }[]): DocProblemCounts {
  let errorCount = 0;
  let warningCount = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'error') errorCount += 1;
    else warningCount += 1;
  }
  return { errorCount, warningCount };
}

function tabLabel(id: PanelTab): string {
  if (id === 'outline') return t`Outline`;
  if (id === 'links') return t`Links`;
  if (id === 'graph') return t`Graph`;
  if (id === 'problems') return t`Problems`;
  if (id === 'comments') return t`Comments`;
  return t`Timeline`;
}

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
  mode: DocPanelMode;
  isCollapsed?: boolean;
}

export function DocPanel({
  docName,
  isSourceMode,
  activeTab,
  onActiveTabChange,
  mode,
  isCollapsed = false,
}: DocPanelProps) {
  const { t } = useLingui();
  const { activeProvider, activeDocName } = useDocumentContext();
  const { data: lintConfig } = useDocLintConfig(docName);
  const lintProvider = activeDocName === docName ? activeProvider : null;
  const lintDiagnostics = useDocDiagnostics(lintProvider, lintConfig?.effective ?? null);
  const linkFindingsState = useDocLinkFindings(docName);
  const linkFindings = linkFindingsState.findings;
  const diagnostics = [...lintDiagnostics, ...linkFindings];
  useEffect(() => {
    if (lintProvider === null) return;
    patchDocValidationSource(docName, 'lint', countsOf(lintDiagnostics));
  }, [docName, lintProvider, lintDiagnostics]);
  useEffect(() => {
    if (lintProvider === null || linkFindingsState.status !== 'loaded') return;
    patchDocValidationSource(docName, 'links', countsOf(linkFindings));
  }, [docName, lintProvider, linkFindings, linkFindingsState.status]);
  const handleFix = (diagnostic: DiagnosticLike) => {
    if (lintProvider !== null && diagnostic.fixes && diagnostic.fixes.length > 0) {
      applyLintFixes(lintProvider, diagnostic.fixes, docName);
    }
  };
  const handleAutoFix = () => {
    if (lintProvider !== null) {
      applyLintFixes(lintProvider, collectFixes(lintDiagnostics), docName);
    }
  };
  const terminalLaunch = useTerminalLaunch();
  const handleAskAi = (diagnostic: DiagnosticLike) => {
    if (lintProvider === null) return;
    const source = lintProvider.document.getText('source').toString();
    const lineText = source.split('\n')[diagnostic.range.start.line];
    requestActiveTerminalInput(composeLintFixTerminalPaste(docName, diagnostic, lineText), {
      submit: true,
    });
  };
  const handleFixWithAi = (scope: PanelScope) => {
    requestActiveTerminalInput(
      composeFixAllProblemsTerminalPaste(scope === 'doc' ? docName : null),
      {
        submit: true,
      },
    );
  };
  const singleFile = useSingleFileMode();
  const tabs = singleFile ? TABS.filter((tab) => SINGLE_FILE_TABS.includes(tab.id)) : TABS;
  const effectiveTab: PanelTab = tabs.some((tab) => tab.id === activeTab) ? activeTab : 'outline';
  const showTabStrip = mode === 'doc' && tabs.length > 1;
  useEffect(() => {
    setCommentsPanelOnScreen(!isCollapsed && mode === 'doc' && effectiveTab === 'comments');
    return () => setCommentsPanelOnScreen(false);
  }, [isCollapsed, mode, effectiveTab]);
  return (
    <>
      {}
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
                          variant="notification"
                          aria-hidden="true"
                          className="pointer-events-none absolute -top-0.5 right-0.5 h-3.5 min-w-3.5 rounded-full px-1 font-sans text-[9px] leading-none tabular-nums"
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
          {effectiveTab === 'comments' && <CommentsTab docName={docName} />}
          {effectiveTab === 'problems' && (
            <ProblemsPanel
              docName={docName}
              diagnostics={diagnostics}
              linkFindingsStatus={linkFindingsState.status}
              onFix={lintProvider !== null ? handleFix : undefined}
              onAutoFix={lintProvider !== null ? handleAutoFix : undefined}
              onAskAi={lintProvider !== null && terminalLaunch !== null ? handleAskAi : undefined}
              onFixWithAi={terminalLaunch !== null ? handleFixWithAi : undefined}
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
