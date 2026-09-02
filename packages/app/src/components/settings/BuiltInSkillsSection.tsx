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
  const [introSeen] = useState(() => hasSeenSkillsStudioIntro());
  const [introDismissed, setIntroDismissed] = useState(false);
  const showIntro = !introSeen && !introDismissed;

  useEffect(() => {
    if (!bridge || !showIntro) return;
    let cancelled = false;
    bridge.integrations
      .status()
      .then((snapshot) => {
        if (!cancelled) setIntroStatus(snapshot);
      })
      .catch((err) => {
        console.warn('[skills-studio] bridge integrations.status failed; intro skipped:', err);
        if (!cancelled) setIntroDismissed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, showIntro]);

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
        {}
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

  const rows = skills.data.filter((s) => s.managed === true && s.scope === 'global');
  if (rows.length === 0) return null;

  const busy = pending;
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
