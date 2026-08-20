/**
 * Feature-maturity "Beta" tag for a plugin — about the feature, not the build
 * (unlike `BetaBadge`, which marks the beta auto-update channel). Render it on
 * every surface a beta plugin owns.
 *
 * Sizing is the `Badge` default on purpose. This badge used to hard-code a
 * smaller `h-4 px-1 text-[10px]`, which is invisible while a header carries only
 * one badge — but a plugin that is BOTH beta and scoped renders this next to
 * `ScopeBadge`, which uses the default, and the pair came out visibly mismatched.
 * `Badge` has no size variant, so the smaller values were a one-off override;
 * the default is the design-system size every other badge in the app uses.
 */

import { Trans } from '@lingui/react/macro';
import { Badge } from '@/components/ui/badge';

export function PluginBetaBadge() {
  return (
    <Badge variant="gray">
      <Trans>Beta</Trans>
    </Badge>
  );
}
