import type { SkillScope, SkillsListEntry, SkillTargetEditor } from '@inkeep/open-knowledge-core';
import { EDITOR_LABELS, SkillTargetEditorSchema } from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSkillActions } from '@/components/skill-actions';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSkills } from '@/hooks/use-skills';
import { cn } from '@/lib/utils';

const INSTALL_EDITORS: readonly SkillTargetEditor[] = SkillTargetEditorSchema.options;

export function SkillEditorActions({ scope, name }: { scope: SkillScope; name: string }) {
  const skillsState = useSkills();
  const actions = useSkillActions();

  const entry =
    skillsState.status === 'ready'
      ? skillsState.data.find((s) => s.scope === scope && s.name === name)
      : undefined;
  const skill: SkillsListEntry = entry ?? {
    scope,
    name,
    path: name,
    description: '',
    installed: false,
    hosts: [],
  };
  const installing = actions.installingName === name;

  const [optimisticHosts, setOptimisticHosts] = useState<string[] | null>(null);
  const effectiveHosts = optimisticHosts ?? skill.hosts;
  const hostSet = new Set(effectiveHosts);
  const installed = optimisticHosts ? optimisticHosts.length > 0 : skill.installed;

  const liveHostsRef = useRef<string[]>(skill.hosts);
  useEffect(() => {
    if (optimisticHosts === null) liveHostsRef.current = skill.hosts;
  }, [optimisticHosts, skill.hosts]);

  const serverHostsKey = [...skill.hosts].sort().join(',');
  useEffect(() => {
    setOptimisticHosts((prev) =>
      prev && [...prev].sort().join(',') === serverHostsKey ? null : prev,
    );
  }, [serverHostsKey]);

  const installTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (installTimer.current) clearTimeout(installTimer.current);
    },
    [],
  );
  function commitHosts(nextHosts: string[], debounce: boolean) {
    liveHostsRef.current = nextHosts;
    setOptimisticHosts(nextHosts);
    if (installTimer.current) clearTimeout(installTimer.current);
    const run = async () => {
      const result = await actions.install(skill, nextHosts);
      if (!result.ok) setOptimisticHosts(null);
    };
    if (debounce) {
      installTimer.current = setTimeout(() => void run(), 350);
    } else {
      void run();
    }
  }

  function toggleEditor(editor: SkillTargetEditor, on: boolean) {
    const next = new Set<string>(liveHostsRef.current);
    if (on) next.add(editor);
    else next.delete(editor);
    commitHosts([...next], true);
  }

  return (
    <div className="flex items-center gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* Status + install menu in ONE pill-shaped button: the label IS the
              state (Installed/Draft) and the chevron opens the install/uninstall/
              per-editor menu. Mirrors the `primary`/`warning` Badge styling so it
              still reads as the state pill, just interactive. */}
          <Button
            variant="outline"
            size="sm"
            disabled={installing}
            data-testid="skill-install-menu-trigger"
            data-state={installed ? 'installed' : 'draft'}
            className={cn(
              'h-6 gap-1 rounded-sm border px-1.5 font-mono text-xs uppercase shadow-none',
              installed
                ? 'border-primary/50 bg-primary/5 text-primary hover:bg-primary/10 hover:text-primary'
                : 'border-yellow-500/40 bg-yellow-500/10 text-yellow-600 hover:bg-yellow-500/20 hover:text-yellow-600',
            )}
          >
            {installing ? (
              <Trans>Working</Trans>
            ) : installed ? (
              <Trans>Installed</Trans>
            ) : (
              <Trans>Draft</Trans>
            )}
            <ChevronDown aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuLabel>
            <Trans>Install on</Trans>
          </DropdownMenuLabel>
          {INSTALL_EDITORS.map((editor) => (
            <DropdownMenuCheckboxItem
              key={editor}
              checked={hostSet.has(editor)}
              onCheckedChange={(on) => toggleEditor(editor, on === true)}
              data-testid={`skill-install-editor-${editor}`}
            >
              {EDITOR_LABELS[editor]}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="skill-install-all"
            onSelect={() => commitHosts([...INSTALL_EDITORS], false)}
          >
            <Trans>Install on all</Trans>
          </DropdownMenuItem>
          {installed ? (
            <DropdownMenuItem
              data-testid="skill-uninstall"
              onSelect={() => {
                if (installTimer.current) clearTimeout(installTimer.current);
                liveHostsRef.current = [];
                setOptimisticHosts([]);
                void (async () => {
                  const result = await actions.uninstall(skill);
                  if (!result.ok) setOptimisticHosts(null);
                })();
              }}
            >
              <Trans>Uninstall everywhere</Trans>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {actions.dialogs}
    </div>
  );
}
