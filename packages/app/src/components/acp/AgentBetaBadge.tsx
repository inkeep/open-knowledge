/**
 * Small "Beta" tag marking the in-app ACP agent feature as beta. Rendered beside
 * the "In this app" section header in every agent picker + the catalog dialog
 * title, scoping the beta signal to the agent-thread rows (not the pre-existing
 * Terminal / Desktop handoff paths in the same menus).
 *
 * Always visible — unlike {@link BetaBadge}, which renders only on the beta
 * auto-update channel. This one is about the feature's maturity, not the build.
 */

import { Trans } from '@lingui/react/macro';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export function AgentBetaBadge({ className }: { readonly className?: string }) {
  return (
    <Badge variant="gray" className={cn('h-4 px-1 text-[10px]', className)}>
      <Trans>Beta</Trans>
    </Badge>
  );
}
