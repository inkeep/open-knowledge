import { Trans, useLingui } from '@lingui/react/macro';
import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Info tooltip carrying the technical detail of what config sharing covers, so
 * the visible copy can stay plain-language. Shared by the open-folder consent
 * dialog, the create-project dialog, and Settings → Config sharing.
 *
 * The content is wrapped in a single block element on purpose: `TooltipContent`
 * is an `inline-flex` row, so bare text + `<code>` siblings would each become
 * flex items and wrap into cramped columns. One block child restores normal
 * inline text flow.
 */
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
              and per-tool files), project skills, and <code>.claude/launch.json</code>.
              <br />
              <strong className="font-semibold">Shared</strong> commits them to git, so anyone who
              clones the repo gets the same setup. <br />
              <strong className="font-semibold">Local only</strong> keeps them out of git (via{' '}
              <code>.git/info/exclude</code>).
            </Trans>
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
