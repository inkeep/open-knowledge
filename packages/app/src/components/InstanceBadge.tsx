import { useLingui } from '@lingui/react/macro';
import { GitBranch } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Badge } from './ui/badge';

const UNKNOWN_APP_VERSION = '0.0.0';

interface InstanceBadgeProps {
  readonly className?: string;
  readonly compact?: boolean;
}

export function InstanceBadge({ className, compact = false }: InstanceBadgeProps) {
  const { t } = useLingui();
  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  const label = bridge?.instanceLabel ?? null;
  if (!label) return null;
  const reportedVersion = bridge?.appVersion;
  const version =
    reportedVersion && reportedVersion !== UNKNOWN_APP_VERSION ? reportedVersion : null;
  const description = version
    ? t`${label} build, v${version}. Its settings and data are kept separate from other OpenKnowledge apps.`
    : t`${label} build. Its settings and data are kept separate from other OpenKnowledge apps.`;
  const accessibleName = version
    ? t`App instance: ${label}, v${version}`
    : t`App instance: ${label}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="secondary"
          tabIndex={0}
          data-testid="instance-badge"
          className={cn(
            'cursor-default select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className,
          )}
        >
          {compact ? <GitBranch aria-hidden="true" /> : null}
          <span
            aria-hidden="true"
            data-instance-badge-label=""
            className={cn('max-w-40 truncate', compact && 'sr-only')}
          >
            {label}
          </span>
          <span className="sr-only">{accessibleName}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{description}</TooltipContent>
    </Tooltip>
  );
}
