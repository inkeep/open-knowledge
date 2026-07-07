import type { SkillsListEntry } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { DownloadCloud, MoreVertical } from 'lucide-react';
import { OpenInAgentMenu } from '@/components/handoff/OpenInAgentMenu';
import { buildSkillHandoffInput } from '@/components/handoff/useHandoffDispatch';
import { SkillStateBadge } from '@/components/SkillStateBadge';
import { SkillActionMenuItems } from '@/components/skill-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useWorkspace } from '@/lib/use-workspace';

interface SkillRowProps {
  skill: SkillsListEntry;
  onEdit: () => void;
  onDelete: () => void;
  onInstall: () => void;
  onUninstall: () => void;
  /** True while this row's install POST is in flight. */
  installing: boolean;
}

/**
 * One row in the Skills manager list: the skill's name + description, a state
 * badge (Installed vs Draft), one badge per editor host it's installed into,
 * and an Install action + an Edit/Delete menu. A skill with no on-disk
 * `description` (malformed/empty frontmatter) is surfaced with a "needs
 * description" note — it still lists rather than silently dropping.
 *
 * Clicking the row body opens edit; the 3-dot menu carries Edit + Delete; the
 * Install button projects the skill into the project's target editors.
 */
export function SkillRow({
  skill,
  onEdit,
  onDelete,
  onInstall,
  onUninstall,
  installing,
}: SkillRowProps) {
  const { t } = useLingui();
  const workspace = useWorkspace();
  // "Open with AI" (author-with-AI): hand the skill to an installed agent so it
  // writes/edits it via the open-knowledge-write-skill meta-skill. Reuses the
  // shared handoff menu (config-gated on installed agents); `null` input
  // disables its trigger until the workspace is loaded.
  const handoffInput = buildSkillHandoffInput({
    skillName: skill.name,
    scope: skill.scope,
    workspace,
  });
  return (
    <li
      className="group flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50"
      data-testid={`skill-row-${skill.name}`}
    >
      <Button
        type="button"
        variant="ghost"
        onClick={onEdit}
        className="h-auto min-w-0 flex-1 flex-col items-start gap-0.5 px-1.5 py-1 text-left font-normal hover:bg-transparent"
      >
        <span className="flex w-full items-center gap-2">
          <code className="truncate font-mono font-medium">{skill.name}</code>
          <SkillStateBadge installed={skill.installed} className="text-2xs" />
        </span>
        {skill.description ? (
          <span className="block w-full truncate text-sm text-muted-foreground">
            {skill.description}
          </span>
        ) : (
          <span className="block w-full truncate text-sm italic text-muted-foreground">
            <Trans>No description yet — add one so agents know when to use this skill.</Trans>
          </span>
        )}
        {skill.hosts.length > 0 ? (
          <span className="flex flex-wrap items-center gap-1 pt-0.5">
            <span className="sr-only">
              <Trans>Installed into</Trans>
            </span>
            {skill.hosts.map((host) => (
              <Badge key={host} variant="gray" className="text-2xs">
                {host}
              </Badge>
            ))}
          </span>
        ) : null}
      </Button>
      <span className="shrink-0 self-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 data-[state=open]:opacity-100">
        <OpenInAgentMenu input={handoffInput} />
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="shrink-0 self-center font-mono uppercase opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        onClick={onInstall}
        disabled={installing}
        data-testid={`skill-install-${skill.name}`}
      >
        <DownloadCloud className="size-3.5" aria-hidden />
        {skill.installed ? <Trans>Installed</Trans> : <Trans>Install</Trans>}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 self-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
            aria-label={t`Actions for ${skill.name}`}
          >
            <MoreVertical className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          {/* Install stays a dedicated button on this row, so the menu omits it. */}
          <SkillActionMenuItems
            skill={skill}
            onEdit={onEdit}
            onUninstall={onUninstall}
            onDelete={onDelete}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
