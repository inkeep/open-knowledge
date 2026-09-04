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

export function SkillEditorActions({
  scope,
  name,
  showNewFile = true,
}: {
  scope: SkillScope;
  name: string;
  showNewFile?: boolean;
}) {
  const { t } = useLingui();
  const skillsState = useSkills();
  const actions = useSkillActions();

  const listed = skillsState.status === 'ready' ? skillsState.data : undefined;
  const exact = listed?.find((s) => s.scope === scope && s.name === name);
  const byName = exact === undefined ? listed?.filter((s) => s.name === name) : undefined;
  const entry = exact ?? (byName?.length === 1 ? byName[0] : undefined);
  const skill: SkillsListEntry = entry ?? {
    scope,
    name,
    path: name,
    description: '',
    installed: false,
    hosts: [],
  };
  const [menuOpen, setMenuOpen] = useState(false);
  const toggles = useSkillHostToggles(skill, actions);
  const { installed, installing, hostSet } = toggles;
  const resolving = entry === undefined && !installed;
  const installedEditors = entry ? skillClusterHosts(entry, [...hostSet]) : [];

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {}
      {showNewFile ? (
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
      ) : null}
      {}
      <DropdownMenu modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          {}
          <Button
            variant="outline"
            size="sm"
            disabled={installing}
            data-testid="skill-install-menu-trigger"
            data-state={resolving ? 'resolving' : 'installed'}
            className={cn(
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
              <>
                <Trans>Installed</Trans>
                {}
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
