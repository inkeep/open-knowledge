import { Trans, useLingui } from '@lingui/react/macro';
import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export function ConfigSharingInfoTooltip() {
  const { t } = useLingui();
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          className="text-muted-foreground hover:text-foreground"
          aria-label={t`What config sharing covers`}
          data-testid="config-sharing-info"
        >
          <Info className="size-3.5" aria-hidden />
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <p className="leading-relaxed wrap-break-word">
            <Trans>
              Setup files include: <code>.ok/</code>, AI-tool MCP configs (<code>.mcp.json</code>{' '}
              and per-tool files). Your skills are not covered — they follow git like any other file
              in the project.
              <br />
              <strong className="font-semibold">Shared</strong> commits them to git, so anyone who
              clones the repo gets the same setup. <br />
              <strong className="font-semibold">Only me</strong> keeps them out of git (via{' '}
              <code>.git/info/exclude</code>).
            </Trans>
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
