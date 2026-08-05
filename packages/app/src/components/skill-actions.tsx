import {
  EDITOR_LABELS,
  type SkillInstallWarningCode,
  type SkillScope,
  type SkillsListEntry,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  ArrowLeftRight,
  Copy,
  CopyPlus,
  DownloadCloud,
  FilePlus,
  FolderOpen,
  PencilLine,
  Trash2,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { OpenInAgentContextSubmenu } from '@/components/handoff/OpenInAgentContextSubmenu';
import { OpenInAgentEmptySpaceSubmenu } from '@/components/handoff/OpenInAgentEmptySpaceSubmenu';
import {
  buildSkillHandoffInput,
  useHandoffDispatch,
} from '@/components/handoff/useHandoffDispatch';
import { useInstalledAgents } from '@/components/handoff/useInstalledAgents';
import { SkillDeleteDialog } from '@/components/SkillDeleteDialog';
import {
  SkillFileCreateDialog,
  type SkillFileCreateTarget,
} from '@/components/SkillFileCreateDialog';
import {
  SkillFileDeleteDialog,
  type SkillFileDeleteTarget,
} from '@/components/SkillFileDeleteDialog';
import {
  SkillFileRenameDialog,
  type SkillFileRenameTarget,
} from '@/components/SkillFileRenameDialog';
import { SkillForkDialog, type SkillForkTarget } from '@/components/SkillForkDialog';
import {
  SKILL_INSTALL_MENU_WIDTH,
  SkillInstallMenuItems,
  useSkillHostToggles,
} from '@/components/SkillInstallMenu';
import { SkillRenameDialog } from '@/components/SkillRenameDialog';
import { SkillScopeMoveDialog, type SkillScopeMoveTarget } from '@/components/SkillScopeMoveDialog';
import {
  SkillMenuGroup,
  SkillMenuItem,
  type SkillMenuKind,
  SkillMenuSeparator,
  SkillMenuSub,
  SkillMenuSubContent,
  SkillMenuSubTrigger,
} from '@/components/skill-menu-primitives';
import { useOpenSkill } from '@/hooks/use-open-skill';
import { revealInFileManagerLabel } from '@/lib/reveal-label';
import { scheduleClipboardWrite } from '@/lib/share/clipboard-adapter';
import { skillDir, useSkillScopeLabels } from '@/lib/skill-scope';
import { convertSkillLocation, duplicateSkill, installSkill } from '@/lib/skills-api';
import { useWorkspace } from '@/lib/use-workspace';

/**
 * The shared per-skill action surface, reused by every place that acts on a
 * skill (the file-sidebar Skills section and the skill editor toolbar). One
 * owner of the install/uninstall side effects + the delete/history dialogs keeps
 * those surfaces behaviorally identical instead of re-deriving the flow.
 *
 * `useSkillActions` owns the stateful pieces (install-in-flight name, the
 * delete + history dialog targets) and returns the handlers plus a `dialogs`
 * node the caller mounts once. `onEdit` stays per-surface and is passed in by
 * the caller.
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
    opts?: { linkMode?: boolean },
  ) => Promise<Awaited<ReturnType<typeof installSkill>>>;
  /**
   * Convert locations of a skill between copy and symlink, one after another,
   * holding `installingName` for the whole run so every surface shows it working.
   */
  convertLocations: (
    skill: SkillsListEntry,
    targets: readonly { target: string; mode: 'copy' | 'link' }[],
  ) => Promise<void>;
  /**
   * Run one location write (source move, custom placement, un-placement) under
   * the same in-flight name as install, so every surface reads "Working" for
   * its duration.
   *
   * A write fired outside this reads as settled the instant it leaves — and a
   * source move is not atomic on disk: for the moment between the real folder
   * relocating and a symlink taking its place, the OLD source is a plain
   * directory. A watcher refetch landing in that window paints it as a COPY,
   * which then vanishes on the next one. The write is done when the list
   * reflects it, not when the request returns.
   */
  runLocationWrite: <T>(skill: SkillsListEntry, run: () => Promise<T>) => Promise<T>;
  /** Duplicate a skill into `<name>-copy` (existing names avoid collisions). */
  duplicate: (skill: SkillsListEntry, existingNames: ReadonlySet<string>) => Promise<void>;
  /** Open the (reused) delete-confirm dialog for a skill. */
  requestDelete: (skill: SkillsListEntry) => void;
  /** Open the rename dialog for a skill; `existingNames` drives its collision check. */
  requestRename: (skill: SkillsListEntry, existingNames: ReadonlySet<string>) => void;
  /** Open the confirm dialog to move a skill to the other scope (project ↔ global). */
  requestScopeMove: (skill: SkillsListEntry, toScope: SkillScope) => void;
  /** Open the bundle-FILE rename/move dialog (§8.9). */
  requestFileRename: (skill: SkillsListEntry, filePath: string) => void;
  /** Open the delete-confirm dialog for ONE bundle file. */
  requestFileDelete: (skill: SkillsListEntry, filePath: string) => void;
  /** Open the new-bundle-file dialog (optionally seeded with a dir prefix). */
  requestFileCreate: (skill: SkillsListEntry, prefix?: string) => void;
  /** Open the fork-resolution dialog for a conflicted editor copy. */
  requestForkResolve: (skill: SkillsListEntry, editor: string) => void;
  /** Mount once per surface — the dialogs these actions drive. */
  dialogs: ReactNode;
}

