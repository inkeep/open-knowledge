import { useLingui } from '@lingui/react/macro';
import { Folder } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { extractFolderBasename } from '@/lib/path-utils';
import { useWorkspace } from '@/lib/use-workspace';

const CENTRE_LABEL_CLASS = 'flex min-w-0 items-center gap-1.5 px-2 text-foreground text-sm';

export function WebProjectName() {
  const { t } = useLingui();
  const workspace = useWorkspace();
  if (workspace === null) return null;
  const name = extractFolderBasename(workspace.contentDir) || null;
  if (name === null) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: tooltip-on-static-text pattern — focusable span lets keyboard users surface the full project path that mouse users see on hover. */}
        <span tabIndex={0} data-testid="web-project-name" className={CENTRE_LABEL_CLASS}>
          <Folder aria-hidden="true" className="size-4 shrink-0" />
          <span className="sr-only">{t`Project`}</span>
          <span
            className="min-w-0 truncate"
            data-app-header-center-label=""
            data-testid="web-project-name-label"
          >
            {name}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs break-all">
        {workspace.contentDir}
      </TooltipContent>
    </Tooltip>
  );
}
