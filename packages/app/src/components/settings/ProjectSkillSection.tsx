/**
 * Settings → This project → Skills Studio, top block: the `open-knowledge`
 * skill this project ships to whoever opens it.
 *
 * The project-scope sibling of `BuiltInSkillsSection`, moved out of This
 * project → AI tools for the same reason. Moving only the
 * user-global half would have left exactly one skill filed under AI tools,
 * which is worse than no rule at all: skills live in Skills Studio,
 * connections live in AI tools, no exceptions to carry in your head.
 *
 * Unlike the user-global bundles this one is committed to the repo, so the
 * block says so — installing it installs it for everyone on the project.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { SkillConsentRow } from '@/components/SkillConsentRow';
import { SkillInstallConfirmDialog } from '@/components/SkillInstallConfirmDialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { OkProjectIntegrationsStatus } from '@/lib/desktop-bridge-types';
import { openSkillPreviewTab } from '@/lib/open-managed-artifact-tab';
import { useBuiltinSkillBlurb } from './builtin-skill-copy';

export function ProjectSkillSection() {
  const { t } = useLingui();
  const blurbFor = useBuiltinSkillBlurb();
  const bridge = typeof window !== 'undefined' ? (window.okDesktop ?? null) : null;
  const [status, setStatus] = useState<OkProjectIntegrationsStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState(false);
  // One row, so the confirm state is just its mode — no per-row id like the
  // user-global section needs.
  const [confirmMode, setConfirmMode] = useState<'install' | 'uninstall' | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    bridge.projectIntegrations
      .status()
      .then((snapshot) => {
        if (!cancelled) setStatus(snapshot);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  // No `finally` — the React Compiler can't lower TryStatement finalizers; the
  // catch swallows, so the trailing setPending(false) runs on both paths.
  async function applyToggle(enabled: boolean): Promise<void> {
    if (!bridge) return;
    setPending(true);
    try {
      const result = await bridge.projectIntegrations.setComponent({
        component: { kind: 'skill' },
        enabled,
      });
      setStatus(result.status);
      if (!result.ok) toast.error(result.error);
    } catch (err) {
      toast.error(
        t`Couldn't apply the change: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    setPending(false);
  }

  if (!bridge) return null;

  const heading = (
    <div>
      <h4 className="text-sm font-medium">
        {/* Same heading as the user-scope block: both are skills OpenKnowledge
            ships, and naming provenance there but scope here would split one
            kind of thing across two axes. The scope difference is the second
            sentence's job, and the page's own scope chip already says it. */}
        <Trans comment="Heading above the project's own skill row, in Settings → This project → Skills Studio">
          Skills from OpenKnowledge
        </Trans>
      </h4>
      <p className="text-1sm text-muted-foreground">
        <Trans comment="Says what the project skill is for, then the thing that makes it different from the user-scope ones: it is committed to the repo">
          This one teaches your AI tools how to work with OpenKnowledge. It lives in the project
          folder, so it installs for everyone who opens the project.
        </Trans>
      </p>
    </div>
  );

  if (loadFailed) {
    return (
      <section
        className="space-y-2 rounded-lg border bg-card p-3"
        data-testid="settings-project-skill"
      >
        {heading}
        <p className="text-1sm text-muted-foreground" data-testid="project-skill-unavailable">
          <Trans>Couldn't read whether this project's skill is installed.</Trans>
        </p>
      </section>
    );
  }

  if (status === null) {
    return (
      <section
        className="space-y-2 rounded-lg border bg-card p-3"
        data-testid="settings-project-skill"
      >
        {heading}
        {/* Same shape as SettingsContentSkeleton: a bare skeleton is silence to
            a screen reader, which is indistinguishable from an empty page. */}
        <div
          role="status"
          aria-live="polite"
          aria-busy="true"
          className="pt-1"
          data-testid="project-skill-loading"
        >
          <span className="sr-only">
            <Trans>Loading skills</Trans>
          </span>
          <Skeleton className="h-12 w-full" />
        </div>
      </section>
    );
  }

  // No project resolved from this window, or a main process that reports no
  // bundle: nothing truthful to render, and the folders block below still is.
  const skill = status.hasProject ? status.skill : null;
  if (skill === null) return null;

  const busy = pending || !status.available;
  // Defensive: a main process older than this renderer sends no hosts. An empty
  // set renders the row's own no-destination copy rather than crashing.
  const hosts = skill.hosts ?? [];
  // Falls back to the frontmatter description only if the copy module does not
  // know this bundle id (a newer main process shipping a bundle we have no
  // localized line for).
  const rowDescription = blurbFor('project') ?? skill.description;

  return (
    <section
      className="space-y-2 rounded-lg border bg-card p-3"
      data-testid="settings-project-skill"
    >
      {heading}

      <ul className="overflow-hidden rounded-md border border-border bg-background/50">
        <li className="hover:bg-accent">
          <SkillConsentRow
            name="open-knowledge"
            description={rowDescription}
            hosts={hosts}
            size={skill.size}
            onActivate={
              skill.sourceDir
                ? () => {
                    const source = skill.sourceDir;
                    if (!source) return;
                    openSkillPreviewTab({
                      flavor: 'builtin',
                      source,
                      name: 'open-knowledge',
                      subtitle: '',
                      level: 'project',
                    });
                  }
                : undefined
            }
            control={
              skill.installed ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirmMode('uninstall')}
                  data-testid="project-skill-uninstall"
                >
                  <Trans>Uninstall</Trans>
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={busy || hosts.length === 0}
                  onClick={() => setConfirmMode('install')}
                  data-testid="project-skill-install"
                >
                  <Trans>Install</Trans>
                </Button>
              )
            }
          />
        </li>
      </ul>

      {confirmMode && (
        <SkillInstallConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setConfirmMode(null);
          }}
          mode={confirmMode}
          name="open-knowledge"
          // The modal is the disclosure surface, so it quotes the skill's own
          // frontmatter rather than the row's short line.
          description={skill.description || rowDescription}
          paths={skill.paths}
          size={skill.size}
          onConfirm={() => {
            const next = confirmMode === 'install';
            setConfirmMode(null);
            void applyToggle(next);
          }}
        />
      )}
    </section>
  );
}