export function useSkillActions(): SkillActions {
  const { t } = useLingui();
  const openSkill = useOpenSkill();
  const [deleteTarget, setDeleteTarget] = useState<SkillsListEntry | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    skill: SkillsListEntry;
    existingNames: ReadonlySet<string>;
  } | null>(null);
  const [scopeMoveTarget, setScopeMoveTarget] = useState<SkillScopeMoveTarget | null>(null);
  const [fileRenameTarget, setFileRenameTarget] = useState<SkillFileRenameTarget | null>(null);
  const [fileDeleteTarget, setFileDeleteTarget] = useState<SkillFileDeleteTarget | null>(null);
  const [fileCreateTarget, setFileCreateTarget] = useState<SkillFileCreateTarget | null>(null);
  const [forkTarget, setForkTarget] = useState<SkillForkTarget | null>(null);
  const [installingName, setInstallingName] = useState<string | null>(null);

  async function install(
    skill: SkillsListEntry,
    targets?: readonly string[],
    opts?: { linkMode?: boolean },
  ) {
    setInstallingName(skill.name);
    const result = await installSkill({
      scope: skill.scope,
      name: skill.name,
      ...(targets ? { targets: [...targets] } : {}),
      ...(opts?.linkMode !== undefined ? { linkMode: opts.linkMode } : {}),
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
      // Empty-description nudge: install succeeded — surface the
      // advisory only when actually adding, never on a no-op/uninstall click.
      const noDescriptionWarning = messageFor('no-description');
      if (noDescriptionWarning) toast.warning(noDescriptionWarning);
    }

    if (result.hosts.length === 0) {
      // Not a draft: the redesign retired that state. A skill with no extra
      // locations still lives — and still loads — at its source folder.
      toast.success(
        t`Removed "${skill.name}" from every other location — its source folder still loads`,
      );
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

  /**
   * Convert one or more of a skill's locations between copy and symlink.
   *
   * Sequential, and routed through the same in-flight name as install so every
   * surface showing this skill reads "Working" for the whole run. Firing the
   * conversions in parallel instead left the pill idle while folders were being
   * rewritten underneath it, so the list could refetch mid-run and render a
   * half-converted state as if it were settled.
   */
  async function convertLocations(
    skill: SkillsListEntry,
    targets: readonly { target: string; mode: 'copy' | 'link' }[],
  ) {
    if (targets.length === 0) return;
    setInstallingName(skill.name);
    // No try/finally: `convertSkillLocation` reports failures in its result
    // rather than throwing, so a single exit point clears the flag (and the
    // React Compiler cannot lower a try without a catch).
    for (const { target, mode } of targets) {
      const result = await convertSkillLocation({
        scope: skill.scope,
        name: skill.name,
        target,
        mode,
      });
      if (!result.ok) {
        toast.error(result.error);
        break;
      }
    }
    setInstallingName(null);
  }

  async function runLocationWrite<T>(skill: SkillsListEntry, run: () => Promise<T>): Promise<T> {
    setInstallingName(skill.name);
    // Single exit point, no try/finally: these writers report failures in their
    // result rather than throwing (and the React Compiler cannot lower a try
    // without a catch). The caller keeps its own error reporting.
    const result = await run();
    setInstallingName(null);
    return result;
  }

  async function duplicate(skill: SkillsListEntry, existingNames: ReadonlySet<string>) {
    const result = await duplicateSkill({ scope: skill.scope, name: skill.name, existingNames });
    if (!result.ok) {
      toast.error(t`Couldn't duplicate "${skill.name}": ${result.error}`);
      return;
    }
    toast.success(t`Duplicated to "${result.name}"`);
    // Open the copy — the point of duplicating is to edit it. The copy lands at
    // the source's scope; `useOpenSkill` is the robust open (a fresh project skill
    // would otherwise strand on the read-only asset viewer via the hash path).
    openSkill(skill.scope, result.name);
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
      <SkillScopeMoveDialog
        target={scopeMoveTarget}
        onOpenChange={(open) => {
          if (!open) setScopeMoveTarget(null);
        }}
      />
      <SkillFileRenameDialog
        target={fileRenameTarget}
        onOpenChange={(open) => {
          if (!open) setFileRenameTarget(null);
        }}
      />
      <SkillFileDeleteDialog
        target={fileDeleteTarget}
        onOpenChange={(open) => {
          if (!open) setFileDeleteTarget(null);
        }}
      />
      <SkillFileCreateDialog
        target={fileCreateTarget}
        onOpenChange={(open) => {
          if (!open) setFileCreateTarget(null);
        }}
      />
      <SkillForkDialog
        target={forkTarget}
        onOpenChange={(open) => {
          if (!open) setForkTarget(null);
        }}
      />
    </>
  );

  return {
    installingName,
    install,
    convertLocations,
    runLocationWrite,
    duplicate,
    requestDelete: setDeleteTarget,
    requestRename: (skill, existingNames) => setRenameTarget({ skill, existingNames }),
    requestScopeMove: (skill, toScope) =>
      setScopeMoveTarget({ scope: skill.scope, name: skill.name, toScope }),
    requestFileRename: (skill, filePath) => setFileRenameTarget({ skill, filePath }),
    requestFileDelete: (skill, filePath) => setFileDeleteTarget({ skill, filePath }),
    requestFileCreate: (skill, prefix) =>
      setFileCreateTarget(prefix !== undefined ? { skill, prefix } : { skill }),
    requestForkResolve: (skill, editor) => setForkTarget({ skill, editor }),
    dialogs,
  };
}

const EMPTY_NAME_SET: ReadonlySet<string> = new Set();

/**
 * Reveal one on-disk skill path in the OS file manager. Renders nothing off
 * desktop or when the path is unknown. Shared by every skills menu so the row
 * kinds cannot disagree about when reveal is offered, and labelled through the
 * same per-platform helper the file tree and editor tabs use — desktop ships on
 * Windows and Linux, where "Reveal in Finder" is wrong.
 */
export function SkillRevealMenuItem({
  absolutePath,
  menuKind = 'dropdown',
}: {
  absolutePath: string | undefined;
  menuKind?: SkillMenuKind;
}) {
  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  if (!bridge || !absolutePath) return null;
  return (
    <SkillMenuItem
      menuKind={menuKind}
      onSelect={() => void bridge.shell.showItemInFolder(absolutePath)}
    >
      <FolderOpen aria-hidden />
      {revealInFileManagerLabel(bridge.platform)}
    </SkillMenuItem>
  );
}

/**
 * File actions shared by bundle-file rows in the Skills sidebar and editor tabs.
 * Paths resolve from the skill directory rather than from its SKILL.md entry.
 */
export function SkillFileContextMenuItems({
  skill,
  filePath,
  actions,
  menuKind = 'dropdown',
}: {
  skill: SkillsListEntry;
  filePath: string;
  actions: SkillActions;
  menuKind?: SkillMenuKind;
}) {
  const { t } = useLingui();
  const absoluteFile = skill.absolutePath
    ? `${skillDir(skill.absolutePath)}/${filePath}`
    : undefined;
  const relativeFile = `${skillDir(skill.path)}/${filePath}`;

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
      <SkillMenuGroup menuKind={menuKind}>
        <SkillMenuItem
          menuKind={menuKind}
          onSelect={() => actions.requestFileRename(skill, filePath)}
        >
          <PencilLine aria-hidden />
          <Trans>Rename</Trans>
        </SkillMenuItem>
        <SkillRevealMenuItem absolutePath={absoluteFile} menuKind={menuKind} />
        <SkillMenuSub menuKind={menuKind}>
          <SkillMenuSubTrigger menuKind={menuKind}>
            <Copy aria-hidden />
            <Trans>Copy Path</Trans>
          </SkillMenuSubTrigger>
          <SkillMenuSubContent menuKind={menuKind}>
            <SkillMenuGroup menuKind={menuKind}>
              {absoluteFile ? (
                <SkillMenuItem menuKind={menuKind} onSelect={() => void copy(absoluteFile)}>
                  <Trans>Full Path</Trans>
                </SkillMenuItem>
              ) : null}
              <SkillMenuItem menuKind={menuKind} onSelect={() => void copy(relativeFile)}>
                <Trans>Relative Path</Trans>
              </SkillMenuItem>
            </SkillMenuGroup>
          </SkillMenuSubContent>
        </SkillMenuSub>
      </SkillMenuGroup>
      <SkillMenuSeparator menuKind={menuKind} />
      <SkillMenuGroup menuKind={menuKind}>
        <SkillMenuItem
          menuKind={menuKind}
          variant="destructive"
          onSelect={() => actions.requestFileDelete(skill, filePath)}
        >
          <Trash2 aria-hidden />
          <Trans>Delete</Trans>
        </SkillMenuItem>
      </SkillMenuGroup>
    </>
  );
}

/**
 * The full per-skill action menu shared by Skills sidebar rows and editor tabs.
 * Callers select the matching Radix primitive family while every mutation still
 * routes through `useSkillActions`, keeping dialogs and confirmation behavior identical.
 */
export function SkillContextMenuItems({
  skill,
  actions,
  existingNames,
  menuKind = 'dropdown',
}: {
  skill: SkillsListEntry;
  actions: SkillActions;
  existingNames: ReadonlySet<string>;
  menuKind?: SkillMenuKind;
}) {
  const workspace = useWorkspace();
  const installStates = useInstalledAgents().states;
  const { dispatch } = useHandoffDispatch();
  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  const input = buildSkillHandoffInput({
    skillName: skill.name,
    scope: skill.scope,
    workspace,
  });

  return (
    <SkillTargetMenuItems
      actions={actions}
      existingNames={existingNames}
      menuKind={menuKind}
      skill={skill}
      openWithAi={
        menuKind === 'context' ? (
          <OpenInAgentEmptySpaceSubmenu
            input={input}
            installStates={installStates}
            dispatch={dispatch}
          />
        ) : (
          <OpenInAgentContextSubmenu
            input={input}
            installStates={installStates}
            isElectronHost={bridge != null}
            dispatch={dispatch}
          />
        )
      }
    />
  );
}

function SkillTargetMenuItems({
  actions,
  existingNames,
  menuKind,
  openWithAi,
  skill,
}: {
  actions: SkillActions;
  existingNames: ReadonlySet<string>;
  menuKind: SkillMenuKind;
  openWithAi: ReactNode;
  skill: SkillsListEntry;
}) {
  const { t } = useLingui();
  const scopeLabels = useSkillScopeLabels();
  const hostToggles = useSkillHostToggles(skill, actions);
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
      <SkillMenuGroup menuKind={menuKind}>
        <SkillRevealMenuItem absolutePath={absolutePath} menuKind={menuKind} />
        {openWithAi}
        <SkillMenuSub menuKind={menuKind}>
          <SkillMenuSubTrigger menuKind={menuKind}>
            <Copy aria-hidden />
            <Trans>Copy Path</Trans>
          </SkillMenuSubTrigger>
          <SkillMenuSubContent menuKind={menuKind}>
            <SkillMenuGroup menuKind={menuKind}>
              {absolutePath ? (
                <SkillMenuItem menuKind={menuKind} onSelect={() => void copy(absolutePath)}>
                  <Trans>Full Path</Trans>
                </SkillMenuItem>
              ) : null}
              <SkillMenuItem menuKind={menuKind} onSelect={() => void copy(skill.path)}>
                <Trans>Relative Path</Trans>
              </SkillMenuItem>
            </SkillMenuGroup>
          </SkillMenuSubContent>
        </SkillMenuSub>
      </SkillMenuGroup>
      <SkillMenuSeparator menuKind={menuKind} />
      <SkillMenuGroup menuKind={menuKind}>
        <SkillMenuItem
          menuKind={menuKind}
          onSelect={() => void actions.duplicate(skill, existingNames)}
        >
          <CopyPlus aria-hidden />
          <Trans>Duplicate</Trans>
        </SkillMenuItem>
        <SkillMenuItem
          menuKind={menuKind}
          onSelect={() => actions.requestRename(skill, existingNames)}
        >
          <PencilLine aria-hidden />
          <Trans>Rename</Trans>
        </SkillMenuItem>
        <SkillMenuItem menuKind={menuKind} onSelect={() => actions.requestFileCreate(skill)}>
          <FilePlus aria-hidden />
          <Trans>New file</Trans>
        </SkillMenuItem>
        <SkillMenuSub menuKind={menuKind}>
          <SkillMenuSubTrigger menuKind={menuKind}>
            <DownloadCloud aria-hidden />
            <Trans>Install</Trans>
          </SkillMenuSubTrigger>
          <SkillMenuSubContent menuKind={menuKind} className={SKILL_INSTALL_MENU_WIDTH}>
            <SkillMenuGroup menuKind={menuKind}>
              <SkillInstallMenuItems
                toggles={hostToggles}
                skill={skill}
                menuKind={menuKind}
                onResolveFork={(editor) => actions.requestForkResolve(skill, editor)}
              />
            </SkillMenuGroup>
          </SkillMenuSubContent>
        </SkillMenuSub>
        <SkillMenuItem
          menuKind={menuKind}
          onSelect={() =>
            actions.requestScopeMove(skill, skill.scope === 'project' ? 'global' : 'project')
          }
        >
          <ArrowLeftRight aria-hidden />
          {skill.scope === 'project' ? (
            <Trans>Move to {scopeLabels.global}</Trans>
          ) : (
            <Trans>Move to {scopeLabels.project}</Trans>
          )}
        </SkillMenuItem>
      </SkillMenuGroup>
      <SkillMenuSeparator menuKind={menuKind} />
      <SkillMenuGroup menuKind={menuKind}>
        <SkillMenuItem
          menuKind={menuKind}
          variant="destructive"
          onSelect={() => actions.requestDelete(skill)}
        >
          <Trash2 aria-hidden />
          <Trans>Delete</Trans>
        </SkillMenuItem>
      </SkillMenuGroup>
    </>
  );
}
