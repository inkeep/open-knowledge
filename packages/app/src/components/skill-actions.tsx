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

/**
 * The shared per-skill action surface, reused by every place that lists a skill
 * (the Settings manager rows and the file-sidebar Skills section). One owner of
 * the install/uninstall side effects + the delete/history dialogs means the two
 * surfaces stay behaviorally identical instead of re-deriving the flow.
 *
 * `useSkillActions` owns the stateful pieces (install-in-flight name, the
 * delete + history dialog targets) and returns the handlers plus a `dialogs`
 * node the caller mounts once. `SkillActionMenuItems` renders the dropdown rows
 * so the menu reads the same wherever it appears. `onEdit` stays per-surface
 * (Settings closes its dialog; the sidebar just opens the editor) and is passed
 * in by the caller.
 */

export interface SkillActions {
  /** Name of the skill whose install/uninstall POST is in flight, or null. */
  installingName: string | null;
  /**
   * Install + surface the result; the caller may use it to reflect new state.
   * `targets` sets the exact editors the skill is installed into (the per-editor
   * menu) — omit to install into the project's configured editors.
   */
  install: (
    skill: SkillsListEntry,
    targets?: readonly string[],
  ) => Promise<Awaited<ReturnType<typeof installSkill>>>;
  uninstall: (skill: SkillsListEntry) => Promise<Awaited<ReturnType<typeof uninstallSkill>>>;
  /** Duplicate a skill into `<name>-copy` (existing names avoid collisions). */
  duplicate: (skill: SkillsListEntry, existingNames: ReadonlySet<string>) => Promise<void>;
  /** Open the (reused) delete-confirm dialog for a skill. */
  requestDelete: (skill: SkillsListEntry) => void;
  /** Open the update-confirm dialog for a pack skill (refresh from bundle). */
  requestUpdate: (skill: SkillsListEntry) => void;
  /** Open the rename dialog for a skill; `existingNames` drives its collision check. */
  requestRename: (skill: SkillsListEntry, existingNames: ReadonlySet<string>) => void;
  /** Mount once per surface — the delete/rename dialogs these actions drive. */
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
    // Report the DELTA vs the prior host set, not just the final set — so a
    // per-editor uncheck reads as an uninstall ("Uninstalled from Cursor")
    // instead of the confusing "Installed into <remaining>". Install is
    // set-exact, so the diff is the true effect of this click.
    const label = (ids: readonly string[]) =>
      ids.map((id) => EDITOR_LABELS[id as keyof typeof EDITOR_LABELS] ?? id).join(', ');
    const now = new Set(result.hosts);
    const added = result.hosts.filter((h) => !skill.hosts.includes(h));
    const removed = skill.hosts.filter((h) => !now.has(h));

    // Switch on the machine-readable warning CODE, not the English message
    // (`warnings[i]` is the display text for `warningCodes[i]`). The server
    // owns the wording; we own the routing.
    const messageFor = (code: SkillInstallWarningCode): string | undefined => {
      const i = result.warningCodes.indexOf(code);
      return i >= 0 ? result.warnings[i] : undefined;
    };
    // `no-targets` means the install projected nowhere — surface it INSTEAD of a
    // success (nothing changed).
    const noTargetsWarning = messageFor('no-targets');
    if (noTargetsWarning) {
      toast.warning(noTargetsWarning);
      return result;
    }
    // The executable-scripts security caution is only relevant when you ADD the
    // skill to an editor — never on a pure uninstall (which removes it). Shown as
    // a second toast alongside the success so the user sees both.
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

/**
 * The dropdown rows for a single skill. Rendered inside a `DropdownMenuContent`
 * by each surface. `onInstall` is optional: the Settings row omits it (it shows
 * a dedicated Install button), while the sidebar 3-dot menu includes it.
 */
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

/**
 * The full per-skill context menu for the file-sidebar Skills rows. Mirrors a
 * file row's menu (Reveal in Finder / Open with AI / Open in Terminal / Copy
 * Path / Duplicate / Rename / Delete) with Install/Uninstall in place of "Hide".
 * Reuses the file menu's own primitives — the desktop bridge (`showItemInFolder`),
 * `OpenInAgentContextSubmenu` (which carries the docked-terminal launch), and the
 * clipboard adapter — plus `useSkillActions` for the install/duplicate/rename/delete flow.
 * No "Edit" row: clicking the sidebar row opens the editor, like a file.
 */
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
  // Desktop-only rows (Reveal / Terminal) render only in OK Desktop; the bridge
  // is absent on the web host, like the file menu's reveal row.
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
