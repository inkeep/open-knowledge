import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { AgentIconCluster } from '@/components/AgentIconCluster';
import { Button } from '@/components/ui/button';

export interface SkillConsentRowProps {
  name: string;
  description: string;
  hosts: readonly string[];
  onActivate?: () => void;
  ariaExpanded?: boolean;
  control?: ReactNode;
}

export function SkillConsentRow({
  name,
  description,
  hosts,
  onActivate,
  ariaExpanded,
  control,
}: SkillConsentRowProps) {
  const body = (
    <>
      <span className="text-sm font-medium text-foreground group-hover/button:underline">
        <code>{name}</code>
      </span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </>
  );
  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5" data-testid="skill-consent-row">
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        {onActivate ? (
          <Button
            variant="ghost"
            onClick={onActivate}
            aria-expanded={ariaExpanded}
            className="group/button h-auto w-full flex-col items-start justify-start gap-0.5 whitespace-normal p-0 text-left hover:bg-transparent"
            data-testid="skill-consent-row-preview"
          >
            {body}
          </Button>
        ) : (
          <span className="flex flex-col gap-0.5">{body}</span>
        )}
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {hosts.length > 0 ? (
            <AgentIconCluster hosts={hosts} />
          ) : (
            <span
              className="text-xs text-muted-foreground"
              data-testid="skill-consent-row-no-hosts"
            >
              <Trans>No AI tools detected. Install one to use this skill.</Trans>
            </span>
          )}
        </span>
      </span>
      {control ? <span className="shrink-0">{control}</span> : null}
    </div>
  );
}
