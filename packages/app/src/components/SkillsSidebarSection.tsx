import type { SkillsListEntry } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  ChevronRight,
  FileCode,
  FileText,
  Hexagon,
  MoreHorizontal,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { NewSkillDialog } from '@/components/NewSkillDialog';
import { SkillStateBadge } from '@/components/SkillStateBadge';
import {
  type SkillActions,
  SkillContextMenuItems,
  useSkillActions,
} from '@/components/skill-actions';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@/components/ui/sidebar';
import { useDocumentContext } from '@/editor/DocumentContext';
import { useSkills } from '@/hooks/use-skills';
import { hashFromDocName, hashFromSkillFile, replaceHashWithoutNavigation } from '@/lib/doc-hash';
import { subscribeToSkillsChanged } from '@/lib/documents-events';
import {
  projectSkillContentDocName,
  projectSkillFilePath,
  skillLiveDocName,
} from '@/lib/managed-artifact-doc-name';
import { openManagedArtifactTab } from '@/lib/open-managed-artifact-tab';
import {
  SKILL_SCOPE_ORDER,
  skillDisplayName,
  skillNameSetsByScope,
  useSkillScopeLabels,
} from '@/lib/skill-scope';
import {
  getSkillBundledFiles,
  getSkillsManagement,
  type SkillBundledFile,
  setSkillsManagement,
} from '@/lib/skills-api';

/**
 * "Skills" section of the file sidebar — a skill is a FOLDER, browsable like the
 * file tree above it: expand a skill to see everything it ships nested inside
 * (`SKILL.md` + `scripts/` + `reference/` + assets). `SKILL.md` opens the skill
 * editor (the same pipeline documents use); any other file reveals its text
 * read-only in place (scripts are shown as text, never executed). Grouped by
 * scope; built-in skills are intentionally not listed. Settings → Skills remains
 * for config (which editors to install into).
 */
export function SkillsSidebarSection() {
  const { t } = useLingui();
  const state = useSkills();
  const { activeDocName } = useDocumentContext();
  const [newSkillOpen, setNewSkillOpen] = useState(false);
  // Same install/uninstall/delete/history flow + dialogs the Settings list uses.
  const actions = useSkillActions();

  const skills = state.status === 'ready' ? state.data : [];
  const nameSets = skillNameSetsByScope(skills);
  const scopeLabel = useSkillScopeLabels();

  // Per-scope accordion open-state. Closed by default, but a scope auto-opens
  // when it holds the active skill — so a skill moved/opened INTO a scope is
  // revealed instead of vanishing behind a collapsed header (the "moved but the
  // dock didn't update" report). User intent (an explicit toggle) wins via the
  // `?? autoOpen` fallback: once toggled, that scope stops auto-opening.
  const [openScopes, setOpenScopes] = useState<Record<string, boolean>>({});

  return (
    // Collapsible like the Files tree: clicking the "Skills" header toggles the
    // whole list. The `+` (New skill) stays an absolutely-positioned group action
    // outside the trigger so it doesn't toggle the section.
    <Collapsible className="group/skills shrink-0">
      {/* `px-0` overrides the base `p-2`'s horizontal inset so the "Skills"
          header lands at the same 8px baseline as the Files section's project
          header (both rely solely on their own SidebarGroupLabel `px-2`) —
          see the matching override on the Files SidebarGroup in
          FileSidebar.tsx. */}
      <SidebarGroup className="px-0">
        <SidebarGroupLabel asChild>
          <CollapsibleTrigger className="flex w-full items-center gap-1.5">
            <Hexagon className="size-3.5 shrink-0" />
            <Trans>Skills</Trans>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/skills:rotate-90" />
          </CollapsibleTrigger>
        </SidebarGroupLabel>
        <SidebarGroupAction title={t`New skill`} onClick={() => setNewSkillOpen(true)}>
          <Plus />
          <span className="sr-only">
            <Trans>New skill</Trans>
          </span>
        </SidebarGroupAction>
        <CollapsibleContent>
          <SidebarGroupContent>
            <SkillImportPrompt />
            {skills.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                <Trans>No skills yet.</Trans>
              </p>
            ) : (
              SKILL_SCOPE_ORDER.filter((scope) => skills.some((s) => s.scope === scope)).map(
                (scope) => {
                  // Auto-open the scope that holds the active skill. This wins
                  // over a stale manual toggle: a skill moved/opened INTO a scope
                  // must be revealed, not stay hidden behind a header the user
                  // happened to collapse earlier (the "moved a skill across
                  // scopes and it vanished from the tree" report). Manual toggles
                  // still govern the scopes that don't hold the active skill.
                  const holdsActive = skills.some(
                    (s) => s.scope === scope && skillLiveDocName(s.scope, s.name) === activeDocName,
                  );
                  return (
                    // Each scope (Global / Project) is its own accordion, closed
                    // by default — expanding Skills reveals the two scope headers,
                    // and the user opens the one they want.
                    <Collapsible
                      key={scope}
                      className="group/scope"
                      open={holdsActive || (openScopes[scope] ?? false)}
                      onOpenChange={(open) => setOpenScopes((prev) => ({ ...prev, [scope]: open }))}
                    >
                      <CollapsibleTrigger className="flex w-full items-center gap-1 px-2 pt-1 pb-0.5 text-[11px] text-muted-foreground/70 hover:text-muted-foreground">
                        <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]/scope:rotate-90" />
                        <span className="truncate">{scopeLabel[scope]}</span>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        {/* Indent the scope's skills one step under its header so
                          the tree reads Skills > scope > skill > file. */}
                        <SidebarMenu className="pl-2">
                          {skills
                            .filter((s) => s.scope === scope)
                            .map((skill) => (
                              <SkillFolderItem
                                key={`${skill.scope}::${skill.name}`}
                                skill={skill}
                                activeDocName={activeDocName}
                                actions={actions}
                                existingNames={nameSets[skill.scope]}
                              />
                            ))}
                        </SidebarMenu>
                      </CollapsibleContent>
                    </Collapsible>
                  );
                },
              )
            )}
          </SidebarGroupContent>
        </CollapsibleContent>
        {actions.dialogs}
        <NewSkillDialog
          defaultScope="project"
          open={newSkillOpen}
          onOpenChange={setNewSkillOpen}
          onCreated={({ scope, name }) => openManagedArtifactTab(skillLiveDocName(scope, name))}
        />
      </SidebarGroup>
    </Collapsible>
  );
}

