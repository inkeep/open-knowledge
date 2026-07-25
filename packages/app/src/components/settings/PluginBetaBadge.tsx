/**
 * Feature-maturity "Beta" tag for the frontmatter schemas plugin — always
 * visible, about the feature, not the build (mirrors the ACP AgentBetaBadge).
 * Rendered on every surface the feature owns: the Plugins manage row, the
 * plugin's settings panel header, and the schema file editor.
 */

import { Trans } from '@lingui/react/macro';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export function PluginBetaBadge({ className }: { readonly className?: string }) {
  return (
    <Badge variant="gray" className={cn('h-4 px-1 text-[10px]', className)}>
      <Trans>Beta</Trans>
    </Badge>
  );
}
