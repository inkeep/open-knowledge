import { Trans, useLingui } from '@lingui/react/macro';
import { useUpdateChannel } from '@/hooks/use-update-channel';
import { Badge } from './ui/badge';

interface BetaBadgeProps {
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
