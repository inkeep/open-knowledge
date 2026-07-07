import { t } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { Clock, Link2, ListTree, Network } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import type { DiffLayout } from '@/components/DiffView';
import { LinksPanel } from '@/components/LinksPanel';
import { OutlinePanel } from '@/components/OutlinePanel';
import { TimelineContent } from '@/components/TimelinePanel';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSingleFileMode } from '@/lib/single-file-mode';

export type PanelTab = 'outline' | 'links' | 'graph' | 'timeline';

export const TABS: { id: PanelTab; icon: typeof ListTree }[] = [
  { id: 'outline', icon: ListTree },
  { id: 'links', icon: Link2 },
  { id: 'graph', icon: Network },
  { id: 'timeline', icon: Clock },
];

/** Localized display label for a doc-panel tab. */
function tabLabel(id: PanelTab): string {
  if (id === 'outline') return t`Outline`;
  if (id === 'links') return t`Links`;
  if (id === 'graph') return t`Graph`;
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
  // Lifted from TimelineContent so the choice survives sub-tab switches —
  // TimelineContent unmounts when activeTab leaves 'timeline'.
  const { t } = useLingui();
  const [diffLayout, setDiffLayout] = useState<DiffLayout>('unified');
  // Single-file `ok <file>` keeps only the Outline tab. Links/Graph need a
  // multi-doc knowledge base, and Timeline is git history — all empty or inert
  // for a lone git-off file. Coerce a persisted links/graph/timeline selection
  // back to outline so the rail never renders a now-hidden panel, and drop the
  // one-item tab strip entirely.
  const singleFile = useSingleFileMode();
  const tabs = singleFile ? TABS.filter((tab) => tab.id === 'outline') : TABS;
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
              return (
                <Tooltip key={id}>
                  <ToggleGroupItem
                    value={id}
                    role="tab"
                    id={`tab-${id}`}
                    aria-controls={`panel-${id}`}
                    aria-label={label}
                    asChild
                  >
                    <TooltipTrigger>
                      <Icon />
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
          {effectiveTab === 'timeline' && (
            <TimelineContent
              docName={docName}
              diffLayout={diffLayout}
              onDiffLayoutChange={setDiffLayout}
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
