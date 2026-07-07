import { Trans } from '@lingui/react/macro';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * Installed vs Draft state for a skill — one source shared by the Settings list
 * row (`SkillRow`), the sidebar Skills section, and the editor header.
 *
 * `subtle` renders a muted inline label instead of the filled pill — used in the
 * file sidebar so the state reads as quiet metadata next to the row (cohesive
 * with the icon + name file rows) rather than a loud badge.
 */
export function SkillStateBadge({
  installed,
  className,
  subtle = false,
}: {
  installed: boolean;
  className?: string;
  subtle?: boolean;
}) {
  const testId = installed ? 'skill-state-installed' : 'skill-state-draft';
  if (subtle) {
    return (
      <span
        className={cn(
          'text-2xs',
          installed ? 'text-primary/80' : 'text-muted-foreground/70',
          className,
        )}
        data-testid={testId}
      >
        {installed ? <Trans>Installed</Trans> : <Trans>Draft</Trans>}
      </span>
    );
  }
  return (
    <Badge variant={installed ? 'primary' : 'warning'} className={className} data-testid={testId}>
      {installed ? <Trans>Installed</Trans> : <Trans>Draft</Trans>}
    </Badge>
  );
}
