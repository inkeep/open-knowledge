import { humanFormat } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useConfigContext } from '@/lib/config-provider';
import { cn } from '@/lib/utils';
import { attributeTreeHiddenAxes } from './file-tree-utils';

interface NotInSidebarIndicatorProps {
  /**
   * The active doc as the sidebar tree would model it: markdown docs carry
   * their docName, every other file its project-relative path. The kind is
   * what the only-markdown axis judges, so the mounting surface (markdown
   * editor vs asset view) supplies it rather than re-deriving it from the
   * ref's extension.
   */
  entry: { kind: 'document'; docName: string } | { kind: 'asset'; path: string };
  className?: string;
}

/**
 * Passive "not shown in sidebar" chrome: when the active doc has no visible
 * tree row because a visibility toggle hides it, names each hiding toggle as
 * a one-click flip. Renders nothing whenever no user-flippable axis hides the
 * doc — visible docs, and docs structurally outside the tree (skills,
 * templates, `.ok` paths), stay indicator-free via the shared attribution
 * predicate. Never a toast: the state is routine (any link/search hit can
 * open a hidden doc), so it lives quietly in the surface's own chrome.
 */
export function NotInSidebarIndicator({ entry, className }: NotInSidebarIndicatorProps) {
  const { t } = useLingui();
  const { projectLocalBinding, merged } = useConfigContext();
  const sidebar = merged?.appearance?.sidebar;
  const axes = attributeTreeHiddenAxes(entry, {
    showHiddenFiles: sidebar?.showHiddenFiles ?? false,
    showOnlyMarkdownFiles: sidebar?.showOnlyMarkdownFiles ?? false,
  });
  if (!axes.hiddenFiles && !axes.onlyMarkdownFiles) return null;

  // Same write path + rejection surface as the sidebar's visibility
  // checkboxes (FileSidebar's patchSidebarVisibility): one config shape, one
  // toast, so every flip surface behaves identically.
  const patchSidebarVisibility = (patch: {
    showHiddenFiles?: boolean;
    showOnlyMarkdownFiles?: boolean;
  }) => {
    if (projectLocalBinding === null) return;
    const result = projectLocalBinding.patch({ appearance: { sidebar: patch } });
    if (!result.ok) {
      console.warn(
        '[NotInSidebarIndicator] sidebar visibility flip rejected:',
        humanFormat(result.error),
      );
      toast.error(t`Could not update sidebar settings`, {
        description: humanFormat(result.error),
      });
    }
  };

  const flipChipClass =
    'h-5 rounded-sm px-1.5 font-normal text-2xs text-muted-foreground hover:text-foreground';

  return (
    <div
      data-testid="not-in-sidebar-indicator"
      className={cn('flex items-center gap-1.5 text-muted-foreground/70 text-xs', className)}
    >
      <EyeOff aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="whitespace-nowrap">{t`Not in sidebar`}</span>
      {axes.hiddenFiles ? (
        <Button
          variant="outline"
          size="sm"
          className={flipChipClass}
          disabled={projectLocalBinding === null}
          onClick={() => patchSidebarVisibility({ showHiddenFiles: true })}
          aria-label={t`Show hidden files`}
          title={t`Show hidden files`}
          data-testid="not-in-sidebar-flip-hidden-files"
        >
          {t`Hidden files`}
        </Button>
      ) : null}
      {axes.onlyMarkdownFiles ? (
        <Button
          variant="outline"
          size="sm"
          className={flipChipClass}
          disabled={projectLocalBinding === null}
          onClick={() => patchSidebarVisibility({ showOnlyMarkdownFiles: false })}
          aria-label={t`Turn off Only markdown files`}
          title={t`Turn off Only markdown files`}
          data-testid="not-in-sidebar-flip-only-markdown"
        >
          {t`Only markdown files`}
        </Button>
      ) : null}
    </div>
  );
}
