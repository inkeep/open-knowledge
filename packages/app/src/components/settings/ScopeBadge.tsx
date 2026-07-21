/**
 * User/Project scope indicator for a plugin settings panel header. The
 * "Plugins" sidebar group mixes scopes — markdownlint is project-scope (shared
 * via config.yml + the native `.markdownlint.*`), Themes is user-scope
 * (personal, device-local) — so the panel header alone can't tell you where a
 * change lands. This badge makes the scope (and, via its tooltip, where the
 * change is stored) explicit. Used ONLY in plugin panel headers; the other
 * settings sections are already categorized by their labeled sidebar group.
 */
import { Trans } from '@lingui/react/macro';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function ScopeBadge({ scope }: { scope: 'user' | 'project' }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* tabIndex makes the badge keyboard-focusable so the tooltip's
            storage/sharing explanation is reachable without a pointer (Radix
            opens tooltips on focus and wires aria-describedby). */}
        <Badge
          variant="gray"
          tabIndex={0}
          className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid={`settings-scope-badge-${scope}`}
        >
          {scope === 'user' ? <Trans>User</Trans> : <Trans>Project</Trans>}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        {scope === 'user' ? (
          <Trans>Personal to this device — stored in your user config, not shared.</Trans>
        ) : (
          <Trans>Shared with everyone on this project — committed to config.yml via git.</Trans>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
