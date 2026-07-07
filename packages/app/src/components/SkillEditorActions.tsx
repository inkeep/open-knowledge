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

/**
 * Install chrome for the active skill tab, rendered in the editor's per-document
 * toolbar (`EditorToolbar`) when the active doc is a `__skill__/…` doc. The
 * frontmatter + rename live in the property panel (shared with templates +
 * documents); this is the only skill-specific affordance, since only skills are
 * installed into editor skill folders.
 *
 * One consolidated control — a non-interactive **status pill** (Installed/Draft)
 * plus a single **install menu** with a per-editor checkbox each (Claude /
 * Cursor / Codex), Install-on-all, and Uninstall. Collapsing the old Install /
 * Reinstall / Uninstall button row into
 * this menu keeps the right-aligned toolbar cluster narrow so it no longer
 * overlaps the markdown toggle. There is no "Reinstall": install is a live
 * symlink, so editing the source is already reflected everywhere.
 *
 * Install/uninstall route through the shared
 * `useSkillActions` hook — the same flow the sidebar + Settings rows use. The
 * skills list refetches via the skills-changed event after a write, so the pill
 * + per-editor checkmarks reflect the new on-disk state without local mirroring.
 */

// The editors a project skill can install into — sourced from the canonical
// `SkillTargetEditorSchema` (its `.options` are narrowed to the project-skill
// editor ids), so this menu can never drift from the install verb + picker +
// schema. `PROJECT_SKILL_EDITOR_IDS` itself is runtime-correct but typed as the
// wider `EditorId[]` (filter doesn't narrow); `.options` is the narrowed source.
const INSTALL_EDITORS: readonly SkillTargetEditor[] = SkillTargetEditorSchema.options;

export function SkillEditorActions({ scope, name }: { scope: SkillScope; name: string }) {
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
  const installing = actions.installingName === name;

  // Optimistic host overlay so RAPID per-editor toggles compose correctly. Each
  // checkbox click must build on the LATEST intended set, not the last server
  // refetch (which lags a click or two behind) — otherwise unchecking 3 editors
  // fast computes every click off the original full set and never reaches empty.
  // `liveHostsRef` is updated SYNCHRONOUSLY so consecutive clicks (before React
  // re-renders) still see the prior toggle. The actual install is DEBOUNCED so N
  // quick clicks become ONE set-exact write, avoiding concurrent installs racing
  // on the marker file.
  const [optimisticHosts, setOptimisticHosts] = useState<string[] | null>(null);
  const effectiveHosts = optimisticHosts ?? skill.hosts;
  const hostSet = new Set(effectiveHosts);
  const installed = optimisticHosts ? optimisticHosts.length > 0 : skill.installed;

  const liveHostsRef = useRef<string[]>(skill.hosts);
  // Re-sync the ref to server truth whenever the overlay is cleared (the
  // debounced write settled, or an external change arrived).
  useEffect(() => {
    if (optimisticHosts === null) liveHostsRef.current = skill.hosts;
  }, [optimisticHosts, skill.hosts]);

  // Drop the overlay once the server's fetched hosts catch up to it.
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
    // On failure the server state is unchanged, but the optimistic overlay still
    // shows the attempted set and the convergence effect never clears it (the
    // refetch returns the OLD hosts, which never match the overlay) — the pill
    // would stay stuck on the wrong state for the session. Roll back to server
    // truth by dropping the overlay; the resync effect restores `liveHostsRef`.
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
                // Roll back the optimistic "Draft" overlay on failure — without
                // this it would stick (server still reports the old hosts, which
                // never match the empty overlay, so it never converges).
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
