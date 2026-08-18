/**
 * Settings → User → Skills Studio, top block: the user-global skills OK ships
 * (`open-knowledge-discovery`, `open-knowledge-write-skill`).
 *
 * Lived under AI tools & CLI, where nobody looking for a skill thought to open
 * it ("the label on the tab doesn't say anything about
 * skills"). Skills now sit on the page named after them and AI tools keeps the
 * connections; this is the half that moved, unchanged in behaviour.
 *
 * Install/Uninstall stays an explicit button behind a confirm modal — a single
 * click never writes — routed through the same bridge path the
 * editor and PATH rows use (`setComponent` → reclaim), never the skills HTTP
 * API.
 *
 * Desktop-only, but its PAGE is not: Skills Studio renders in the browser too,
 * where the folders block below still works. So a missing bridge renders
 * NOTHING here, rather than the whole-page "desktop app only" fallback that AI
 * tools & CLI can afford as a desktop-gated sidebar item.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { SkillConsentRow } from '@/components/SkillConsentRow';
import { SkillInstallConfirmDialog } from '@/components/SkillInstallConfirmDialog';
import { SkillsStudioIntroDialog } from '@/components/settings/SkillsStudioIntroDialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { OkIntegrationsStatus } from '@/lib/desktop-bridge-types';
import { openSkillPreviewTab } from '@/lib/open-managed-artifact-tab';
import { mark } from '@/lib/perf';
import {
  hasSeenSkillsStudioIntro,
  markSkillsStudioIntroSeen,
} from '@/lib/skills-studio-intro-store';
import { useBuiltinSkillBlurb } from './builtin-skill-copy';

export function BuiltInSkillsSection() {
  const { t } = useLingui();
  const blurbFor = useBuiltinSkillBlurb();
  const bridge = typeof window !== 'undefined' ? (window.okDesktop ?? null) : null;
  const [status, setStatus] = useState<OkIntegrationsStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState<{
    skillId: string;
    mode: 'install' | 'uninstall';
  } | null>(null);
  // Read once at mount, before any dismissal this session writes the flag —
  // reading it live would close the dialog mid-interaction the moment the user
  // clicked Install.
  const [introSeen] = useState(() => hasSeenSkillsStudioIntro());
  const [introDismissed, setIntroDismissed] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    bridge.integrations
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

  // No `finally` — the React Compiler can't lower TryStatement finalizers
  // (BuildHIR::lowerStatement Todo); the catch swallows, so the trailing
  // setPending(false) runs on both paths.
  async function applyToggle(skillId: string, enabled: boolean): Promise<void> {
    if (!bridge) return;
    setPending(true);
    try {
      const result = await bridge.integrations.setComponent({
        component: { kind: 'skill', id: skillId },
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

  // The modal fires this only once the user has acknowledged the destination
  // set it currently shows; mark the attempt with its surface + reach first.
  async function onConfirmSkill(): Promise<void> {
    if (!confirm) return;
    const target = status?.skills.find((s) => s.id === confirm.skillId);
    mark('ok/skill/install', {
      surface: 'settings',
      mode: confirm.mode,
      skill: confirm.skillId,
      hostCount: target?.resolvedHosts.length ?? 0,
    });
    const { skillId, mode } = confirm;
    setConfirm(null);
    await applyToggle(skillId, mode === 'install');
  }

  function dismissIntro(): void {
    markSkillsStudioIntroSeen();
    setIntroDismissed(true);
  }

  if (!bridge) return null;

  const heading = (
    <div>
      <h4 className="text-sm font-medium">
        <Trans comment="Heading above the rows for the skills OpenKnowledge ships, in Settings → Skills Studio">
          Skills from OpenKnowledge
        </Trans>
      </h4>
      <p className="text-1sm text-muted-foreground">
        <Trans comment="Says what the OpenKnowledge-authored skills are for, and where installing one puts it">
          These teach your AI tools how to work with OpenKnowledge. Installing one adds it to every
          AI tool on this machine.
        </Trans>
      </p>
    </div>
  );

  if (loadFailed) {
    return (
      <section
        className="space-y-2 rounded-lg border bg-card p-3"
        data-testid="settings-builtin-skills"
      >
        {heading}
        <p className="text-1sm text-muted-foreground" data-testid="builtin-skills-unavailable">
          <Trans>Couldn't read which skills are installed.</Trans>
        </p>
      </section>
    );
  }

  if (status === null) {
    return (
      <section
        className="space-y-2 rounded-lg border bg-card p-3"
        data-testid="settings-builtin-skills"
      >
        {heading}
        {/* Same shape as SettingsContentSkeleton: a bare skeleton is silence to
            a screen reader, which is indistinguishable from an empty page. */}
        <div
          role="status"
          aria-live="polite"
          aria-busy="true"
          className="space-y-2 pt-1"
          data-testid="builtin-skills-loading"
        >
          <span className="sr-only">
            <Trans>Loading skills</Trans>
          </span>
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      </section>
    );
  }

  if (status.skills.length === 0) return null;

  const busy = pending || !status.available;
  // Re-resolved from live status each render, so the modal always discloses the
  // destinations currently on the status snapshot — it re-confirms on its own
  // if they drift while it is open.
  const confirmSkill = confirm
    ? (status.skills.find((s) => s.id === confirm.skillId) ?? null)
    : null;

  // First visit offers what SETUP does not install — the non-onboarding
  // bundles — not merely whatever is uninstalled. Those differ in the case that
  // matters: a user who unchecked `open-knowledge-discovery` during first-launch
  // setup has it uninstalled precisely BECAUSE they declined it, and re-offering
  // it in a modal would be the app not taking no for an answer. Onboarding
  // bundles were already asked about at the only moment they should be.
  //
  // ponytail: offers the FIRST eligible bundle, not all of them. A second
  // optional bundle would need a list + per-row controls here; one row is the
  // shape the offer actually has today.
  const introOffer = status.skills.find((sk) => !sk.installed && !sk.onboarding) ?? null;
  const showIntro = !introSeen && !introDismissed && !confirm;

  return (
    <section
      className="space-y-2 rounded-lg border bg-card p-3"
      data-testid="settings-builtin-skills"
    >
      {heading}

      {!status.available && (
        <p
          className="text-1sm text-amber-600 dark:text-amber-400"
          data-testid="builtin-skills-read-only"
        >
          <Trans>Managing skills is unavailable in this build.</Trans>
        </p>
      )}

      <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-background/50">
        {status.skills.map((skill) => {
          const hosts = skill.resolvedHosts.map((h) => h.editor);
          const canInstall = hosts.length > 0;
          // Bound as `name` so the accessible names reuse the catalog's existing
          // `Install {name}` / `Uninstall {name}` msgids rather than minting
          // `Install {0}` variants needing fresh translation in every locale.
          const name = skill.name;
          return (
            <li key={skill.id} className="hover:bg-accent">
              <SkillConsentRow
                name={skill.name}
                // The human line, not the frontmatter description: that field
                // is the AGENT's trigger text (discovery's is 600 characters
                // and ends in a `Do NOT load` clause aimed at a model). It
                // still backs the confirm modal and the preview tab.
                description={blurbFor(skill.id) ?? skill.description}
                hosts={hosts}
                size={skill.size}
                onActivate={
                  skill.sourceDir
                    ? () => {
                        mark('ok/skill/preview-open', { surface: 'settings', skill: skill.id });
                        openSkillPreviewTab({
                          flavor: 'builtin',
                          source: skill.sourceDir,
                          name: skill.name,
                          subtitle: '',
                          level: 'global',
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
                      onClick={() => setConfirm({ skillId: skill.id, mode: 'uninstall' })}
                      aria-label={t`Uninstall ${name}`}
                      data-testid={`skills-studio-skill-uninstall-${skill.id}`}
                    >
                      <Trans>Uninstall</Trans>
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      disabled={busy || !canInstall}
                      onClick={() => setConfirm({ skillId: skill.id, mode: 'install' })}
                      aria-label={t`Install ${name}`}
                      data-testid={`skills-studio-skill-install-${skill.id}`}
                    >
                      <Trans>Install</Trans>
                    </Button>
                  )
                }
              />
            </li>
          );
        })}
      </ul>

      {showIntro && (
        <SkillsStudioIntroDialog
          open
          offer={introOffer}
          busy={busy}
          onDismiss={dismissIntro}
          onInstall={() => {
            if (!introOffer) return;
            mark('ok/skill/install', {
              surface: 'skills-studio-intro',
              mode: 'install',
              skill: introOffer.id,
              hostCount: introOffer.resolvedHosts.length,
            });
            dismissIntro();
            void applyToggle(introOffer.id, true);
          }}
        />
      )}

      {confirmSkill && confirm && (
        <SkillInstallConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setConfirm(null);
          }}
          mode={confirm.mode}
          name={confirmSkill.name}
          description={confirmSkill.description}
          paths={confirmSkill.paths}
          size={confirmSkill.size}
          onConfirm={() => void onConfirmSkill()}
        />
      )}
    </section>
  );
}
