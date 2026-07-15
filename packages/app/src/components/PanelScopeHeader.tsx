import { Trans, useLingui } from '@lingui/react/macro';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export type PanelScope = 'doc' | 'project';

/**
 * Doc/Project scope switch for right-rail panels. Problems uses it today;
 * other per-doc panels (Timeline) can adopt the same header when they grow a
 * project-wide view, so the two scopes stay one non-diverging experience.
 */
export function PanelScopeHeader({
  scope,
  onScopeChange,
}: {
  scope: PanelScope;
  onScopeChange: (scope: PanelScope) => void;
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
          <Trans>Project</Trans>
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
