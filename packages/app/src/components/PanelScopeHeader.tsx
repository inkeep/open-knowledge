import { Trans, useLingui } from '@lingui/react/macro';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export type PanelScope = 'doc' | 'project';

/**
 * Doc/Project scope switch for right-rail panels. Problems and Comments use it
 * today; other per-doc panels (Timeline) can adopt the same header when they
 * grow a project-wide view, so the two scopes stay one non-diverging experience.
 *
 * Panels render it BELOW their own `PanelHeader`: the title says what the panel
 * is, the switch narrows it, and a switch that sits above the title reads as
 * chrome belonging to the tab strip instead.
 */
export function PanelScopeHeader({
  scope,
  onScopeChange,
  projectLabel,
}: {
  scope: PanelScope;
  onScopeChange: (scope: PanelScope) => void;
  /**
   * Label for the project-scope side. Defaults to "This project", which is what
   * every panel using this header says today — the two sides read as a pair
   * ("This doc" / "This project") rather than as a place and a scope. Kept as an
   * override for a panel whose project view is a different KIND of thing rather
   * than the same list widened.
   */
  projectLabel?: string;
}) {
  const { t } = useLingui();
  return (
    <div className="shrink-0 px-4 pb-2">
      <ToggleGroup
        type="single"
        variant="segmented"
        size="sm"
        spacing={1}
        value={scope}
        onValueChange={(value: PanelScope) => {
          if (value) onScopeChange(value);
        }}
        aria-label={t`Scope`}
        className="w-full rounded-md bg-muted p-0.5 dark:bg-background"
      >
        <ToggleGroupItem value="doc" className="flex-1" data-testid="panel-scope-doc">
          <Trans>This doc</Trans>
        </ToggleGroupItem>
        <ToggleGroupItem value="project" className="flex-1" data-testid="panel-scope-project">
          {projectLabel ?? <Trans>This project</Trans>}
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
