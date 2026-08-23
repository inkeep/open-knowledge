/**
 * Settings → User → Skills Studio, top block: the user-global skills OK ships
 * (`open-knowledge-discovery`, `open-knowledge-write-skill`).
 *
 * Lived under AI tools & CLI, where nobody looking for a skill thought to open
 * it ("the label on the tab doesn't say anything about
 * skills"). Skills now sit on the page named after them and AI tools keeps the
 * connections; this is the half that moved, unchanged in behaviour.
 *
 * This section WRITES NOTHING for a skill any more. Each row hands off to the
 * skill's own page, where the per-agent install picker lives; settings owning a
 * second write of the same state is what let one surface say "installed" while
 * the other said which agents.
 *
 * The rows come from `/api/skills` — the same list the sidebar, the tree and
 * the skill's own page read. They used to come from the desktop bridge, which
 * is a second answer to a question that already had one: the bridge enumerates
 * the bundles the app SHIPS, the endpoint reports what is on disk. Nothing kept
 * them in step, so changing a skill's agents from its own page left this page
 * showing the set from before. Reading the endpoint also means these rows now
 * render in the browser, where the rest of Skills Studio already did.
 *
 * The one exception is the first-run intro, which is onboarding rather than
 * management: which bundles first-launch setup already asked about
 * (`onboarding`) is bridge-only knowledge, and the offer installs through the
 * bridge's reclaim path. It is desktop-only and reads the bridge lazily, so a
 * user who has seen it never pays for that call.
 */

import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { SkillConsentRow } from '@/components/SkillConsentRow';
import { SkillsStudioIntroDialog } from '@/components/settings/SkillsStudioIntroDialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useSkills } from '@/hooks/use-skills';
import type { OkIntegrationsStatus } from '@/lib/desktop-bridge-types';
import { openSkillPreviewTab } from '@/lib/open-managed-artifact-tab';
import { mark } from '@/lib/perf';
import { skillClusterHosts } from '@/lib/skill-scope';
import {
  hasSeenSkillsStudioIntro,
  markSkillsStudioIntroSeen,
} from '@/lib/skills-studio-intro-store';
import { builtinBundleDir, useBuiltinSkillBlurb } from './builtin-skill-copy';

export function BuiltInSkillsSection() {
  const { t } = useLingui();
  const blurbFor = useBuiltinSkillBlurb();
  const skills = useSkills();
  const bridge = typeof window !== 'undefined' ? (window.okDesktop ?? null) : null;
  const [introStatus, setIntroStatus] = useState<OkIntegrationsStatus | null>(null);
  const [pending, setPending] = useState(false);
  // Read once at mount, before any dismissal this session writes the flag —
  // reading it live would close the dialog mid-interaction the moment the user
  // clicked Install.
  const [introSeen] = useState(() => hasSeenSkillsStudioIntro());
  const [introDismissed, setIntroDismissed] = useState(false);
  const showIntro = !introSeen && !introDismissed;

  // Bridge read for the INTRO ONLY, and only on the one visit that shows it.
  // The rows below no longer depend on it, so a failure here costs the offer,
  // not the section.
  useEffect(() => {
    if (!bridge || !showIntro) return;
    let cancelled = false;
    bridge.integrations
      .status()
      .then((snapshot) => {
        if (!cancelled) setIntroStatus(snapshot);
      })
      .catch((err) => {
        // The intro is a nicety; the permanent rows carry the same offer. But
        // an IPC failure should not vanish — it is the only signal that the
        // bridge is broken, and the section no longer has a visible error state
        // to carry it.
        console.warn('[skills-studio] bridge integrations.status failed; intro skipped:', err);
        if (!cancelled) setIntroDismissed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, showIntro]);

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
      setIntroStatus(result.status);
      if (!result.ok) toast.error(result.error);
    } catch (err) {
      toast.error(
        t`Couldn't apply the change: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    setPending(false);
  }

  function dismissIntro(): void {
    markSkillsStudioIntroSeen();
    setIntroDismissed(true);
  }

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

  if (skills.status === 'error') {
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

  if (skills.status !== 'ready') {
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

  // The user-global built-ins, in the endpoint's own order.
  const rows = skills.data.filter((s) => s.managed === true && s.scope === 'global');
  if (rows.length === 0) return null;

  const busy = pending;
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
  const introOffer = introStatus?.skills.find((sk) => !sk.installed && !sk.onboarding) ?? null;

  return (
    <section
      className="space-y-2 rounded-lg border bg-card p-3"
      data-testid="settings-builtin-skills"
    >
      {heading}

      <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-background/50">
        {rows.map((skill) => {
          const source = builtinBundleDir(skill.absolutePath);
          return (
            <li key={skill.name} className="hover:bg-accent">
              <SkillConsentRow
                name={skill.name}
                // The human line, not the frontmatter description: that field
                // is the AGENT's trigger text (discovery's is 600 characters
                // and ends in a `Do NOT load` clause aimed at a model), which
                // the preview tab still shows in full.
                description={blurbFor(skill.name) ?? skill.description ?? ''}
                hosts={skillClusterHosts(skill)}
                onActivate={
                  source
                    ? () => {
                        mark('ok/skill/preview-open', {
                          surface: 'settings',
                          skill: skill.name,
                        });
                        openSkillPreviewTab({
                          flavor: 'builtin',
                          source,
                          name: skill.name,
                          subtitle: '',
                          level: 'global',
                        });
                      }
                    : undefined
                }
                control={
                  // An explicit verb beside the row: the body-click preview was
                  // the only way in, and nothing said the row was interactive.
                  source ? (
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid={`builtin-skill-manage-${skill.name}`}
                      onClick={() => {
                        mark('ok/skill/preview-open', {
                          surface: 'settings',
                          skill: skill.name,
                        });
                        openSkillPreviewTab({
                          flavor: 'builtin',
                          source,
                          name: skill.name,
                          subtitle: '',
                          level: 'global',
                        });
                      }}
                    >
                      <Trans>Manage</Trans>
                    </Button>
                  ) : undefined
                }
              />
            </li>
          );
        })}
      </ul>

      {showIntro && introStatus !== null && (
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
    </section>
  );
}
