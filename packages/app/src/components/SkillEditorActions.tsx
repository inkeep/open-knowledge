import type { SkillScope, SkillsListEntry } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronDown, FilePlus } from 'lucide-react';
import { useState } from 'react';
import { AgentIconCluster } from '@/components/AgentIconCluster';
import {
  SKILL_INSTALL_MENU_WIDTH,
  SkillInstallMenuItems,
  useSkillHostToggles,
} from '@/components/SkillInstallMenu';
import { useSkillActions } from '@/components/skill-actions';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSkills } from '@/hooks/use-skills';
import { skillClusterHosts } from '@/lib/skill-scope';
import { cn } from '@/lib/utils';

/**
 * Install chrome for the active skill tab, rendered in the editor's per-document
 * toolbar (`EditorToolbar`) when the active doc is a `__skill__/…` doc. The
 * frontmatter + rename live in the property panel (shared with templates +
 * documents); this is the only skill-specific affordance, since only skills are
 * installed into editor skill folders.
 *
 * One consolidated control — the trigger shows the **brand icons of the agents
 * the skill is installed in** (or an **Install** label when it's in none; no
 * "Draft"/"Installed" text, per the Jul 17 decision) and opens a single
 * **install menu** with a per-editor checkbox each (Claude /
 * Cursor / Codex), Install-on-all, and Uninstall. Collapsing the old Install /
 * Reinstall / Uninstall button row into
 * this menu keeps the right-aligned toolbar cluster narrow so it no longer
 * overlaps the markdown toggle. There is no "Reinstall": install is a live
 * symlink, so editing the source is already reflected everywhere.
 *
 * Install/uninstall route through the shared
 * `useSkillActions` hook — the same flow the sidebar Skills rows use. The
 * skills list refetches via the skills-changed event after a write, so the pill
 * + per-editor checkmarks reflect the new on-disk state without local mirroring.
 */

export function SkillEditorActions({ scope, name }: { scope: SkillScope; name: string }) {
  const { t } = useLingui();
  const skillsState = useSkills();
  const actions = useSkillActions();

  const entry =
    skillsState.status === 'ready'
      ? skillsState.data.find((s) => s.scope === scope && s.name === name)
      : undefined;
  // Until the list resolves, fall back to a minimal Draft entry so the controls
  // render (install is still valid against scope+name).
  const skill: SkillsListEntry = entry ?? {
    scope,
    name,
    path: name,
    description: '',
    installed: false,
    hosts: [],
  };
  // Per-editor install state machine, shared with the sidebar three-dot menu.
  const [menuOpen, setMenuOpen] = useState(false);
  const toggles = useSkillHostToggles(skill, actions);
  const { installed, installing, hostSet } = toggles;
  // No entry yet means the state is UNKNOWN, not "not installed". The list is
  // served from cache, so it reads `ready` while still missing an entry the
  // moment its identity changes — switching a skill between Project and Global
  // used to flash the yellow not-installed pill before the refetch landed.
  //
  // This pill only ever renders for an OPEN skill, and an open skill exists —
  // at minimum at its own source folder — so "not installed" is not a state it
  // can legitimately be in. Unknown resolves to the neutral pill instead.
  const resolving = entry === undefined && !installed;
  // Stable schema order (not Set insertion order); `SkillTargetEditor`-typed so
  // it feeds `TargetIcon` without a cast.
  // Hosts to badge: install-target editors plus the `.agents` hub (a real host
  // for in-place skills; rendered as a neutral mark by AgentIconCluster).
  // Alias-covered VIEWERS (an editor whose skills folder is a symlink into a
  // root that holds this skill) ride the cluster with their brand icon — they
  // genuinely read the skill even though no row/location is theirs.
  // Shared with the sidebar row so the two surfaces cannot disagree; `hostSet`
  // carries this surface's optimistic overlay.
  const installedEditors = entry ? skillClusterHosts(entry, [...hostSet]) : [];

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {/* Add a reference / script / subfolder to the open skill without hunting
          for the sidebar right-click. The shared dialog seeds
          `references/` and mkdirs any nested folders on write. */}
      <Button
        variant="outline"
        size="icon-sm"
        className="shrink-0 text-muted-foreground"
        onClick={() => actions.requestFileCreate(skill)}
        title={t`New file in this skill`}
        aria-label={t`New file in this skill`}
        data-testid="skill-editor-new-file"
      >
        <FilePlus className="size-4" aria-hidden />
      </Button>
      {/* Controlled so a convert can close it: the rows read from a disk scan
          that refetches while folders are being rewritten, so a menu left open
          shows a half-converted state settling. It also cannot be reopened
          mid-run — the trigger is disabled while `installing`. */}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          {/* Status pill + install menu in one button: the label is the state,
              the chevron opens the menu. */}
          <Button
            variant="outline"
            size="sm"
            disabled={installing}
            data-testid="skill-install-menu-trigger"
            data-state={resolving ? 'resolving' : 'installed'}
            className={cn(
              // `aria-expanded:` classes pin the open state to the hover tint; the
              // outline variant otherwise flips it to neutral `bg-muted` on open.
              'h-7 shrink-0 gap-1 rounded-lg border px-2 font-normal text-xs shadow-xs font-mono uppercase',
              resolving
                ? 'border-border bg-muted/50 text-muted-foreground'
                : 'border-primary/50 bg-primary/5 text-primary hover:bg-primary/10 hover:text-primary aria-expanded:bg-primary/10 aria-expanded:text-primary',
            )}
          >
            {installing ? (
              <Trans>Working</Trans>
            ) : resolving ? (
              <Trans>Checking</Trans>
            ) : (
              // The word keeps the pill indicative as a status, then the
              // brand-icon cluster (shared `AgentIconCluster` — real brand colors,
              // same cap/overflow as the sidebar) shows WHICH agents it's
              // projected into.
              <>
                <Trans>Installed</Trans>
                {/* Neutral base so monochrome brands (OpenCode/Pi) don't inherit
                    the pill's primary/blue text color; colored TargetIcons
                    override it with their own brand color. */}
                <AgentIconCluster hosts={installedEditors} className="text-muted-foreground" />
              </>
            )}
            <ChevronDown className="size-4 shrink-0 opacity-50" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={SKILL_INSTALL_MENU_WIDTH}>
          <SkillInstallMenuItems
            toggles={toggles}
            skill={skill}
            onResolveFork={(editor) => actions.requestForkResolve(skill, editor)}
            onRunStart={() => setMenuOpen(false)}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      {actions.dialogs}
    </div>
  );
}
