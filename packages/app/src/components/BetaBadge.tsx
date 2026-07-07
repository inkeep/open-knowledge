/**
 * Visible-in-window-chrome reminder that the running build is on the beta
 * auto-update channel. Renders nothing when channel resolves to 'latest' or
 * is still null (loading / web / CLI distribution). The channel is derived
 * from the build version (a property of the installed binary), read once via
 * the shared `useUpdateChannel` hook's `state.query()` on mount.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import { useUpdateChannel } from '@/hooks/use-update-channel';
import { Badge } from './ui/badge';

interface BetaBadgeProps {
  /** Optional layout overrides — the badge component itself stays size-agnostic. */
  readonly className?: string;
}

export function BetaBadge({ className }: BetaBadgeProps) {
  const { t } = useLingui();
  const { channel } = useUpdateChannel();
  if (channel !== 'beta') return null;
  return (
    <Badge
      variant="secondary"
      aria-label={t`Beta channel`}
      data-testid="beta-badge"
      className={className}
    >
      <Trans>BETA</Trans>
    </Badge>
  );
}
