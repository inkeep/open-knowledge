import type { SkillScope } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRightIcon, PackageIcon } from 'lucide-react';
import { useState } from 'react';
import {
  type SkillBundleDisclosure,
  SkillPluginBundleDialog,
} from '@/components/SkillPluginBundleDialog';
import { Button } from '@/components/ui/button';

/**
 * Disclosure for a skills.sh skill whose SOURCE carries more than the one skill
 * skills.sh showed. Two shapes reach here (normalized upstream into
 * {@link SkillBundleDisclosure}): a cloned repo that declares a plugin manifest,
 * and a website source whose `.well-known` index lists every skill on the
 * origin. Either way the point is the same — the siblings exist, and they are
 * how a skill's `/other-skill` references resolve.
 *
 * The action opens a PICKER, never a one-click "install all": the whole
 * selection rides one server-side fetch, but which skills land is the user's
 * call. A plugin's executable capabilities (hooks / commands / MCP) are named
 * here, never installed and never run by OK.
 */
export function SkillPluginBundleBanner({
  bundle,
  source,
  scope,
  onInstalled,
}: {
  bundle: SkillBundleDisclosure;
  /** The preview's import source — what the bulk import fetches from. */
  source: string;
  /** Level the picker opens on (the preview's own level). */
  scope: SkillScope;
  /** Skills that landed, requested name → on-disk name. The hosting preview tab
   *  needs this: the bulk import runs entirely inside this banner, so without it
   *  the tab keeps previewing a skill the user now owns. */
  onInstalled?: (landed: ReadonlyMap<string, string>) => void;
}) {
  const { t } = useLingui();
  const [picking, setPicking] = useState(false);

  // Only surface when there's more than the one skill skills.sh showed.
  if (bundle.names.length <= 1) return null;

  const caps = [
    bundle.capabilities?.hooks ? t`hooks` : null,
    bundle.capabilities?.commands ? t`commands` : null,
    bundle.capabilities?.mcp ? t`MCP servers` : null,
    bundle.capabilities?.agents ? t`subagents` : null,
  ].filter((c): c is string => c !== null);
  const count = bundle.names.length;
  const plugin = bundle.plugin;

  return (
    <div className="editor-content-aligned">
      <div className="my-3 rounded-lg border border-border bg-muted/40 px-4 py-3">
        <div className="flex items-start gap-3">
          <PackageIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-sm">
              {plugin ? (
                <Trans>Part of the {plugin} plugin</Trans>
              ) : (
                // No manifest to name — the source itself is the grouping.
                <Trans>{count} skills at this source</Trans>
              )}
            </p>
            <p className="text-muted-foreground text-sm">
              {caps.length > 0 ? (
                <Trans>
                  This repo bundles {count} skills, plus {caps.join(', ')}. Install any of them from
                  the plugin.
                </Trans>
              ) : plugin ? (
                <Trans>
                  This repo bundles {count} skills. Install any of them from the plugin.
                </Trans>
              ) : (
                <Trans>
                  {source} publishes {count} skills. Install any of them together.
                </Trans>
              )}
            </p>
            <div className="mt-2.5 flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                data-testid="plugin-bundle-pick"
                onClick={() => setPicking(true)}
              >
                <Trans>Install skills</Trans>
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
          </div>
        </div>
      </div>
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
