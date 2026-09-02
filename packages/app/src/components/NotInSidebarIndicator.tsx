import { humanFormat } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useConfigContext } from '@/lib/config-provider';
import { cn } from '@/lib/utils';
import { attributeTreeHiddenAxes } from './file-tree-utils';

interface NotInSidebarIndicatorProps {
  entry: { kind: 'document'; docName: string } | { kind: 'asset'; path: string };
  className?: string;
}

export function NotInSidebarIndicator({ entry, className }: NotInSidebarIndicatorProps) {
  const { t } = useLingui();
  const { projectLocalBinding, projectLocalSynced, merged } = useConfigContext();
  if (merged === null || !projectLocalSynced) return null;
  const sidebar = merged?.appearance?.sidebar;
  const axes = attributeTreeHiddenAxes(entry, {
    showHiddenFiles: sidebar?.showHiddenFiles ?? false,
    showOnlyMarkdownFiles: sidebar?.showOnlyMarkdownFiles ?? false,
  });
  if (!axes.hiddenFiles && !axes.onlyMarkdownFiles) return null;

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
