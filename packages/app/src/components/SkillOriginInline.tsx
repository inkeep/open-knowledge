import type { SkillScope } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, RefreshCw, Undo2 } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSkillOrigin } from '@/hooks/use-skill-origin';

const LazySkillUpdateConflictDialog = lazy(async () => {
  const mod = await import('@/components/SkillUpdateConflictDialog');
  return { default: mod.SkillUpdateConflictDialog };
});

export function SkillOriginInline({ scope, name }: { scope: SkillScope; name: string }) {
  const { t } = useLingui();
  const {
    origin,
    github,
    displaySource,
    importedTitle,
    canReimport,
    updateAvailable,
    modified,
    autoUpdate,
    gitTracked,
    setAutoUpdate,
    revertable,
    reimport,
    reimporting,
    previewUpdate,
    revert,
    reverting,
  } = useSkillOrigin({ scope, name });
  const [conflict, setConflict] = useState<{ localBody: string; upstreamBody: string } | null>(
    null,
  );

  async function onUpdate() {
    if (modified) {
      const preview = await previewUpdate();
      if (preview) setConflict(preview);
      return;
    }
    await reimport();
  }

  async function onTakeUpstream() {
    await reimport();
    setConflict(null);
  }

  if (!origin) return null;

  return (
    <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
      {}
      {github ? (
        <a
          href={github}
          target="_blank"
          rel="noreferrer"
          title={importedTitle ?? undefined}
          className="hidden min-w-0 max-w-48 items-center gap-1 hover:text-foreground @xl/toolbar:flex"
        >
          <span className="truncate">{displaySource}</span>
          <ArrowUpRight className="size-3 shrink-0" aria-hidden />
        </a>
      ) : (
        <span
          title={importedTitle ?? undefined}
          className="hidden min-w-0 max-w-48 truncate @xl/toolbar:inline"
        >
          {displaySource}
        </span>
      )}
      {canReimport ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex shrink-0 items-center gap-1">
              <label
                htmlFor="skill-auto-update-switch"
                className="hidden cursor-pointer @xl/toolbar:inline"
              >
                <Trans>Auto-update</Trans>
              </label>
              <Switch
                id="skill-auto-update-switch"
                checked={autoUpdate && !gitTracked}
                disabled={gitTracked}
                onCheckedChange={(checked) => void setAutoUpdate(checked === true)}
                aria-label={t`Auto-update from source`}
                className="scale-75"
              />
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {gitTracked ? (
              <Trans>
                Tracked in git — updates flow through your repo (pull or CI), not auto-update
              </Trans>
            ) : autoUpdate ? (
              <Trans>Updates from the source apply automatically (unless edited locally)</Trans>
            ) : (
              <Trans>Auto-update is off — use Update to pull new versions</Trans>
            )}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {modified ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0 rounded-sm bg-amber-500/15 px-1.5 py-0.5 font-medium text-[11px] text-amber-700 dark:text-amber-400">
              <Trans>Modified</Trans>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <Trans>Edited locally since it was installed</Trans>
          </TooltipContent>
        </Tooltip>
      ) : null}
      {modified && canReimport && revertable ? (
        <Tooltip>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void revert()}
            disabled={reverting || reimporting}
            aria-label={t`Revert to installed version`}
            className="shrink-0 gap-1 text-muted-foreground px-2 text-xs hover:text-foreground"
            asChild
          >
            <TooltipTrigger>
              {reverting ? (
                <Spinner icon={Undo2} className="size-3" aria-hidden />
              ) : (
                <Undo2 className="size-3" aria-hidden />
              )}
              <span className="hidden @xl/toolbar:inline">
                {reverting ? <Trans>Reverting</Trans> : <Trans>Revert</Trans>}
              </span>
            </TooltipTrigger>
          </Button>
          <TooltipContent side="bottom">
            <Trans>Discard local edits, restore the installed version</Trans>
          </TooltipContent>
        </Tooltip>
      ) : null}
      {canReimport && updateAvailable ? (
        <Tooltip>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onUpdate()}
            disabled={reimporting || reverting}
            aria-label={t`Update from source`}
            className="shrink-0 gap-1 text-muted-foreground px-2 text-xs hover:text-foreground"
            asChild
          >
            <TooltipTrigger>
              {reimporting ? (
                <Spinner icon={RefreshCw} className="size-3" aria-hidden />
              ) : (
                <RefreshCw className="size-3" aria-hidden />
              )}
              {}
              <span className="hidden @xl/toolbar:inline">
                {reimporting ? <Trans>Updating</Trans> : <Trans>Update</Trans>}
              </span>
            </TooltipTrigger>
          </Button>
          <TooltipContent side="bottom">
            <Trans>Update from source</Trans>
          </TooltipContent>
        </Tooltip>
      ) : null}
      {conflict ? (
        <Suspense fallback={null}>
          <LazySkillUpdateConflictDialog
            open
            onOpenChange={(o) => {
              if (!o) setConflict(null);
            }}
            skillName={name}
            localBody={conflict.localBody}
            upstreamBody={conflict.upstreamBody}
            applying={reimporting}
            onTakeUpstream={() => void onTakeUpstream()}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
