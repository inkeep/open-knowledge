/**
 * Feature-maturity "Beta" tag for a plugin — always visible, about the feature,
 * not the build (mirrors the ACP AgentBetaBadge). Rendered on every surface the
 * feature owns: the Plugins manage row, the plugin's settings panel header, and
 * (for frontmatter schemas) the schema file editor.
 *
 * Sizing is the `Badge` default on purpose. This badge used to hard-code a
 * smaller `h-4 px-1 text-[10px]`, which is invisible while a header carries only
 * one badge — but a plugin that is BOTH beta and scoped renders this next to
 * `ScopeBadge`, which uses the default, and the pair came out visibly mismatched.
 * `Badge` has no size variant, so the smaller values were a one-off override;
 * the default is the design-system size every other badge in the app uses.
 * Callers that genuinely need a denser badge pass the sizing through
 * `className` (tailwind-merge lets it win over the base).
 */

import { Trans } from '@lingui/react/macro';
import { Badge } from '@/components/ui/badge';

export function PluginBetaBadge({ className }: { readonly className?: string }) {
  return (
    <Badge variant="gray" className={className}>
      <Trans>Beta</Trans>
    </Badge>
  );
}
