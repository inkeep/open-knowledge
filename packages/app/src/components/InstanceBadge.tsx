import { useLingui } from '@lingui/react/macro';
import { GitBranch } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from './ui/badge';

interface InstanceBadgeProps {
  readonly className?: string;
}

export function InstanceBadge({ className }: InstanceBadgeProps) {
  const { t } = useLingui();
  const label = typeof window !== 'undefined' ? (window.okDesktop?.instanceLabel ?? null) : null;
  if (!label) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="secondary"
          aria-label={t`App instance: ${label}`}
          data-testid="instance-badge"
          className={className}
        >
          <GitBranch aria-hidden="true" />
          <span className="max-w-40 truncate">{label}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{t`${label} uses isolated app data`}</TooltipContent>
    </Tooltip>
  );
}
