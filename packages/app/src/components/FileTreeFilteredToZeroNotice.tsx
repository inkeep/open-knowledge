import { humanFormat } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useId } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription } from '@/components/ui/empty';
import { useSettingsLoadingReason } from '@/lib/config-context';
import { useConfigContext } from '@/lib/config-provider';

export function FileTreeFilteredToZeroNotice() {
  const { t } = useLingui();
  const { projectLocalBinding, projectLocalSynced } = useConfigContext();
  const projectLocalBindingReady = projectLocalSynced && projectLocalBinding !== null;
  const pendingReasonId = useId();
  const settingsLoadingReason = useSettingsLoadingReason();

  const handleReset = () => {
    if (!projectLocalBindingReady) return;
    const result = projectLocalBinding.patch({
      appearance: {
        sidebar: {
          showHiddenFiles: false,
          showOnlyMarkdownFiles: false,
          showOkFolders: false,
        },
      },
    });
    if (!result.ok) {
      console.warn(
        '[FileTreeFilteredToZeroNotice] view-filter reset rejected:',
        humanFormat(result.error),
      );
      toast.error(t`Could not update sidebar settings`, {
        description: humanFormat(result.error),
      });
    }
  };

  return (
    <Empty data-testid="file-tree-filtered-to-zero" className="gap-3 p-0 py-8">
      <EmptyDescription className="select-none text-sidebar-foreground/30">
        {t`All files are hidden by view filters.`}
      </EmptyDescription>
      <EmptyContent>
        <Button
          variant="link"
          size="sm"
          className="font-mono uppercase"
          disabled={!projectLocalBindingReady}
          aria-describedby={!projectLocalBindingReady ? pendingReasonId : undefined}
          onClick={handleReset}
          data-testid="reset-view-filters"
        >
          {t`Reset view filters`}
        </Button>
        {!projectLocalBindingReady ? (
          <p id={pendingReasonId} className="text-xs text-muted-foreground">
            {settingsLoadingReason}
          </p>
        ) : null}
      </EmptyContent>
    </Empty>
  );
}
