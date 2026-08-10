import { humanFormat } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription } from '@/components/ui/empty';
import { useConfigContext } from '@/lib/config-provider';

/**
 * Empty-slot notice for a tree whose active view filters hide every row of a
 * non-empty project — rendered in place of the `No files yet` state so a
 * filtered view is never mistaken for an empty one. The caller (FileTree's
 * empty slot) owns that classification; this component owns the explanation
 * and the one-click recovery.
 *
 * Reset restores the tree-content toggles to their defaults. The Skills
 * section toggle is deliberately untouched: it gates a sidebar section, not
 * tree rows, so it can never contribute to this state.
 */
export function FileTreeFilteredToZeroNotice() {
  const { t } = useLingui();
  const { projectLocalBinding } = useConfigContext();

  // Same write path + rejection surface as the sidebar's visibility
  // checkboxes (FileSidebar's patchSidebarVisibility): one config shape, one
  // toast, so every flip surface behaves identically.
  const handleReset = () => {
    if (projectLocalBinding === null) return;
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
          disabled={projectLocalBinding === null}
          onClick={handleReset}
          data-testid="reset-view-filters"
        >
          {t`Reset view filters`}
        </Button>
      </EmptyContent>
    </Empty>
  );
}
