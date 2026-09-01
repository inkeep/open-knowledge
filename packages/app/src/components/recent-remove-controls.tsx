// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { Trans, useLingui } from '@lingui/react/macro';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

export function RecentRemoveButton({
  path,
  name,
  onRemoveRecent,
  testIdPrefix,
}: {
  path: string;
  name: string;
  onRemoveRecent: (path: string) => void;
  testIdPrefix: string;
}) {
  const { t } = useLingui();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      tabIndex={-1}
      aria-hidden="true"
      aria-label={t`Remove ${name} from recent projects`}
      title={t`Remove from recent projects`}
      onClick={(e) => {
        e.stopPropagation();
        onRemoveRecent(path);
      }}
      className="absolute top-1/2 right-1 size-6 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity group-hover/recent:opacity-100 focus-visible:opacity-100"
      data-testid={`${testIdPrefix}-remove-${path}`}
    >
      <X aria-hidden="true" className="size-3.5" />
    </Button>
  );
}

export function RecentItemContextMenu({
  path,
  onRemoveRecent,
  testIdPrefix,
  children,
}: {
  path: string;
  onRemoveRecent: (path: string) => void;
  testIdPrefix: string;
  children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => onRemoveRecent(path)}
          data-testid={`${testIdPrefix}-context-remove-${path}`}
        >
          <X aria-hidden="true" />
          <Trans>Remove from recent projects</Trans>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
