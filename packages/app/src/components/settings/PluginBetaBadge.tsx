import { Trans } from '@lingui/react/macro';
import { Badge } from '@/components/ui/badge';

export function PluginBetaBadge() {
  return (
    <Badge variant="gray">
      <Trans>Beta</Trans>
    </Badge>
  );
}
