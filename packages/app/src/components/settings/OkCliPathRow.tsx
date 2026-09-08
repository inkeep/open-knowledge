import { Trans, useLingui } from '@lingui/react/macro';
import { Info } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { OkIntegrationsStatus } from '@/lib/desktop-bridge-types';

export function OkCliPathRow() {
  const { t } = useLingui();
  const bridge = typeof window !== 'undefined' ? (window.okDesktop ?? null) : null;
  const [status, setStatus] = useState<OkIntegrationsStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    bridge.integrations
      .status()
      .then((snapshot) => {
        if (!cancelled) setStatus(snapshot);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  async function toggle(enabled: boolean): Promise<void> {
    if (!bridge) return;
    setBusy(true);
    try {
      const result = await bridge.integrations.setComponent({
        component: { kind: 'path' },
        enabled,
      });
      setStatus(result.status);
      if (!result.ok) toast.error(result.error);
    } catch (err) {
      toast.error(
        t`Couldn't apply the change: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    setBusy(false);
  }

  if (status === null) return null;
  if (!status.path.shellDetected && !status.path.installed) return null;

  const files = status.path.rcFilesToTouch;

  return (
    <div className="flex flex-col gap-1.5" data-testid="ok-cli-path-row">
      {}
      <div className="flex items-start overflow-hidden rounded-md border border-border bg-card/50 hover:bg-accent">
        <Label
          htmlFor="ok-cli-path"
          className="flex flex-1 cursor-pointer items-start gap-2.5 px-3 py-2.5 font-normal"
        >
          <Checkbox
            id="ok-cli-path"
            checked={status.path.installed}
            disabled={busy || !status.available}
            onCheckedChange={() => void toggle(!status.path.installed)}
            className="mt-0.5"
            data-testid="ok-cli-path-checkbox"
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-medium text-foreground text-sm">
              <Trans>
                Add the <code className="inline-code">ok</code> command to your terminal
              </Trans>
            </span>
            <span className="text-muted-foreground text-xs" data-testid="ok-cli-path-status">
              <Trans>Adds a managed block to</Trans>{' '}
              {files.map((file, index) => (
                <span key={file}>
                  {index > 0 ? ', ' : null}
                  <code className="break-all">{file}</code>
                </span>
              ))}
            </span>
          </span>
        </Label>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="mt-1.5 me-1.5 h-6 w-6 shrink-0 text-muted-foreground opacity-60 hover:opacity-100"
              aria-label={t`What this checkbox changes`}
              data-testid="ok-cli-path-info"
            >
              <Info className="size-3.5" />
            </Button>
          </TooltipTrigger>
          {}
          <TooltipContent side="left" className="max-w-sm text-left">
            <div className="flex min-w-0 flex-col gap-1">
              <p className="opacity-70">
                <Trans>Adds a managed block to</Trans>
              </p>
              {files.map((file) => (
                <p key={file}>
                  <code className="break-all">{file}</code>
                </p>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
