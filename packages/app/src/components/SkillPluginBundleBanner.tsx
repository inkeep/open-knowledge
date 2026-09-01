import type { SkillScope } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRightIcon, PackageIcon } from 'lucide-react';
import { useState } from 'react';
import {
  type SkillBundleDisclosure,
  SkillPluginBundleDialog,
} from '@/components/SkillPluginBundleDialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

export function SkillPluginBundleBanner({
  bundle,
  source,
  scope,
  previewedName,
  onInstalled,
}: {
  bundle: SkillBundleDisclosure;
  source: string;
  scope: SkillScope;
  previewedName: string;
  onInstalled?: (landed: ReadonlyMap<string, string>) => void;
}) {
  const { t } = useLingui();
  const [picking, setPicking] = useState(false);

  if (bundle.names.length <= 1) return null;

  const caps = [
    bundle.capabilities?.hooks ? t`hooks` : null,
    bundle.capabilities?.commands ? t`commands` : null,
    bundle.capabilities?.mcp ? t`MCP servers` : null,
    bundle.capabilities?.agents ? t`subagents` : null,
  ].filter((c): c is string => c !== null);
  const count = bundle.names.length;
  const plugin = bundle.plugin;
  const siblings = bundle.names.filter((n) => n !== previewedName);
  const shownSiblings = siblings.slice(0, 4);

  return (
    <div className="editor-content-aligned">
      {}
      <Alert role="note" className="my-3 bg-muted/40 px-4 py-3">
        {}
        <PackageIcon className="size-4" aria-hidden />
        <AlertTitle>
          {plugin ? (
            <Trans>
              {plugin} ships {siblings.length} other skills
            </Trans>
          ) : (
            <Trans>{siblings.length} other skills by this publisher</Trans>
          )}
        </AlertTitle>
        {}
        <AlertDescription className="min-w-0">
          {caps.length > 0 ? (
            <Trans>
              The plugin also ships {caps.join(', ')} — named here, never installed by OK.
            </Trans>
          ) : null}
        </AlertDescription>
        {}
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 group-has-[>svg]/alert:col-start-2">
          {shownSiblings.map((n) => (
            <code
              key={n}
              className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[12px] text-foreground/80"
            >
              {n}
            </code>
          ))}
          <Button
            variant="link"
            size="sm"
            className="px-1"
            data-testid="plugin-bundle-pick"
            onClick={() => setPicking(true)}
          >
            <Trans>See all {count} skills</Trans>
          </Button>
          {bundle.repositoryUrl ? (
            <Button variant="ghost" size="sm" asChild>
              <a href={bundle.repositoryUrl} target="_blank" rel="noreferrer">
                <Trans>View plugin</Trans>
                <ArrowUpRightIcon className="size-3.5" />
              </a>
            </Button>
          ) : null}
        </div>
      </Alert>
      <SkillPluginBundleDialog
        bundle={picking ? bundle : null}
        source={source}
        defaultScope={scope}
        onInstalled={onInstalled}
        onOpenChange={setPicking}
      />
    </div>
  );
}
