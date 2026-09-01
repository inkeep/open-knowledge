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
import { lazy, type ReactNode, Suspense, useState } from 'react';
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
import type { SkillForkTarget } from '@/components/SkillForkDialog';
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
  SkillMenuLabel,
  SkillMenuSeparator,
  SkillMenuSub,
  SkillMenuSubContent,
  SkillMenuSubTrigger,
} from '@/components/skill-menu-primitives';
import { useOpenSkill } from '@/hooks/use-open-skill';
import { beginSkillWrite, endSkillWrite } from '@/lib/documents-events';
import { revealInFileManagerLabel } from '@/lib/platform-labels';
import { scheduleClipboardWrite } from '@/lib/share/clipboard-adapter';
import { skillDir, useSkillScopeLabels } from '@/lib/skill-scope';
import {
  convertSkillLocation,
  duplicateSkill,
  installSkill,
  reimportSkillsBulk,
} from '@/lib/skills-api';
import { useWorkspace } from '@/lib/use-workspace';

const LazySkillForkDialog = lazy(async () => {
  const mod = await import('@/components/SkillForkDialog');
  return { default: mod.SkillForkDialog };
});

export interface SkillActions {
  installingName: string | null;
  install: (
    skill: SkillsListEntry,
    targets?: readonly string[],
    opts?: { linkMode?: boolean },
  ) => Promise<Awaited<ReturnType<typeof installSkill>>>;
  convertLocations: (
    skill: SkillsListEntry,
    targets: readonly { target: string; mode: 'copy' | 'link' }[],
  ) => Promise<void>;
  runLocationWrite: <T>(skill: SkillsListEntry, run: () => Promise<T>) => Promise<T>;
  duplicate: (skill: SkillsListEntry, existingNames: ReadonlySet<string>) => Promise<void>;
  updateAllFromSource: (input: {
    scope: SkillScope;
    names: readonly string[];
    sourceLabel: string;
  }) => Promise<void>;
  requestDelete: (skill: SkillsListEntry) => void;
  requestRename: (skill: SkillsListEntry, existingNames: ReadonlySet<string>) => void;
  requestScopeMove: (skill: SkillsListEntry, toScope: SkillScope) => void;
  requestFileRename: (skill: SkillsListEntry, filePath: string) => void;
  requestFileDelete: (skill: SkillsListEntry, filePath: string) => void;
  requestFileCreate: (skill: SkillsListEntry, prefix?: string) => void;
  requestForkResolve: (skill: SkillsListEntry, editor: string) => void;
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
    beginSkillWrite(skill.scope, skill.name);
    const result = await installSkill({
      scope: skill.scope,
      name: skill.name,
      ...(targets ? { targets: [...targets] } : {}),
      ...(opts?.linkMode !== undefined ? { linkMode: opts.linkMode } : {}),
    });
    endSkillWrite(skill.scope, skill.name);
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
      const noDescriptionWarning = messageFor('no-description');
      if (noDescriptionWarning) toast.warning(noDescriptionWarning);
    }

    if (result.hosts.length === 0) {
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

  async function convertLocations(
    skill: SkillsListEntry,
    targets: readonly { target: string; mode: 'copy' | 'link' }[],
  ) {
    if (targets.length === 0) return;
    setInstallingName(skill.name);
    beginSkillWrite(skill.scope, skill.name);
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
    endSkillWrite(skill.scope, skill.name);
    setInstallingName(null);
  }

  async function runLocationWrite<T>(skill: SkillsListEntry, run: () => Promise<T>): Promise<T> {
    setInstallingName(skill.name);
    beginSkillWrite(skill.scope, skill.name);
    const result = await run();
    endSkillWrite(skill.scope, skill.name);
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
    openSkill(skill.scope, result.name);
  }

  async function updateAllFromSource(input: {
    scope: SkillScope;
    names: readonly string[];
    sourceLabel: string;
  }) {
    const names = [...input.names];
    if (names.length === 0) return;
    for (const name of names) beginSkillWrite(input.scope, name);
    setInstallingName(names[0] ?? null);
    const result = await reimportSkillsBulk({ scope: input.scope, names });
    for (const name of names) endSkillWrite(input.scope, name);
    setInstallingName(null);
    if (!result.ok) {
      toast.error(t`Couldn't update from ${input.sourceLabel}: ${result.error}`);
      return;
    }
    const failures = result.results.filter(
      (r) => r.status === 'failed' || r.status === 'not-found',
    );
    const source = input.sourceLabel;
    const updated = result.updated;
    const upToDate = result.upToDate;
    if (failures.length > 0) {
      const detail = failures
        .map((r) => (r.error ? `${r.requested} (${r.error})` : r.requested))
        .join(', ');
      const failed = failures.length;
      toast.warning(
        t`${source}: ${updated} updated, ${upToDate} already up to date, ${failed} failed — ${detail}`,
      );
      return;
    }
    toast.success(
      updated > 0
        ? t`${source}: ${updated} updated, ${upToDate} already up to date`
        : t`Everything from ${source} is already up to date`,
    );
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
      {forkTarget ? (
        <Suspense fallback={null}>
          <LazySkillForkDialog
            target={forkTarget}
            onOpenChange={(open) => {
              if (!open) setForkTarget(null);
            }}
          />
        </Suspense>
      ) : null}
    </>
  );

  return {
    installingName,
    install,
    convertLocations,
    runLocationWrite,
    duplicate,
    updateAllFromSource,
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

export function SkillManagedContextMenuItems({
  skill,
  actions,
  beforeDelete,
}: {
  skill: SkillsListEntry;
  actions: SkillActions;
  beforeDelete?: ReactNode;
}) {
  const { t } = useLingui();
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
      <SkillMenuGroup menuKind="dropdown">
        <SkillRevealMenuItem absolutePath={absolutePath} />
        <SkillMenuSub menuKind="dropdown">
          <SkillMenuSubTrigger menuKind="dropdown">
            <Copy aria-hidden />
            <Trans>Copy Path</Trans>
          </SkillMenuSubTrigger>
          <SkillMenuSubContent menuKind="dropdown">
            <SkillMenuGroup menuKind="dropdown">
              {absolutePath ? (
                <SkillMenuItem menuKind="dropdown" onSelect={() => void copy(absolutePath)}>
                  <Trans>Full Path</Trans>
                </SkillMenuItem>
              ) : null}
              <SkillMenuItem menuKind="dropdown" onSelect={() => void copy(skill.path)}>
                <Trans>Relative Path</Trans>
              </SkillMenuItem>
            </SkillMenuGroup>
          </SkillMenuSubContent>
        </SkillMenuSub>
      </SkillMenuGroup>
      <SkillMenuSeparator menuKind="dropdown" />
      <SkillMenuGroup menuKind="dropdown">
        <SkillMenuSub menuKind="dropdown">
          <SkillMenuSubTrigger menuKind="dropdown">
            <DownloadCloud aria-hidden />
            <Trans>Install</Trans>
          </SkillMenuSubTrigger>
          <SkillMenuSubContent menuKind="dropdown" className={SKILL_INSTALL_MENU_WIDTH}>
            <SkillMenuGroup menuKind="dropdown">
              <SkillInstallMenuItems
                toggles={hostToggles}
                skill={skill}
                menuKind="dropdown"
                onResolveFork={(editor) => actions.requestForkResolve(skill, editor)}
              />
            </SkillMenuGroup>
          </SkillMenuSubContent>
        </SkillMenuSub>
      </SkillMenuGroup>
      {beforeDelete}
      <SkillMenuSeparator menuKind="dropdown" />
      <SkillMenuGroup menuKind="dropdown">
        <SkillMenuItem
          menuKind="dropdown"
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
  const nonDefaultBundle = skill.hostQualifier !== undefined;

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
      {nonDefaultBundle ? (
        <SkillMenuGroup menuKind={menuKind}>
          <SkillMenuLabel
            menuKind={menuKind}
            className="max-w-56 whitespace-normal font-normal text-muted-foreground text-xs"
          >
            <Trans>
              A second skill with this name — rename it (or delete one) to manage it fully.
            </Trans>
          </SkillMenuLabel>
        </SkillMenuGroup>
      ) : (
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
      )}
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