/**
 * One skill rendered as an expandable folder. Collapsed it reads as a row;
 * expanded it lazy-loads the skill's bundled files and shows them as a nested
 * tree. The skill's own `SKILL.md` is a synthetic top child that opens the
 * editor; everything else is browsable file content.
 */
function SkillFolderItem({
  skill,
  activeDocName,
  actions,
  existingNames,
}: {
  skill: SkillsListEntry;
  activeDocName: string | null;
  actions: SkillActions;
  existingNames: ReadonlySet<string>;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const active = activeDocName === skillLiveDocName(skill.scope, skill.name);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/skill">
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton
            size="sm"
            isActive={active}
            className="h-6 text-[11px]"
            // Right-click opens the same actions menu as the hover 3-dot button,
            // matching the file tree's right-click affordance. preventDefault
            // suppresses the native browser context menu so only the dropdown opens.
            onContextMenu={(e) => {
              e.preventDefault();
              setMenuOpen(true);
            }}
          >
            <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/skill:rotate-90" />
            <Hexagon className="size-3 shrink-0 text-muted-foreground" />
            {/* Display the prefix-stripped name (`open-knowledge-pack-X` → `X`) so
                even the longest shipped skill fits a normal width; the badge is
                shrink-0 so it shows fully ("Installed"/"Draft"). `title` keeps the
                full identity on hover. */}
            <span className="min-w-0 flex-1 truncate" title={skill.name}>
              {skillDisplayName(skill.name)}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {/* Starter-pack update marker: a newer bundled version exists. The
                  adopt action lives in the row's 3-dot menu (opt-in). */}
              {skill.updateAvailable ? (
                <span
                  title={t`Update available${skill.bundledVersion ? ` (${skill.bundledVersion})` : ''}`}
                  className="flex items-center"
                >
                  <RefreshCw className="size-3 text-primary" aria-label={t`Update available`} />
                </span>
              ) : null}
              <SkillStateBadge installed={skill.installed} subtle className="shrink-0" />
            </span>
          </SidebarMenuButton>
        </CollapsibleTrigger>
        {/* The same context menu a file row gets (Reveal / Open with AI / Terminal
            / Copy Path / Duplicate / Rename / Delete), with Install/Uninstall in
            place of Hide — reuses SkillContextMenuItems. */}
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuAction showOnHover aria-label={t`Actions for ${skill.name}`}>
              <MoreHorizontal />
            </SidebarMenuAction>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start" className="min-w-52">
            <SkillContextMenuItems skill={skill} actions={actions} existingNames={existingNames} />
          </DropdownMenuContent>
        </DropdownMenu>
        <CollapsibleContent>
          {open ? <SkillFolderContents skill={skill} /> : null}
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

/** A skill's nested file tree node, built from the flat `scripts/run.py` paths. */
interface FileNode {
  name: string;
  path: string;
  /** Present for folders. */
  children?: FileNode[];
  /** Present for files — inline text, or `null` for binary/oversize. */
  text?: string | null;
}

function buildFileTree(files: readonly SkillBundledFile[]): FileNode[] {
  const root: FileNode[] = [];
  for (const file of files) {
    const segments = file.path.split('/');
    let level = root;
    segments.forEach((segment, i) => {
      const isLeaf = i === segments.length - 1;
      let node = level.find((n) => n.name === segment);
      if (!node) {
        node = isLeaf
          ? { name: segment, path: file.path, text: file.text }
          : { name: segment, path: segments.slice(0, i + 1).join('/'), children: [] };
        level.push(node);
      }
      if (!isLeaf && node.children) level = node.children;
    });
  }
  sortTree(root);
  return root;
}

/** Folders first, then files; alphabetical within each. */
function sortTree(nodes: FileNode[]): void {
  nodes.sort((a, b) => {
    const aFolder = a.children ? 0 : 1;
    const bFolder = b.children ? 0 : 1;
    if (aFolder !== bFolder) return aFolder - bFolder;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) if (node.children) sortTree(node.children);
}

function SkillFolderContents({ skill }: { skill: SkillsListEntry }) {
  const { t } = useLingui();
  const [files, setFiles] = useState<SkillBundledFile[] | null>(null);
  // True once a bundle-files fetch failed. Without a terminal state, a failed
  // fetch leaves `files === null` and the row shows "Loading" forever.
  const [loadFailed, setLoadFailed] = useState(false);
  const { openTarget } = useDocumentContext();

  // Open a project-skill content doc as a PERSISTENT tab. `append` (not
  // `replace-active`) so opening a second skill keeps the first open — skills are
  // worked on side-by-side, unlike the file tree's single preview tab. `openTarget`
  // still activates the newly-opened tab; `replaceHashWithoutNavigation` syncs the
  // hash (bare `openDocument` bypasses the hash and a later nav effect steals focus).
  function openProjectDoc(docName: string) {
    openTarget({ kind: 'doc', target: docName, docName }, { tabBehavior: 'append' });
    replaceHashWithoutNavigation(hashFromDocName(docName));
  }

  // Open a skill file. A PROJECT skill's `.md`/`.mdx` reference is a real
  // content doc, so it opens EDITABLE in the normal editor (same as the file
  // tree above). Everything else — global-scope bundle files of any type, and
  // scripts of any scope — opens in a read-only viewer backed by the
  // scope-aware `/api/skill-file` read. The content-dir asset server can't see
  // a global skill (its files live under `~/.ok/skills/`, outside the project),
  // so routing those through the asset path 404'd; the skill-file target reads
  // the right store per scope.
  function openFile(filePath: string) {
    const dot = filePath.lastIndexOf('.');
    const ext = dot >= 0 ? filePath.slice(dot + 1).toLowerCase() : '';
    if (skill.scope === 'project' && (ext === 'md' || ext === 'mdx')) {
      openProjectDoc(projectSkillFilePath(skill.name, filePath.replace(/\.mdx?$/i, '')));
      return;
    }
    const target = {
      kind: 'skill-file' as const,
      target: `${skill.scope}/${skill.name}/${filePath}`,
      scope: skill.scope,
      name: skill.name,
      path: filePath,
    };
    openTarget(target, { tabBehavior: 'replace-active' });
    replaceHashWithoutNavigation(
      hashFromSkillFile({ scope: skill.scope, name: skill.name, path: filePath }),
    );
  }

  useEffect(() => {
    let active = true;
    const load = () => {
      void getSkillBundledFiles(skill.scope, skill.name).then((r) => {
        if (!active) return;
        if (r.ok) {
          setFiles(r.files);
          setLoadFailed(false);
        } else {
          // Terminal state on failure: clear the spinner (empty list) and flag
          // the error so the row doesn't hang on "Loading" indefinitely.
          setFiles([]);
          setLoadFailed(true);
        }
      });
    };
    load();
    const unsub = subscribeToSkillsChanged(load);
    return () => {
      active = false;
      unsub();
    };
  }, [skill.scope, skill.name]);

  const tree = files ? buildFileTree(files) : [];

  return (
    <SidebarMenuSub className="mr-0 pr-0">
      {/* SKILL.md: project skills open the content doc (editable in the normal
          editor); global skills open via the dedicated managed-artifact route. */}
      <SidebarMenuSubItem>
        <SidebarMenuSubButton
          size="sm"
          onClick={() =>
            skill.scope === 'project'
              ? openProjectDoc(projectSkillContentDocName(skill.name))
              : openManagedArtifactTab(skillLiveDocName(skill.scope, skill.name))
          }
          className="text-[11px]"
        >
          <FileText className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">SKILL.md</span>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
      {files === null ? (
        <SidebarMenuSubItem>
          <span className="px-2 py-0.5 text-[11px] text-muted-foreground/70">
            <Trans>Loading</Trans>
          </span>
        </SidebarMenuSubItem>
      ) : loadFailed ? (
        <SidebarMenuSubItem>
          <span
            className="px-2 py-0.5 text-[11px] text-muted-foreground/70"
            title={t`Couldn't load this skill's files.`}
          >
            <Trans>Couldn't load files</Trans>
          </span>
        </SidebarMenuSubItem>
      ) : (
        tree.map((node) => (
          <FileTreeNode key={node.path} node={node} depth={0} onOpenFile={openFile} />
        ))
      )}
    </SidebarMenuSub>
  );
}

function FileTreeNode({
  node,
  depth,
  onOpenFile,
}: {
  node: FileNode;
  depth: number;
  onOpenFile: (filePath: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const indent = { paddingLeft: `${depth * 0.6}rem` } as const;

  if (node.children) {
    return (
      <Collapsible open={open} onOpenChange={setOpen} className="group/dir">
        <SidebarMenuSubItem>
          <CollapsibleTrigger asChild>
            <SidebarMenuSubButton size="sm" className="text-[11px]" style={indent}>
              <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/dir:rotate-90" />
              <span className="truncate">{node.name}/</span>
            </SidebarMenuSubButton>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {node.children.map((child) => (
              <FileTreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                onOpenFile={onOpenFile}
              />
            ))}
          </CollapsibleContent>
        </SidebarMenuSubItem>
      </Collapsible>
    );
  }

  // Leaf file: opens read-only in the editor area (like clicking a file in the
  // file tree above) — no cramped inline preview.
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        size="sm"
        className="text-[11px]"
        style={indent}
        data-testid={`skill-file-${node.path}`}
        onClick={() => onOpenFile(node.path)}
      >
        <FileCode className="size-3 shrink-0 text-muted-foreground" />
        <span className="truncate">{node.name}</span>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

/**
 * One-time import offer: when this project is undecided about skill management
 * AND there are editor-dir skills OK could adopt, ask once. "Import" flips the
 * project to OK-managed (server adopts them into `.ok/skills` + symlinks);
 * "Not now" records the decline. Either way the choice persists per-machine, so
 * the banner does not return. Skills already under `.ok/skills` are managed
 * regardless and are not what this offers.
 */
function SkillImportPrompt() {
  const [state, setState] = useState<{ managed: boolean | null; importable: number } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSkillsManagement().then((s) => {
      if (!cancelled) setState(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Show only while undecided (managed === null) with something to import.
  if (!state || state.managed !== null || state.importable === 0) return null;

  const decide = async (manage: boolean) => {
    setBusy(true);
    const ok = await setSkillsManagement(manage);
    if (!ok) {
      // PUT failed — the server never persisted the choice. Re-enable the
      // buttons and leave the banner up so the user can retry, instead of
      // dismissing it as a silent (false) success.
      setBusy(false);
      return;
    }
    setState({ managed: manage, importable: 0 });
  };

  return (
    <div className="mx-2 mb-1 rounded-md border border-border/60 bg-muted/40 p-2 text-xs">
      <p className="mb-2 text-muted-foreground">
        <Trans>
          Open Knowledge can manage {state.importable} editor skill(s) for this project. Import
          moves them into .ok/skills and replaces the .claude, .codex, etc. copies with symlinks —
          one place to edit, in sync everywhere. If those folders are committed to git, review the
          change first; symlinks can behave differently on some editors and on Windows.
        </Trans>
      </p>
      <div className="flex gap-1.5">
        <Button size="sm" className="h-6 px-2 text-xs" disabled={busy} onClick={() => decide(true)}>
          <Trans>Import</Trans>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          disabled={busy}
          onClick={() => decide(false)}
        >
          <Trans>Not now</Trans>
        </Button>
      </div>
    </div>
  );
}
