import {
  EDITOR_LABELS,
  type SkillInstallWarningCode,
  type SkillsListEntry,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Copy,
  CopyPlus,
  DownloadCloud,
  FolderOpen,
  Pencil,
  PencilLine,
  PowerOff,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { OpenInAgentContextSubmenu } from '@/components/handoff/OpenInAgentContextSubmenu';
import {
  buildSkillHandoffInput,
  useHandoffDispatch,
} from '@/components/handoff/useHandoffDispatch';
import { useInstalledAgents } from '@/components/handoff/useInstalledAgents';
import { SkillDeleteDialog } from '@/components/SkillDeleteDialog';
import { SkillRenameDialog } from '@/components/SkillRenameDialog';
import { SkillUpdateDialog } from '@/components/SkillUpdateDialog';
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { scheduleClipboardWrite } from '@/lib/share/clipboard-adapter';
import { duplicateSkill, installSkill, uninstallSkill } from '@/lib/skills-api';
import { useWorkspace } from '@/lib/use-workspace';

export interface SkillActions {
  installingName: string | null;
  install: (
    skill: SkillsListEntry,
    targets?: readonly string[],
  ) => Promise<Awaited<ReturnType<typeof installSkill>>>;
  uninstall: (skill: SkillsListEntry) => Promise<Awaited<ReturnType<typeof uninstallSkill>>>;
  duplicate: (skill: SkillsListEntry, existingNames: ReadonlySet<string>) => Promise<void>;
  requestDelete: (skill: SkillsListEntry) => void;
  requestUpdate: (skill: SkillsListEntry) => void;
  requestRename: (skill: SkillsListEntry, existingNames: ReadonlySet<string>) => void;
  dialogs: ReactNode;
}

export function useSkillActions(): SkillActions {
  const { t } = useLingui();
  const [deleteTarget, setDeleteTarget] = useState<SkillsListEntry | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    skill: SkillsListEntry;
    existingNames: ReadonlySet<string>;
  } | null>(null);
  const [updateTarget, setUpdateTarget] = useState<SkillsListEntry | null>(null);
  const [installingName, setInstallingName] = useState<string | null>(null);

  async function install(skill: SkillsListEntry, targets?: readonly string[]) {
    setInstallingName(skill.name);
    const result = await installSkill({
      scope: skill.scope,
      name: skill.name,
      ...(targets ? { targets: [...targets] } : {}),
    });
    setInstallingName(null);
    if (!result.ok) {
      toast.error(t`Couldn't install skill: ${result.error}`);
      return result;
    }
    const label = (ids: readonly string[]) =>
      ids.map((id) => EDITOR_LABELS[id as keyof typeof EDITOR_LABELS] ?? id).join(', ');
    const now = new Set(result.hosts);
    const added = result.hosts.filter((h) => !skill.hosts.includes(h));
    const removed = skill.hosts.filter((h) => !now.has(h));

    const messageFor = (code: SkillInstallWarningCode): string | undefined => {
      const i = result.warningCodes.indexOf(code);
      return i >= 0 ? result.warnings[i] : undefined;
    };
    const noTargetsWarning = messageFor('no-targets');
    if (noTargetsWarning) {
      toast.warning(noTargetsWarning);
      return result;
    }
    if (added.length > 0) {
      const scriptsWarning = messageFor('scripts-present');
      if (scriptsWarning) toast.warning(scriptsWarning);
    }

    if (result.hosts.length === 0) {
      toast.success(t`"${skill.name}" uninstalled — back to a draft`);
    } else if (added.length > 0 && removed.length === 0) {
      toast.success(t`Installed "${skill.name}" into ${label(added)}`);
    } else if (removed.length > 0 && added.length === 0) {
      toast.success(t`Uninstalled "${skill.name}" from ${label(removed)}`);
    } else if (added.length > 0 && removed.length > 0) {
      toast.success(t`Updated "${skill.name}": added ${label(added)}, removed ${label(removed)}`);
    } else {
      toast.success(t`"${skill.name}" install refreshed (${label(result.hosts)})`);
    }
    return result;
  }

  async function uninstall(skill: SkillsListEntry) {
    setInstallingName(skill.name);
    const result = await uninstallSkill({ scope: skill.scope, name: skill.name });
    setInstallingName(null);
    if (!result.ok) {
      toast.error(t`Couldn't uninstall skill: ${result.error}`);
    } else {
      toast.success(t`"${skill.name}" uninstalled — back to a draft`);
    }
    return result;
  }

  async function duplicate(skill: SkillsListEntry, existingNames: ReadonlySet<string>) {
    const result = await duplicateSkill({ scope: skill.scope, name: skill.name, existingNames });
    if (!result.ok) {
      toast.error(t`Couldn't duplicate "${skill.name}": ${result.error}`);
      return;
    }
    toast.success(t`Duplicated to "${result.name}"`);
  }

  const dialogs = (
    <>
      <SkillDeleteDialog
        skill={deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onDeleted={() => setDeleteTarget(null)}
      />
      <SkillRenameDialog
        skill={renameTarget?.skill ?? null}
        existingNames={renameTarget?.existingNames ?? EMPTY_NAME_SET}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
        onRenamed={() => setRenameTarget(null)}
      />
      <SkillUpdateDialog
        skill={updateTarget}
        onOpenChange={(open) => {
          if (!open) setUpdateTarget(null);
        }}
        onUpdated={() => setUpdateTarget(null)}
      />
    </>
  );

  return {
    installingName,
    install,
    uninstall,
    duplicate,
    requestDelete: setDeleteTarget,
    requestRename: (skill, existingNames) => setRenameTarget({ skill, existingNames }),
    requestUpdate: setUpdateTarget,
    dialogs,
  };
}

const EMPTY_NAME_SET: ReadonlySet<string> = new Set();

export function SkillActionMenuItems({
  skill,
  onEdit,
  onInstall,
  onUninstall,
  onDelete,
}: {
  skill: SkillsListEntry;
  onEdit: () => void;
  onInstall?: () => void;
  onUninstall: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <DropdownMenuItem onSelect={onEdit}>
        <Pencil aria-hidden />
        <Trans>Edit</Trans>
      </DropdownMenuItem>
      {onInstall && !skill.installed ? (
        <DropdownMenuItem onSelect={onInstall}>
          <DownloadCloud aria-hidden />
          <Trans>Install</Trans>
        </DropdownMenuItem>
      ) : null}
      {skill.installed ? (
        <DropdownMenuItem onSelect={onUninstall}>
          <PowerOff aria-hidden />
          <Trans>Uninstall</Trans>
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem variant="destructive" onSelect={onDelete}>
        <Trash2 aria-hidden />
        <Trans>Delete</Trans>
      </DropdownMenuItem>
    </>
  );
}

export function SkillContextMenuItems({
  skill,
  actions,
  existingNames,
}: {
  skill: SkillsListEntry;
  actions: SkillActions;
  existingNames: ReadonlySet<string>;
}) {
  const { t } = useLingui();
  const workspace = useWorkspace();
  const installStates = useInstalledAgents().states;
  const { dispatch } = useHandoffDispatch();
  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  const absolutePath = skill.absolutePath;

  async function copy(text: string) {
    try {
      await scheduleClipboardWrite(text);
      toast.success(t`Copied path`);
    } catch {
      toast.error(t`Couldn't copy path`);
    }
  }

  return (
    <>
      {bridge && absolutePath ? (
        <DropdownMenuItem onSelect={() => void bridge.shell.showItemInFolder(absolutePath)}>
          <FolderOpen aria-hidden />
          <Trans>Reveal in Finder</Trans>
        </DropdownMenuItem>
      ) : null}
      {/* Open in Terminal lives inside this submenu now (docked terminal + AI
          handoff) — the standalone system-terminal item was removed app-wide
          when the in-app shell landed. */}
      <OpenInAgentContextSubmenu
        input={buildSkillHandoffInput({ skillName: skill.name, scope: skill.scope, workspace })}
        installStates={installStates}
        isElectronHost={bridge != null}
        dispatch={dispatch}
      />
      {/* Always available: Relative Path needs no host. Full Path appears once
          the server has supplied the skill's absolute path (always, post-build;
          absent only on a cold partial entry). */}
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Copy aria-hidden />
          <Trans>Copy Path</Trans>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {absolutePath ? (
            <DropdownMenuItem onSelect={() => void copy(absolutePath)}>
              <Trans>Full Path</Trans>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => void copy(skill.path)}>
            <Trans>Relative Path</Trans>
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => void actions.duplicate(skill, existingNames)}>
        <CopyPlus aria-hidden />
        <Trans>Duplicate</Trans>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => actions.requestRename(skill, existingNames)}>
        <PencilLine aria-hidden />
        <Trans>Rename</Trans>
      </DropdownMenuItem>
      {skill.updateAvailable ? (
        <DropdownMenuItem onSelect={() => actions.requestUpdate(skill)}>
          <RefreshCw aria-hidden />
          <Trans>Update skill</Trans>
        </DropdownMenuItem>
      ) : null}
      {skill.installed ? (
        <DropdownMenuItem onSelect={() => void actions.uninstall(skill)}>
          <PowerOff aria-hidden />
          <Trans>Uninstall</Trans>
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem onSelect={() => void actions.install(skill)}>
          <DownloadCloud aria-hidden />
          <Trans>Install</Trans>
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onSelect={() => actions.requestDelete(skill)}>
        <Trash2 aria-hidden />
        <Trans>Delete</Trans>
      </DropdownMenuItem>
    </>
  );
}
