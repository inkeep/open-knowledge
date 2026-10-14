import { useLingui } from '@lingui/react/macro';
import { useId } from 'react';
import { useHeaderPaneButtonSet } from '@/components/HeaderPaneButtons';
import { PaneLayoutIcon } from '@/components/icons/editor-pane';
import { Button } from '@/components/ui/button';
import { type PaneId, paneVisibilityStore } from '@/lib/pane-visibility-store';

export function NothingOpen() {
  const { t } = useLingui();
  const titleId = useId();
  const panes = useHeaderPaneButtonSet();
  const openLabels: Record<PaneId, string> = {
    editor: t`Open editor`,
    agents: t`Open agents`,
    terminal: t`Open terminal`,
  };

  return (
    <section
      data-nothing-open=""
      tabIndex={-1}
      aria-labelledby={titleId}
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 p-6 text-center outline-none"
    >
      <PaneLayoutIcon className="mb-1 size-8 text-muted-foreground/60" />
      <h2 id={titleId} className="font-medium text-base text-sidebar-hover-muted-foreground">
        {t`Nothing open`}
      </h2>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        {panes.map((pane) => (
          <Button
            key={pane}
            variant="outline"
            size="sm"
            data-testid={`nothing-open-${pane}`}
            onClick={() => paneVisibilityStore.request(pane, true)}
          >
            {openLabels[pane]}
          </Button>
        ))}
      </div>
    </section>
  );
}
