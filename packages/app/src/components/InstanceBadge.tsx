/**
 * Visible-in-window-chrome reminder of which named parallel dev instance this
 * window belongs to — the git branch / worktree the build was launched from.
 * Renders nothing unless the desktop host reports an `instanceLabel` (only set
 * when the launch relocated `userData` to a named sibling: auto-derived from
 * the git checkout or an explicit `OK_INSTANCE`). So it is invisible for the
 * default install, in web / CLI distribution, and for plain dev on the default
 * branch — exactly the launches that are NOT parallel instances.
 */

import { useLingui } from '@lingui/react/macro';
import { GitBranch } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from './ui/badge';

interface InstanceBadgeProps {
  /** Optional layout overrides — the badge component itself stays size-agnostic. */
  readonly className?: string;
}

export function InstanceBadge({ className }: InstanceBadgeProps) {
  const { t } = useLingui();
  const label = typeof window !== 'undefined' ? (window.okDesktop?.instanceLabel ?? null) : null;
  if (!label) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="secondary"
          aria-label={t`Dev instance: ${label}`}
          data-testid="instance-badge"
          className={className}
        >
          <GitBranch aria-hidden="true" />
          <span className="max-w-40 truncate">{label}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{t`Dev instance: ${label} (isolated from other worktrees)`}</TooltipContent>
    </Tooltip>
  );
}
