import {
  type CatalogSkill,
  catalogRawScopeToOkScope,
  externalSkillLiveDocName,
  type SkillScope,
  type SkillsListEntry,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { FILE_TREE_TAG_NAME, type FileTreeSortComparator } from '@pierre/trees';
import { useFileTree } from '@pierre/trees/react';
import { Compass, Loader2, Sparkles, SquarePen, Upload } from 'lucide-react';
import { __iconNode as lockIcon } from 'lucide-react/dist/esm/icons/lock';
import { __iconNode as packageIcon } from 'lucide-react/dist/esm/icons/package';
import { useTheme } from 'next-themes';
import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AgentBrandIcon } from '@/components/AgentIconCluster';
import { createFileTreeStyle } from '@/components/file-tree-density';
import {
  buildOkFileTreeOptions,
  createLucideSpriteSymbol,
  OK_FILE_TREE_READONLY_UNSAFE_CSS,
} from '@/components/file-tree-shared';
import type { AddSkillTab } from '@/components/ImportSkillDialog';
import { NewSkillDialog } from '@/components/NewSkillDialog';
import { OkFileTree } from '@/components/OkFileTree';
import {
  INSTALL_EDITORS,
  SKILL_INSTALL_MENU_WIDTH,
  SkillInstallMenuItems,
  useSkillHostToggles,
} from '@/components/SkillInstallMenu';
import {
  type SkillActions,
  SkillContextMenuItems,
  SkillFileContextMenuItems,
  useSkillActions,
} from '@/components/skill-actions';
import {
  applyInstallClusters,
  HOST_POOL_KEY_ATTR,
  installPillFromEvent,
  type RowInstallDecor,
  SKILL_INSTALL_CLUSTER_CSS,
} from '@/components/skill-install-cluster';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarGroup, SidebarGroupContent } from '@/components/ui/sidebar';
import { asDirectoryHandle } from '@/components/use-selection-mirror';
import { useDocumentContext } from '@/editor/DocumentContext';
import { findLocalSkillPreviewTabId } from '@/editor/editor-tabs';
import { useCreateBlankSkill } from '@/hooks/use-create-blank-skill';
import { useOpenSkill } from '@/hooks/use-open-skill';
import { useOpenSkillForEdit } from '@/hooks/use-open-skill-for-edit';
import { useSkills } from '@/hooks/use-skills';
import {
  hashFromDocName,
  hashFromSkillFile,
  hashFromSkillPreview,
  pushHashWithoutNavigation,
  type SkillPreviewHashTarget,
} from '@/lib/doc-hash';
import { subscribeToSkillsChanged } from '@/lib/documents-events';
import { skillEntryFileLiveDocName, skillEntryLiveDocName } from '@/lib/managed-artifact-doc-name';
import {
  SKILL_SCOPE_ORDER,
  skillClusterHosts,
  skillDisplayName,
  skillEntryDirs,
  skillHostRootDir,
  skillNameSetsByScope,
  tildeHomePath,
  useSkillScopeDescriptions,
  useSkillScopeLabels,
} from '@/lib/skill-scope';
import { createSkillSortComparator, SKILL_MD_PATH } from '@/lib/skill-sort';
import {
  fetchSkillPreview,
  getSkillBundledFiles,
  listDetectedSkills,
  type SkillBundledFile,
} from '@/lib/skills-api';

// Lazy-load the full add-skill modal (skills.sh search + upload + new skill) —
// the SAME dialog the Skills empty state opens — so its weight stays out of the
// always-mounted sidebar bundle and loads only on first open.
const ImportSkillDialog = lazy(() =>
  import('@/components/ImportSkillDialog').then((m) => ({ default: m.ImportSkillDialog })),
);

/** A skill dir is the parent of its `SKILL.md`; the detected preview reads it as a local source. */
function skillDir(skillMdPath: string): string {
  const i = skillMdPath.lastIndexOf('/');
  return i > 0 ? skillMdPath.slice(0, i) : skillMdPath;
}

// OK's own core product skills — managing them with OK is circular, so they
// never show as "Detected". Its shipped *packs* (`open-knowledge-pack-*`) are
// fair game to adopt, so they are NOT excluded.
const OK_OWN_SKILLS = new Set([
  'open-knowledge',
  'open-knowledge-discovery',
  'open-knowledge-write-skill',
]);

// A scope with ZERO skills renders no child, and Pierre drops a childless
// directory from the visible tree — so the GLOBAL / PROJECT header would vanish
// and the sibling scope slides to the top (breaks "project always first" when the
// project has no skills). Give an empty scope ONE sentinel child so its folder +
// header always render in SKILL_SCOPE_ORDER. The sentinel row is display:none'd
// (SKILLS_TREE_CSS) and every row handler skips it (skillFor/detectedFor return
// undefined for it). Underscores can't appear in a real skill name (SKILL_NAME_REGEX),
// so it can't collide. Works WITH `flattenEmptyDirectories: false` — that keeps the
// resulting single-child folder from collapsing back into the sentinel.
const EMPTY_SCOPE_SENTINEL = '__ok_empty_scope__';

// Built-in skills are locked (bundled, read-only) — a lock glyph on the row is
// the "you can't edit this" signal, in place of a state badge. Registered as a
// sprite symbol the same way FileTree's link/agent decoration icons are.
const BUILTIN_LOCK_ICON_ID = 'ok-skills-builtin-lock-decoration';
// Plugin-cache residents get a package glyph — same "you can't edit this here"
// signal as the built-in lock, with the way out in the tooltip.
const PLUGIN_PACKAGE_ICON_ID = 'ok-skills-plugin-package-decoration';
const SKILLS_DECORATION_EXTRA_SYMBOLS =
  createLucideSpriteSymbol(BUILTIN_LOCK_ICON_ID, lockIcon) +
  createLucideSpriteSymbol(PLUGIN_PACKAGE_ICON_ID, packageIcon);

// Per-tree CSS (Pierre `unsafeCSS`):
//  - Installed/Draft/Detected decoration badge: ~11px, right-aligned, never truncates.
//  - Focus ring only on the SELECTED (open) row, not a merely-focused one.
//  - Scope rows (top-level = aria-level 1): hidden folder icon + uppercase muted
//    text, so GLOBAL / PROJECT read as section labels rather than plain folders.
const SKILLS_TREE_CSS = `
  [data-item-section='decoration'] { flex: 1 0 auto; }
  [data-item-section='decoration'] > span { max-width: none; font-size: 0.6875rem; }
  [data-item-focused='true']:not([data-item-selected='true'])::before {
    outline-color: transparent;
  }
  /* Never mid-word-break a skill name — long names truncate with an ellipsis
     instead of wrapping into hyphenless fragments. */
  [data-item-section='content'] {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    word-break: normal;
  }
  /* Keep the icon section: for a folder it IS the disclosure chevron (rotates
     open/closed) — the collapse affordance for GLOBAL / PROJECT. */
  [aria-level='1'] [data-item-section='content'] {
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.75rem;
    font-family: var(--font-mono);
    /* Deliberately darker than the chevron's --trees-fg-muted: the label is
       read, the twisty is only an affordance. Own declaration, so it also
       survives the selected-state !important on the row below. */
    color: var(--muted-foreground);
  }
  /* The disclosure chevron otherwise tints to Pierre's primary selected-fg when
     the scope row is focused/selected — pin it muted in every state. */
  [aria-level='1'] [data-item-section='icon'] { color: var(--trees-fg-muted) !important; }
  /* Scope rows only expand — Pierre still selects them on click, but they must
     never look selected: kill the selection background, the primary text/twisty
     color, and the focus ring. (!important beats Pierre's selected-state rules.) */
  [aria-level='1'][data-item-selected='true'] {
    background-color: transparent !important;
    color: var(--trees-fg-muted) !important;
  }
  [aria-level='1']::before { outline: none !important; }
  /* Empty-scope sentinel child: structural only (forces the scope folder to
     render); never shown to the user. */
  [data-item-path$='/${EMPTY_SCOPE_SENTINEL}'] { display: none !important; }
`;

/** A tree path `<ScopeLabel>/<skillDisplay>/<sub…>` split into its parts. */
interface TreeNode {
  scopeLabel: string;
  /** undefined = the scope row itself (top level). */
  skillDisplay: string | undefined;
  /** path within the skill (SKILL.md, references/x, …); null = the skill folder. */
  sub: string | null;
  isDir: boolean;
}

function parseTreePath(treePath: string): TreeNode {
  const isDir = treePath.endsWith('/');
  const clean = isDir ? treePath.slice(0, -1) : treePath;
  const parts = clean.split('/');
  return {
    scopeLabel: parts[0] ?? '',
    skillDisplay: parts.length >= 2 ? parts[1] : undefined,
    sub: parts.length >= 3 ? parts.slice(2).join('/') : null,
    isDir,
  };
}

/**
 * "Skills" section of the file sidebar — ONE `<OkFileTree>` (the same Pierre
 * component as the main file tree). GLOBAL / PROJECT are top-level folder rows
 * (styled as muted uppercase labels via `SKILLS_TREE_CSS`); each scope's skills
 * nest under it. A scope holds this project's skills (store + in-place)
 * and skills OK detected in your other tools (editable in place). A single tree
 * means Pierre's native single-select "just works". `SKILL.md` opens the editor;
 * a detected row opens its editable in-place buffer.
 */
export function SkillsSidebarSection({ skillsMode = false }: { skillsMode?: boolean } = {}) {
  const state = useSkills();
  const { openTarget, activeDocName, activeTarget, openTabs, activateTab, setSkillsSidebar } =
    useDocumentContext();
  /**
   * Opening from the Skills tree KEEPS you in Skills. Surface follows the target
   * only for navigation that carries no surface intent (a deep link, the
   * palette); a click on a row in this tree carries plenty. Must run AFTER the
   * open — committing a new tab re-arms autofollow, and this is the pin that
   * overrides it.
   */
  const stayInSkills = () => setSkillsSidebar(true);
  const openSkill = useOpenSkill();
  const openSkillForEdit = useOpenSkillForEdit();
  const actions = useSkillActions();
  const { t } = useLingui();
  const scopeLabel = useSkillScopeLabels();
  const scopeDescription = useSkillScopeDescriptions();

  const skills = state.status === 'ready' ? state.data : [];
  const nameSets = skillNameSetsByScope(skills);
  // Live user-expanded folder tree paths, reported by the inner tree (Pierre has
  // no expand event; it reads `isExpanded()` on model changes). Held as STATE in
  // the OUTER component so it survives the inner tree's remount on a rename /
  // install-state change, letting `expanded` below restore what the user had open
  // instead of collapsing everything (§2.7/§2.8). State (not a ref) so it can be
  // read during render without violating the React Compiler.
  const [userExpanded, setUserExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const { createBlank, creating } = useCreateBlankSkill();
  // Which scope + add-skill modal tab (upload / skills-sh) is open; null = closed.
  const [addSkill, setAddSkill] = useState<{ scope: SkillScope; tab: AddSkillTab } | null>(null);
  // Which scope the New-skill (name + description) dialog is open for; null = closed.
  const [newSkillScope, setNewSkillScope] = useState<SkillScope | null>(null);

  // Skills OK detected in your other tools that aren't in this project's skills
  // list — in-place project skills list first-class now, so what
  // remains here is global-scope skills + plugin-cache installs, rendered as
  // editable rows under their scope.
  const [detected, setDetected] = useState<CatalogSkill[] | null>(null);
  // A detected skill's bundle files (references/scripts), fetched lazily the
  // first time the user opens it — so the sidebar shows its file tree WITHOUT
  // firing a preview fetch for every detected skill up front. Keyed `scope::name`.
  const [detectedFilesById, setDetectedFilesById] = useState<Record<string, readonly string[]>>({});
  useEffect(() => {
    if (!skillsMode) return;
    let alive = true;
    const load = () => {
      void listDetectedSkills().then((r) => {
        if (!alive) return;
        if (r.ok) setDetected(r.skills);
        else {
          console.warn('[skills-sidebar] listDetectedSkills failed:', r);
          setDetected([]);
        }
      });
    };
    load();
    const unsub = subscribeToSkillsChanged(load);
    return () => {
      alive = false;
      unsub();
    };
  }, [skillsMode]);

  // A name can be held by several distinct-content skills in different host dirs
  // — different skills, not copies. Scope+name is then not a row identity: it
  // would collapse their bundle-file lists and their tree rows into one. Only
  // those rows carry a host qualifier, so every ordinary skill keeps the exact
  // keys and requests it used before.
  const sharedNameKeys = new Set<string>();
  {
    const seen = new Set<string>();
    for (const s of skills) {
      const k = `${s.scope}:${s.name}`;
      if (seen.has(k)) sharedNameKeys.add(k);
      seen.add(k);
    }
  }
  const hostQualifierOf = (s: SkillsListEntry): string | undefined =>
    sharedNameKeys.has(`${s.scope}:${s.name}`) ? s.hosts[0] : undefined;
  const skillRowKey = (s: SkillsListEntry): string =>
    `${s.scope}:${s.name}:${hostQualifierOf(s) ?? ''}`;

  // Eager-load every managed skill's bundle files (both scopes) into one map.
  // Keyed on the full row set so it refetches only on add/remove, not every render.
  const filesKey = skills.map(skillRowKey).join('|');
  const [filesByKey, setFilesByKey] = useState<Record<string, readonly SkillBundledFile[]>>({});
  // True while the N-per-skill bundle-file fetch is in flight. Drives the section
  // loading indicator so a folder with many skills doesn't look broken/empty while
  // it fetches. Self-scaling: barely a flash on a small KB, visible when
  // there are many skills to load.
  const [bundleLoading, setBundleLoading] = useState(false);
  useEffect(() => {
    // Only the Skills tree consumes filesByKey, and this section stays mounted
    // in Files view too — so skip the N fetches + skillsChanged subscription
    // entirely until Skills mode is actually shown.
    if (!skillsMode) return;
    let alive = true;
    const entries = filesKey ? filesKey.split('|') : [];
    const load = () => {
      setBundleLoading(true);
      void Promise.all(
        entries.map((e) => {
          const [scope, name, host] = e.split(':') as [SkillScope, string, string];
          return getSkillBundledFiles(scope, name, host || undefined).then((r) => {
            // A non-OK fetch yields an empty file list, indistinguishable from a
            // skill that genuinely has none — leave a diagnostic so a 500/timeout
            // doesn't vanish silently.
            if (!r.ok)
              console.warn(`[skills-sidebar] failed to load bundle files for ${e}:`, r.error);
            return [e, r.ok ? r.files : []] as const;
          });
        }),
      )
        .then((loaded) => {
          if (alive) setFilesByKey(Object.fromEntries(loaded));
        })
        .catch((err) => {
          // getSkillBundledFiles catches its own fetch rejections, so this only
          // fires on an unexpected throw — surface it rather than leaving state stale.
          console.error('[skills-sidebar] unexpected error loading skill bundle files', err);
        })
        .finally(() => {
          if (alive) setBundleLoading(false);
        });
    };
    load();
    const unsub = subscribeToSkillsChanged(load);
    return () => {
      alive = false;
      unsub();
    };
  }, [filesKey, skillsMode]);

  // The Files/Skills switch now lives in the sidebar chrome row (FileSidebar),
  // shared with search — so in Files mode this section contributes nothing and
  // the FileTree renders directly beneath that row.
  if (!skillsMode) {
    return null;
  }

  // --- open routing (parameterized by skill) ---
  // Open a skill's live doc (project content doc OR `__skill__/…` managed-
  // artifact doc — both resolve to a `{kind:'doc'}` target) REPLACING the active
  // tab, the same preview-tab behavior the Files tree uses on click: clicking
  // through skills reuses one tab instead of stacking a new one each time (§8.7).
  // A pinned active tab is preserved (replace-active falls back to append when
  // pinned, handled in openTargetWithOptions).
  const openSkillDoc = (docName: string) => {
    openTarget({ kind: 'doc', target: docName, docName }, { tabBehavior: 'replace-active' });
    pushHashWithoutNavigation(hashFromDocName(docName));
    stayInSkills();
  };
  const openSkillMd = (skill: SkillsListEntry) => {
    openSkillDoc(skillEntryLiveDocName(skill));
  };
  // Managed built-ins reuse the SAME read-only preview tab as detected skills, sourced
  // from their bundle dir (`absolutePath` is the bundle SKILL.md; its parent is
  // the skill dir). The `builtin` flavor swaps the "Manage it" header for a
  // read-only note and drops the import action.
  // Open a read-only skill preview REPLACING the active tab (§8.7, matching the
  // editable-doc + Files behavior), instead of stacking a new preview tab each
  // click. The hash still carries the full target for deep-linking + the
  // in-preview FILES list. A pinned active tab is preserved by openTargetWithOptions.
  const openPreviewReplacing = (target: SkillPreviewHashTarget) => {
    // A local-path preview (built-in / detected) reuses the tab already open for
    // that skill+level instead of spawning a second one. Its `source` is part of
    // the tab identity but moves under us — a plugin-cache path carries the
    // plugin version, and a detected skill relocates when its installed copy is
    // deleted — so the same skill would otherwise open a second, identically
    // labelled tab. `explore` keeps `source` in its identity (same name from two
    // repos is two different previews), so it is not deduped here.
    if (target.flavor !== 'explore' && target.level) {
      const existing = findLocalSkillPreviewTabId(
        openTabs,
        target.flavor,
        target.name,
        target.level,
      );
      if (existing) {
        activateTab(existing);
        pushHashWithoutNavigation(hashFromSkillPreview(target));
        stayInSkills();
        return;
      }
    }
    openTarget(
      {
        kind: 'skill-preview' as const,
        target: `${target.flavor}/${target.source}/${target.name}`,
        flavor: target.flavor,
        source: target.source,
        name: target.name,
        subtitle: target.subtitle,
        level: target.level,
        path: target.path,
      },
      { tabBehavior: 'replace-active' },
    );
    pushHashWithoutNavigation(hashFromSkillPreview(target));
    stayInSkills();
  };
  const openManaged = (skill: SkillsListEntry) => {
    // Same-tab reuse for a re-opened built-in lives in `openPreviewReplacing`,
    // which covers every local-path preview flavor.
    openPreviewReplacing({
      flavor: 'builtin',
      source: skillDir(skill.absolutePath ?? ''),
      name: skill.name,
      subtitle: '',
      level: skill.scope,
    });
  };
  const openFile = (skill: SkillsListEntry, filePath: string) => {
    const dot = filePath.lastIndexOf('.');
    const ext = dot >= 0 ? filePath.slice(dot + 1).toLowerCase() : '';
    // Editable in place: any `.md`/`.mdx` bundle file of a non-managed skill,
    // project OR global. Project files are content docs; global files are
    // managed-artifact live docs — `skillFileLiveDocName` routes both. Managed
    // built-ins (open-knowledge*) and non-md files (scripts/binary) fall through
    // to the read-only skill-file viewer.
    if (!skill.managed && (ext === 'md' || ext === 'mdx')) {
      openSkillDoc(skillEntryFileLiveDocName(skill, filePath));
      return;
    }
    const host = hostQualifierOf(skill);
    openTarget(
      {
        kind: 'skill-file' as const,
        // The target string is the tab identity — it must separate two
        // same-named skills, or opening one focuses the other's tab.
        target: `${skill.scope}/${skill.name}${host ? `:${host}` : ''}/${filePath}`,
        scope: skill.scope,
        name: skill.name,
        path: filePath,
        ...(host ? { host } : {}),
      },
      { tabBehavior: 'replace-active' },
    );
    pushHashWithoutNavigation(
      hashFromSkillFile({
        scope: skill.scope,
        name: skill.name,
        path: filePath,
        ...(host ? { host } : {}),
      }),
    );
    stayInSkills();
  };
  const isFileActive = (skill: SkillsListEntry, filePath: string): boolean => {
    const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
    if (!skill.managed && (ext === 'md' || ext === 'mdx')) {
      return activeDocName === skillEntryFileLiveDocName(skill, filePath);
    }
    return (
      activeTarget?.kind === 'skill-file' &&
      activeTarget.scope === skill.scope &&
      activeTarget.name === skill.name &&
      activeTarget.path === filePath
    );
  };
  const isSkillMdActive = (skill: SkillsListEntry): boolean => {
    // A skill-FILE viewer (`{kind:'skill-file'}`, e.g. LICENSE.txt) and a skill
    // PREVIEW carry no docName, so opening one leaves `activeDocName` stale on the
    // last DOC tab — which is often this skill's SKILL.md. Without this guard that
    // stale value makes SKILL.md read as active while a file viewer is open, so the
    // tree highlights SKILL and the `p === activePath` click-guard then blocks
    // reopening SKILL.md. Only a real doc tab counts as the active SKILL.md.
    if (activeTarget?.kind !== 'doc') return false;
    return activeDocName === skillEntryLiveDocName(skill);
  };

  // Detected-row actions: open the editable in-place buffer.
  const detectedId = (s: CatalogSkill) =>
    `${catalogRawScopeToOkScope(s.provenance.scope)}::${s.name}`;
  // Lazily load this detected skill's bundle file tree on first open (cached
  // after) so the row can nest references/scripts under it.
  const ensureDetectedFiles = (s: CatalogSkill, source: string) => {
    const id = detectedId(s);
    if (detectedFilesById[id] !== undefined) return;
    void fetchSkillPreview({ source, name: s.name }).then((r) => {
      if (!r.ok) return;
      setDetectedFilesById((prev) => ({ ...prev, [id]: r.files.map((f) => f.relPath) }));
    });
  };
  const openDetected = (s: CatalogSkill, sub?: string) => {
    const source = skillDir(s.files.skillMd);
    ensureDetectedFiles(s, source);
    const rel = sub && sub !== SKILL_MD_PATH ? sub : undefined;
    // A Claude PLUGIN-CACHE resident is vendor-managed, versioned state — a
    // plugin update clobbers any edit, so the editable in-place buffer is a
    // trap there. Open the read-only detected preview instead (Adopt copies
    // it to a real location the user owns).
    if (s.provenance.plugin !== undefined) {
      openPreviewReplacing({
        flavor: 'detected',
        source,
        name: s.name,
        subtitle: s.sourceHarness ?? '',
        level: catalogRawScopeToOkScope(s.provenance.scope),
        ...(rel !== undefined ? { path: sub } : {}),
      });
      return;
    }
    // The skill row / SKILL.md AND every reference file open the EDITABLE buffer
    // that autosaves back to the real harness file — "edit without managing":
    // full WYSIWYG. A bundle file
    // passes its ext-less `rel`; one registration covers the whole skill dir.
    void openSkillForEdit(s.name, source, { replaceActive: true, rel }).then((r) => {
      if (!r.ok) toast.error(t`Couldn't open ${s.name} for editing: ${r.error}`);
      // Pins after the async open lands, for the same reason as the sync paths.
      else stayInSkills();
    });
  };

  // Build paths + a `<scopeLabel>/<segment>` → skill lookup. Every scope always
  // appears (as an empty folder if it has no skills) so its "New / Add" menu is
  // always reachable.
  const labelToScope = new Map(SKILL_SCOPE_ORDER.map((s) => [scopeLabel[s], s] as const));
  // The tree segment is normally the stripped display name, but Pierre labels
  // rows by the path basename — so when two skills in one scope strip to the
  // same name (e.g. a user `foo` beside the shipped `open-knowledge-pack-foo`)
  // a shared segment would collapse both to one row and hide one. Only the
  // colliding skills fall back to their full (unstripped) name to stay distinct.
  // Third tier: distinct-content skills that share a name outright, where even
  // the full name is identical — those take the host dir that holds them, which
  // is the thing that actually tells them apart.
  const displayCounts = new Map<string, number>();
  for (const s of skills) {
    const key = `${s.scope}\x00${skillDisplayName(s.name)}`;
    displayCounts.set(key, (displayCounts.get(key) ?? 0) + 1);
  }
  const segmentFor = (s: SkillsListEntry) => {
    const display = skillDisplayName(s.name);
    const host = hostQualifierOf(s);
    if (host) return `${s.name} (${host === 'agents' ? '.agents' : host})`;
    return (displayCounts.get(`${s.scope}\x00${display}`) ?? 0) > 1 ? s.name : display;
  };
  const skillByPrefix = new Map<string, SkillsListEntry>();
  const paths: string[] = [];
  let activePath: string | undefined;
  // Both scope rows (GLOBAL / PROJECT) stay expanded. The tree remounts on any
  // skill add/remove/rename (path/state key change), and Pierre exposes no
  // expansion callback to snapshot user state across that — so pinning the
  // section headers open keeps a sibling scope from collapsing when an unrelated
  // skill is deleted. Individual skill folders still expand only for the active doc.
  const expanded: string[] = [];
  // Segments already taken per scope — so a detected skill can't collide with a
  // managed skill's row (or another detected skill's).
  const usedSegments = new Map<SkillScope, Set<string>>(
    SKILL_SCOPE_ORDER.map((s) => [s, new Set<string>()]),
  );
  for (const scope of SKILL_SCOPE_ORDER) {
    paths.push(`${scopeLabel[scope]}/`);
    expanded.push(`${scopeLabel[scope]}/`);
  }
  for (const s of skills) {
    const segment = segmentFor(s);
    usedSegments.get(s.scope)?.add(segment);
    const prefix = `${scopeLabel[s.scope]}/${segment}`;
    skillByPrefix.set(prefix, s);
    paths.push(`${prefix}/${SKILL_MD_PATH}`);
    if (isSkillMdActive(s)) {
      activePath = `${prefix}/${SKILL_MD_PATH}`;
      expanded.push(`${scopeLabel[s.scope]}/`, `${prefix}/`);
    }
    for (const f of filesByKey[skillRowKey(s)] ?? []) {
      paths.push(`${prefix}/${f.path}`);
      if (!activePath && isFileActive(s, f.path)) {
        activePath = `${prefix}/${f.path}`;
        expanded.push(`${scopeLabel[s.scope]}/`, `${prefix}/`);
      }
    }
  }

  // Detected (un-managed) skills — badged rows nested under their OWN scope
  // alongside the managed ones. A detected skill's level comes from the harness
  // provenance (Claude's project / user), NOT where the file lives, so a
  // project-scoped plugin skill lands under PROJECT even though its files are in
  // a user-global home. The server has already dropped project-scoped installs
  // bound to a DIFFERENT project (project-locality), so a `project` row here is
  // genuinely this project's. A detected skill whose name is already OK-managed
  // (at either scope) is skipped: the managed skill is re-detected via its editor
  // symlink, and it already shows as its managed row.
  const managedNames = new Set<string>([...nameSets.global, ...nameSets.project]);
  const detectedByPrefix = new Map<string, CatalogSkill>();
  const visibleDetected = detected ?? [];
  for (const s of visibleDetected) {
    if (managedNames.has(s.name) || OK_OWN_SKILLS.has(s.name)) continue;
    const scope = catalogRawScopeToOkScope(s.provenance.scope);
    const used = usedSegments.get(scope);
    if (!used) continue;
    let segment = skillDisplayName(s.name);
    if (used.has(segment)) segment = s.name;
    if (used.has(segment)) continue; // hard collision (rare) → don't hide a real row
    used.add(segment);
    const prefix = `${scopeLabel[scope]}/${segment}`;
    detectedByPrefix.set(prefix, s);
    paths.push(`${prefix}/${SKILL_MD_PATH}`);
    // Highlight the row when its editable `__extskill__/` buffer is the open doc.
    if (!activePath && activeDocName === externalSkillLiveDocName(s.name)) {
      activePath = `${prefix}/${SKILL_MD_PATH}`;
      expanded.push(`${scopeLabel[scope]}/`, `${prefix}/`);
    }
    // Once loaded, nest the detected skill's reference/script files under it and
    // keep it expanded so the tree it just revealed doesn't collapse on re-render.
    const detectedFiles = detectedFilesById[detectedId(s)] ?? [];
    for (const rel of detectedFiles) paths.push(`${prefix}/${rel}`);
    if (detectedFiles.length > 0) expanded.push(`${prefix}/`);
  }

  // Every scope with NO skills (managed or detected) gets a hidden sentinel child
  // so Pierre still renders its folder + header — otherwise a childless directory
  // is dropped from the visible tree and the scope disappears, sliding the sibling
  // to the top. `usedSegments` holds the taken segments per scope, so size 0 = empty.
  for (const scope of SKILL_SCOPE_ORDER) {
    if (usedSegments.get(scope)?.size === 0) {
      paths.push(`${scopeLabel[scope]}/${EMPTY_SCOPE_SENTINEL}`);
    }
  }

  // Restore folders the user manually expanded across a remount: the set of all
  // valid folder tree paths is the scope rows + every managed/detected skill's
  // folder; keep only the ones the inner tree recorded as expanded (§2.7/§2.8).
  const validFolderPaths = new Set<string>();
  for (const scope of SKILL_SCOPE_ORDER) validFolderPaths.add(`${scopeLabel[scope]}/`);
  for (const prefix of skillByPrefix.keys()) validFolderPaths.add(`${prefix}/`);
  for (const prefix of detectedByPrefix.keys()) validFolderPaths.add(`${prefix}/`);
  for (const p of userExpanded) {
    if (validFolderPaths.has(p)) expanded.push(p);
  }

  // Pure, unit-tested comparator (see skill-sort.test.ts). The depth semantics
  // it encodes are load-bearing and previously shipped wrong; keep the coverage.
  const skillSort = createSkillSortComparator(labelToScope, detectedByPrefix);

  // Remount key: path set + per-skill state (installed/update) + detected count —
  // NOT the active row (selection is synced imperatively so opening a doc never
  // remounts / collapses the tree).
  const stateKey = `${skills.map((s) => `${s.installed ? 1 : 0}`).join('')}|d${detectedByPrefix.size}`;

  // First list load, or the N-per-skill bundle-file fetch in flight — surface it
  // so a folder with many skills reads as "loading", not broken/empty.
  const skillsLoading = state.status === 'loading' || bundleLoading;

  return (
    <SidebarGroup className="px-0">
      <SidebarGroupContent>
        <SkillsShareLocalOnlyPrompt
          hasProjectSkills={skills.some((s) => s.scope === 'project' && !s.managed)}
        />
        {skillsLoading ? (
          <div
            className="flex items-center gap-2 px-3 py-1.5 text-muted-foreground text-xs"
            data-testid="skills-loading"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            <Trans>Loading skills</Trans>
          </div>
        ) : null}
        <SkillsTree
          key={`${paths.join('|')}::${stateKey}`}
          paths={paths}
          activePath={activePath}
          initialExpandedPaths={expanded}
          onExpandedChange={setUserExpanded}
          sort={skillSort}
          skillByPrefix={skillByPrefix}
          detectedByPrefix={detectedByPrefix}
          labelToScope={labelToScope}
          scopeDescription={scopeDescription}
          existingNames={nameSets}
          actions={actions}
          onOpenSkillMd={openSkillMd}
          onOpenFile={openFile}
          onOpenDetected={openDetected}
          onOpenManaged={openManaged}
          onNewSkill={(scope) => setNewSkillScope(scope)}
          onAddSkill={(scope, tab) => setAddSkill({ scope, tab })}
        />
      </SidebarGroupContent>
      {newSkillScope !== null ? (
        <NewSkillDialog
          open
          scope={newSkillScope}
          existingNames={nameSets[newSkillScope]}
          busy={creating}
          onOpenChange={(open) => {
            if (!open) setNewSkillScope(null);
          }}
          onCreate={({ name, description }) => {
            const scope = newSkillScope;
            setNewSkillScope(null);
            void createBlank(scope, { name, description });
          }}
        />
      ) : null}
      {actions.dialogs}
      {addSkill !== null ? (
        <Suspense fallback={null}>
          <ImportSkillDialog
            defaultScope={addSkill.scope}
            defaultTab={addSkill.tab}
            open
            onOpenChange={(open) => {
              if (!open) setAddSkill(null);
            }}
            onImported={({ scope, name }) => {
              setAddSkill(null);
              openSkill(scope, name);
            }}
          />
        </Suspense>
      ) : null}
    </SidebarGroup>
  );
}

/**
 * The single Pierre tree. Remounted by the parent on path/state changes so it
 * re-derives decorations; selection is synced imperatively (below) so opening a
 * doc never remounts. Owns the decoration / context-menu / selection wiring for
 * both managed and detected rows.
 */
function SkillsTree({
  paths,
  activePath,
  initialExpandedPaths,
  onExpandedChange,
  sort,
  skillByPrefix,
  detectedByPrefix,
  labelToScope,
  scopeDescription,
  existingNames,
  actions,
  onOpenSkillMd,
  onOpenFile,
  onOpenDetected,
  onOpenManaged,
  onNewSkill,
  onAddSkill,
}: {
  paths: readonly string[];
  activePath: string | undefined;
  initialExpandedPaths: readonly string[];
  /** Report live user-expanded folder paths to the parent so a remount can
   *  restore expansion (§2.7/§2.8). Called only when the set changes. */
  onExpandedChange: (paths: ReadonlySet<string>) => void;
  sort: FileTreeSortComparator;
  skillByPrefix: Map<string, SkillsListEntry>;
  detectedByPrefix: Map<string, CatalogSkill>;
  labelToScope: Map<string, SkillScope>;
  scopeDescription: Record<SkillScope, string>;
  existingNames: Record<SkillScope, Set<string>>;
  actions: SkillActions;
  onOpenSkillMd: (skill: SkillsListEntry) => void;
  onOpenFile: (skill: SkillsListEntry, filePath: string) => void;
  onOpenDetected: (skill: CatalogSkill, sub?: string) => void;
  onOpenManaged: (skill: SkillsListEntry) => void;
  onNewSkill: (scope: SkillScope) => void;
  onAddSkill: (scope: SkillScope, tab: AddSkillTab) => void;
}) {
  const { t } = useLingui();
  const { resolvedTheme } = useTheme();
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Hidden light-DOM pool of brand icons the shadow-DOM injector clones from.
  const iconPoolRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  // Install pill → the per-agent install menu (a real Radix menu in the LIGHT
  // DOM, anchored at the clicked pill's screen rect — Radix can't render into
  // Pierre's shadow root).
  const [installMenu, setInstallMenu] = useState<{
    skill: SkillsListEntry;
    x: number;
    y: number;
  } | null>(null);
  // Re-inject clusters whenever any skill's host set changes: the tree only
  // remounts on the installed/not-installed BIT (`stateKey`), so adding a host
  // (1→2 agents) wouldn't otherwise refresh the icons. This signal in the
  // injection effect's deps forces a re-run without a full remount.
  const installSignal = [...skillByPrefix.values()]
    .map((s) => `${s.name}:${[...s.hosts].sort().join(',')}`)
    .join('|');
  const prefixOf = (node: TreeNode): string | undefined =>
    node.skillDisplay === undefined ? undefined : `${node.scopeLabel}/${node.skillDisplay}`;
  const skillFor = (node: TreeNode): SkillsListEntry | undefined => {
    const p = prefixOf(node);
    return p === undefined ? undefined : skillByPrefix.get(p);
  };
  const detectedFor = (node: TreeNode): CatalogSkill | undefined => {
    const p = prefixOf(node);
    return p === undefined ? undefined : detectedByPrefix.get(p);
  };
  // Row hover-title = the skill's real on-disk LOCATION (§4.2/§4.4), replacing the
  // default "Global/name" tree-path tooltip that gave a global skill no origin. A
  // bundle-file row appends its file path. Detected rows keep the default (their
  // "Detected in ~/.harness" badge already discloses the home). Built-ins are
  // read-only projected copies (not in `.ok/skills`), so show their real projected
  // SKILL.md dir from `absolutePath` rather than the derived store path.
  const titleForPath = (treePath: string): string | null => {
    const node = parseTreePath(treePath);
    // Scope header row (no skill name) → no path tooltip: skills at either
    // level live wherever their folder is (editor dirs or `.ok/skills`),
    // so a single store dir would lie. The header's context-menu label
    // carries the scope description instead.
    if (node.skillDisplay === undefined) return null;
    const d = detectedFor(node);
    // Detected rows → the real harness path(s) it lives in, not "Global/name"
    // (the meaningless tree path). Rendered at the ROW's scope so a project
    // detection reads `.claude/skills/...`, not the user home `~/.`. A skill
    // deduped across harnesses lists each.
    if (d) {
      const scope = labelToScope.get(node.scopeLabel) ?? 'global';
      const paths = d.sourceHarnesses.map(
        (h) => `${skillHostRootDir(h, scope)}/${node.skillDisplay}`,
      );
      return node.sub ? paths.map((p) => `${p}/${node.sub}`).join(', ') : paths.join(', ');
    }
    const skill = skillFor(node);
    if (!skill) return null;
    if (skill.managed) {
      const base = skill.absolutePath ? tildeHomePath(skillDir(skill.absolutePath)) : null;
      if (!base) return null;
      return node.sub ? `${base}/${node.sub}` : base;
    }
    // EVERY path the skill occupies (canonical first, then per-host copies) —
    // path-first disclosure so "where does this live / load from" needs no
    // decoding of brand names. User symlinks are disclosed as links.
    const labels = skillEntryDirs(skill).map((d) => {
      const dir = node.sub ? `${d.dir}/${node.sub}` : d.dir;
      return d.symlink ? t`${dir} (symlink)` : dir;
    });
    return labels.join(', ');
  };
  // Whether a row gets a context menu at all. Built-in (managed) skills are
  // read-only — no mutate menu — and neither are their bundle files or nested
  // folders. `renderContextMenu` returns null for exactly these; this predicate
  // MUST mirror it (kept adjacent so they change together), and the hover `···`
  // trigger is suppressed for rows where it is false (§2.1/§2.2).
  const rowHasContextMenu = (node: TreeNode): boolean => {
    const scope = labelToScope.get(node.scopeLabel);
    if (!scope) return false;
    if (node.skillDisplay === undefined) return true; // scope row → New / Upload / Explore
    if (detectedFor(node)) return true; // detected → Edit
    const skill = skillFor(node);
    if (!skill) return false;
    if (skill.managed) return false; // built-in = read-only (§2.1/§2.2)
    return true; // skill row, SKILL.md, a bundle folder (New file), or a file
  };
  // Latest predicate for the shadow-root observer below, without re-subscribing
  // the observer every render (its closure identity changes with `skills` /
  // `detected`). Updated in an effect — never mutate a ref during render.
  const rowHasContextMenuRef = useRef(rowHasContextMenu);
  useEffect(() => {
    rowHasContextMenuRef.current = rowHasContextMenu;
  });
  // Per-row install decoration for the imperative injector: an agent-icon cluster
  // (installed → its editors; detected → its harnesses) or an Install pill
  // (uninstalled). Built-ins return null (they keep the native lock decoration).
  const poolKeyFor = (id: string): string =>
    (INSTALL_EDITORS as readonly string[]).includes(id) ? id : 'generic';
  const decorForPath = (treePath: string): RowInstallDecor => {
    const node = parseTreePath(treePath);
    if (node.skillDisplay === undefined || node.sub !== null) return null;
    const d = detectedFor(node);
    if (d) {
      const scope = labelToScope.get(node.scopeLabel) ?? 'global';
      return {
        kind: 'icons',
        poolKeys: d.sourceHarnesses.map(poolKeyFor),
        title: t`Detected in ${d.sourceHarnesses.map((h) => skillHostRootDir(h, scope)).join(', ')}`,
      };
    }
    const skill = skillFor(node);
    if (!skill || skill.managed) return null;
    // Editors first (brand icons), plus the `.agents` hub as a neutral mark —
    // an in-place skill hosted only in `.agents` is loaded (by hub-reading
    // harnesses), not uninstalled. Alias-covered VIEWERS (an editor whose
    // skills folder is a symlink into a root holding this skill, e.g.
    // `.codex/skills` → `.agents/skills`) ride the cluster too — they read
    // the skill even though no location is theirs. `skillClusterHosts` IS the
    // derivation the toolbar pill uses, so the two surfaces cannot disagree.
    const hosts = skillClusterHosts(skill);
    if (hosts.length > 0)
      return {
        kind: 'icons',
        poolKeys: hosts.map(poolKeyFor),
        title: t`Installed in ${hosts.map((h) => skillHostRootDir(h, skill.scope)).join(', ')}`,
      };
    return { kind: 'install', title: t`Install ${skill.name}` };
  };
  // Live inputs for the injection observer, which is set up once but must see the
  // latest skills/theme/callbacks. Never mutate a ref during render.
  const injectInputsRef = useRef({ decorForPath, skillFor, installLabel: t`Install` });
  useEffect(() => {
    injectInputsRef.current = { decorForPath, skillFor, installLabel: t`Install` };
  });
  // The tree does NOT remount when the active doc changes (remount key excludes
  // `activePath` — see stateKey), so an inline `onSelectionChange` would close over a
  // STALE `activePath` frozen at the tree's last mount and wrongly bail (or fail to
  // bail) the "don't re-dispatch the already-active row" check. Keep the real handler
  // in a ref reassigned every render (so it captures the LIVE `activePath` + open
  // callbacks) and hand the tree a stable pass-through — the same pattern OkFileTree
  // uses. Manual memo (useCallback) is banned, so the ref is how we stay current.
  const handleSelectionChangeRef = useRef<(selected: readonly string[]) => void>(() => {});

  const { model } = useFileTree({
    ...buildOkFileTreeOptions({
      paths,
      initialExpansion: 'closed',
      initialExpandedPaths,
      initialSelectedPaths: activePath ? [activePath] : undefined,
      stickyFolders: false,
      enableContextMenu: true,
      unsafeCSS: `${OK_FILE_TREE_READONLY_UNSAFE_CSS}\n${SKILLS_TREE_CSS}\n${SKILL_INSTALL_CLUSTER_CSS}`,
      extraSpriteSymbols: SKILLS_DECORATION_EXTRA_SYMBOLS,
      renderRowDecoration: ({ item }) => {
        const node = parseTreePath(item.path);
        // Only a skill folder row (has a display name, no sub) gets a decoration.
        if (node.skillDisplay === undefined || node.sub !== null) return null;
        const skill = skillFor(node);
        // Built-in skills are locked (bundled, read-only) — a lock glyph says
        // "can't edit" more clearly than a text badge, and drops the confusing
        // "Managed" wording. This is the ONLY native Pierre decoration left; the
        // install-state marks (agent-icon cluster for installed/detected, an
        // Install pill for uninstalled) are injected imperatively via
        // `applyInstallClusters` below, because a multi-icon cluster + button
        // can't fit Pierre's one-text-or-one-icon decoration slot.
        if (skill?.managed) {
          return { icon: BUILTIN_LOCK_ICON_ID, title: t`Built-in (read-only)` };
        }
        const det = detectedFor(node);
        if (det?.provenance.plugin !== undefined) {
          return {
            icon: PLUGIN_PACKAGE_ICON_ID,
            title: t`Part of the ${det.provenance.plugin} plugin — read-only; open it to edit a copy`,
          };
        }
        return null;
      },
    }),
    // Direct on the useFileTree object (NOT inside buildOkFileTreeOptions) so the
    // React Compiler doesn't flag the ref read as happening during render. Routing
    // only; the highlight is reconciled by the selection-sync effect below.
    onSelectionChange: (selected) => handleSelectionChangeRef.current(selected),
    sort,
    // Pierre collapses single-child folder CHAINS by default, so a scope with
    // exactly one skill flattens `Project/` into that skill and the scope header
    // vanishes — inconsistent by skill count (0 or 2+ show it, 1 hides it) and it
    // drops the header's New/Add menu. The project always carries the built-in
    // `open-knowledge` skill, so "no custom skills" IS the one-child case. Disable
    // flattening so GLOBAL / PROJECT (and each skill folder) always render.
    flattenEmptyDirectories: false,
  });

  // Reassigned every render so the pass-through handler above captures the LIVE
  // `activePath` + open callbacks + `model` (declared just above). Manual memo is
  // banned; the ref is how we stay current.
  useEffect(() => {
    handleSelectionChangeRef.current = (selected) => {
      const p = selected[0];
      if (!p || p === activePath) return;
      const node = parseTreePath(p);
      if (node.sub !== null && node.isDir) return;
      const d = detectedFor(node);
      if (d) {
        // A detected skill row / SKILL.md / reference file opens the editable
        // in-place buffer. The folder stays expanded via the selection-sync
        // effect below (which re-expands on activePath change — the moment the
        // async open lands, overriding Pierre's folder-click collapse).
        onOpenDetected(d, node.sub ?? undefined);
        return;
      }
      const skill = skillFor(node);
      if (!skill) return;
      if (node.sub === null || node.sub === SKILL_MD_PATH) {
        // A built-in's SKILL.md opens the read-only preview; a managed skill's opens
        // its editor. Reference files fall to openFile below.
        (skill.managed ? onOpenManaged : onOpenSkillMd)(skill);
      } else {
        onOpenFile(skill, node.sub);
      }
    };
  });

  // Snapshot which folders the user has expanded into the parent-owned
  // `expandedRef`, so the parent can restore expansion when this tree remounts
  // on a rename / install-state change (§2.7/§2.8). Pierre fires no expand event,
  // so read `isExpanded()` on every model change. Folder inputs go through a ref
  // so the subscription re-runs only on `model` change, not every render.
  const folderInputsRef = useRef({
    labelToScope,
    skillByPrefix,
    detectedByPrefix,
    onExpandedChange,
  });
  useEffect(() => {
    folderInputsRef.current = { labelToScope, skillByPrefix, detectedByPrefix, onExpandedChange };
  });
  const lastSentRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const sync = () => {
      const inputs = folderInputsRef.current;
      const next = new Set<string>();
      const check = (folderPath: string) => {
        if (asDirectoryHandle(model.getItem(folderPath))?.isExpanded()) next.add(folderPath);
      };
      for (const label of inputs.labelToScope.keys()) check(`${label}/`);
      for (const prefix of inputs.skillByPrefix.keys()) check(`${prefix}/`);
      for (const prefix of inputs.detectedByPrefix.keys()) check(`${prefix}/`);
      // Only notify the parent when the expanded set actually changed — `subscribe`
      // fires on every model mutation, and a redundant setState would re-render.
      const prev = lastSentRef.current;
      if (prev.size === next.size && [...next].every((p) => prev.has(p))) return;
      lastSentRef.current = next;
      inputs.onExpandedChange(next);
    };
    sync();
    return model.subscribe(sync);
  }, [model]);

  // Selection = the open doc. Pierre selects folders on click (and folder-click
  // opens SKILL.md), so re-assert selection + focus onto the actual open row —
  // this also gives it the blue selected+focused ring. `focusPath` is internal
  // focus, not DOM focus, so it doesn't steal from the editor.
  useEffect(() => {
    if (!ready) return;
    for (const p of model.getSelectedPaths()) {
      if (p !== activePath) model.getItem(p)?.deselect();
    }
    if (activePath) {
      model.getItem(activePath)?.select();
      model.focusPath(activePath);
      // Keep the open skill's folder expanded. A detected-skill open is async
      // (endpoint round-trip) and a folder-row click toggles the folder shut;
      // this effect runs on activePath change (the moment the doc lands), so
      // re-expanding here is what actually holds the folder open. Managed skills
      // open synchronously — expanding their folder on open is harmless.
      const node = parseTreePath(activePath);
      if (node.skillDisplay !== undefined) {
        asDirectoryHandle(model.getItem(`${node.scopeLabel}/${node.skillDisplay}/`))?.expand();
      }
    }
  }, [ready, activePath, model]);

  // Restore ALL expected-expanded folders after a (re)mount. The tree remounts on
  // any `paths` change — notably a detected skill lazy-loading its reference files
  // when opened — and Pierre's `initialExpandedPaths` does not reliably re-open
  // folders other than the active row's ancestors, so previously-open sibling
  // folders collapsed. Keyed on `[ready, model]` so it fires once per (re)mount,
  // never on a plain click: it re-asserts the parent's expected set (which already
  // reflects the user's latest expand/collapse via `userExpanded`), so it can't
  // fight a live user collapse. Read via ref to avoid re-running on the array's
  // per-render identity change.
  const expandedPathsRef = useRef(initialExpandedPaths);
  useEffect(() => {
    expandedPathsRef.current = initialExpandedPaths;
  });
  useEffect(() => {
    if (!ready) return;
    for (const p of expandedPathsRef.current) {
      asDirectoryHandle(model.getItem(p))?.expand();
    }
  }, [ready, model]);

  // Suppress Pierre's floating `···` context-menu trigger for rows with no menu
  // (built-in skills + their files) — otherwise it shows a button that does
  // nothing (§2.1/§2.2). Pierre renders ONE floating anchor over the hovered
  // row; watch the hover marker and toggle the anchor's visibility. Same
  // shadow-root + signal as OkFileTree's title-stamp observer.
  useEffect(() => {
    if (!ready) return;
    const shadow = hostRef.current?.querySelector(FILE_TREE_TAG_NAME)?.shadowRoot;
    if (!shadow) return;
    const sync = () => {
      const anchor = shadow.querySelector<HTMLElement>('[data-type="context-menu-anchor"]');
      if (!anchor) return;
      const hoveredPath = shadow.querySelector<HTMLElement>(
        '[data-item-context-hover="true"][data-item-path]',
      )?.dataset.itemPath;
      const suppress =
        hoveredPath !== undefined && !rowHasContextMenuRef.current(parseTreePath(hoveredPath));
      anchor.style.display = suppress ? 'none' : '';
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(shadow, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-item-context-hover'],
    });
    return () => observer.disconnect();
  }, [ready]);

  // Inject the install-state marks (agent-icon cluster / Install pill) into each
  // skill row's decoration lane. A cluster + button can't fit Pierre's
  // one-text-or-one-icon decoration slot, so it's hand-built here (same shadow
  // observer pattern as the title stamp), cloning brand `<svg>`s from the hidden
  // pool. The Install pill opens the skill so its toolbar install menu (the full
  // per-agent picker) appears. `resolvedTheme` is a dep so the pool's re-colored
  // icons re-clone on a light/dark flip. `installSignal` is an intentional re-run
  // trigger — the effect reads live data through refs, so a host-set change isn't
  // visible in the body, but we must re-inject when it changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: installSignal is an intentional re-inject trigger (see comment above).
  useEffect(() => {
    if (!ready) return;
    const shadow = hostRef.current?.querySelector(FILE_TREE_TAG_NAME)?.shadowRoot;
    if (!shadow) return;
    const run = () =>
      applyInstallClusters(shadow, {
        decorFor: (p) => injectInputsRef.current.decorForPath(p),
        iconPool: iconPoolRef.current,
        installLabel: injectInputsRef.current.installLabel,
        version: resolvedTheme ?? 'light',
      });
    run();
    const observer = new MutationObserver(run);
    observer.observe(shadow, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-item-path'],
    });
    // Capture phase so the pill opens the menu before Pierre's row selection.
    const onClick = (e: Event) => {
      const pill = installPillFromEvent(e.target);
      if (!pill) return;
      e.preventDefault();
      e.stopPropagation();
      const skill = injectInputsRef.current.skillFor(parseTreePath(pill.path));
      if (skill) setInstallMenu({ skill, x: pill.rect.left, y: pill.rect.bottom });
    };
    shadow.addEventListener('click', onClick, true);
    // No cluster-specific hint. The row already carries a native tooltip naming
    // every path the skill occupies — strictly more than the cluster's roots —
    // so a second, differently-styled bubble alongside it read as a glitch, and
    // every other row in this tree explains itself through the native one.
    // The cluster carries `role="img"` + `aria-label`, so screen readers get the
    // install state as a name (an `aria-label` alone on a span would not).
    return () => {
      observer.disconnect();
      shadow.removeEventListener('click', onClick, true);
    };
  }, [ready, resolvedTheme, installSignal]);

  return (
    <>
      {/* Hidden light-DOM pool: React renders the brand icons (real brand colors +
          theme via TargetIcon), the shadow-DOM injector clones them into rows
          where Tailwind/shadcn can't reach. `generic` covers the agent-agnostic
          `~/.agents` dir and any harness without a brand mark. */}
      <div
        ref={iconPoolRef}
        aria-hidden
        style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
      >
        {INSTALL_EDITORS.map((id) => (
          <span key={id} {...{ [HOST_POOL_KEY_ATTR]: id }}>
            <AgentBrandIcon host={id} />
          </span>
        ))}
        <span {...{ [HOST_POOL_KEY_ATTR]: 'generic' }}>
          <Sparkles />
        </span>
      </div>
      {/* The Install pill's per-agent menu — a real Radix menu in the light DOM,
          anchored via a zero-size fixed trigger at the clicked pill's rect. */}
      {installMenu ? (
        <DropdownMenu
          open
          onOpenChange={(open) => {
            if (!open) setInstallMenu(null);
          }}
        >
          <DropdownMenuTrigger asChild>
            <span
              aria-hidden
              style={{
                position: 'fixed',
                left: installMenu.x,
                top: installMenu.y,
                width: 0,
                height: 0,
              }}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className={SKILL_INSTALL_MENU_WIDTH}>
            <SkillInstallMenuBody
              skill={installMenu.skill}
              actions={actions}
              onRunStart={() => setInstallMenu(null)}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <OkFileTree
        model={model}
        hostRef={hostRef}
        ready={ready}
        className="min-h-0"
        style={createFileTreeStyle(resolvedTheme)}
        sizeToContent
        titleForPath={titleForPath}
        renderContextMenu={(item, context) => {
          const node = parseTreePath(item.path);
          if (!rowHasContextMenu(node)) return null;
          const scope = labelToScope.get(node.scopeLabel);
          if (!scope) return null;
          let menuItems: ReactNode;
          if (node.skillDisplay === undefined) {
            // Scope row → scope description + New skill (creates a blank directly) /
            // Upload / Explore (each opens the add-skill modal on its tab).
            menuItems = (
              <>
                <DropdownMenuLabel className="max-w-56 whitespace-normal font-normal text-muted-foreground text-xs">
                  {scopeDescription[scope]}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onNewSkill(scope)}>
                  <SquarePen aria-hidden />
                  <Trans>New skill</Trans>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onAddSkill(scope, 'upload')}>
                  <Upload aria-hidden />
                  <Trans>Upload skill</Trans>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onAddSkill(scope, 'skills-sh')}>
                  <Compass aria-hidden />
                  <Trans>Explore skills</Trans>
                </DropdownMenuItem>
              </>
            );
          } else {
            const d = detectedFor(node);
            if (d) {
              // Detected skill row → open the editable in-place buffer (same as
              // clicking the row). No manage flow.
              menuItems = (
                <DropdownMenuItem onSelect={() => onOpenDetected(d)}>
                  <SquarePen aria-hidden />
                  <Trans>Edit</Trans>
                </DropdownMenuItem>
              );
            } else {
              const skill = skillFor(node);
              if (!skill) return null;
              if (skill.managed) return null; // managed built-in = read-only, no mutate menu
              if (node.sub === null || node.sub === SKILL_MD_PATH) {
                menuItems = (
                  <SkillContextMenuItems
                    skill={skill}
                    actions={actions}
                    existingNames={existingNames[skill.scope]}
                  />
                );
              } else if (node.isDir) {
                // Every bundle dir offers New file seeded with its own path.
                // `node.sub` is non-null here (the null case is handled above).
                menuItems = (
                  <DropdownMenuItem
                    onSelect={() => actions.requestFileCreate(skill, `${node.sub}/`)}
                  >
                    <Trans>New file</Trans>
                  </DropdownMenuItem>
                );
              } else {
                menuItems = (
                  <SkillFileContextMenuItems skill={skill} filePath={node.sub} actions={actions} />
                );
              }
            }
          }
          return (
            <DropdownMenu
              open
              modal={false}
              onOpenChange={(open) => {
                if (!open) context.close({ restoreFocus: false });
              }}
            >
              <DropdownMenuTrigger asChild>
                <span
                  aria-hidden="true"
                  data-file-tree-context-menu-root="true"
                  className="block size-px"
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                sideOffset={0}
                align="start"
                data-file-tree-context-menu-root="true"
                className="min-w-52"
              >
                {menuItems}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        }}
      />
    </>
  );
}

/**
 * Install-menu body for the sidebar Install pill — resolves one skill's per-agent
 * toggle state and renders the SHARED menu items (the exact menu the editor
 * toolbar badge shows). Split into its own component because `useSkillHostToggles`
 * is a hook that must mount only while a skill is selected.
 */
function SkillInstallMenuBody({
  skill,
  actions,
  onRunStart,
}: {
  skill: SkillsListEntry;
  actions: SkillActions;
  /** Close the popover before a multi-location run starts: the rows are read
   *  from a disk scan that refetches mid-run, so leaving it open shows them flip
   *  and then settle, which reads as breakage. */
  onRunStart: () => void;
}) {
  const toggles = useSkillHostToggles(skill, actions);
  return (
    <SkillInstallMenuItems
      toggles={toggles}
      skill={skill}
      onResolveFork={(editor) => actions.requestForkResolve(skill, editor)}
      onRunStart={onRunStart}
    />
  );
}

/**
 * Local-only skills-are-hidden prompt. In local-only mode the whole `.ok/`
 * tree is git-ignored, so `.ok/skills/` (shareable content) can't be committed
 * — the "skills silently can't be shared" trap. When project skills exist in
 * that state, offer a one-click carve-out that makes JUST `.ok/skills/`
 * shareable while the rest of `.ok/` stays local (via `sharing.setSkillsShared`).
 * Desktop-only (the sharing bridge is absent on the web host).
 */
function SkillsShareLocalOnlyPrompt({ hasProjectSkills }: { hasProjectSkills: boolean }) {
  const { t } = useLingui();
  // `localOnlyHidden` = local-only AND skills not yet carved out (the broken
  // state this prompt exists to fix). null = not yet read / not applicable.
  const [localOnlyHidden, setLocalOnlyHidden] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // useEffect runs client-side, so `window` is defined (oxlint no-restricted-syntax).
    const bridge = window.okDesktop?.sharing;
    if (!bridge) return;
    let cancelled = false;
    const read = () => {
      void bridge
        .status()
        .then((s) => {
          if (!cancelled) setLocalOnlyHidden(s.mode === 'local-only' && !s.skillsShared);
        })
        .catch((err) => {
          // Advisory read — degrade to hiding the prompt, but keep a signal so an
          // IPC regression isn't invisible (packaged desktop has no user console).
          console.warn(
            JSON.stringify({
              event: 'skills-share-status-read-failed',
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        });
    };
    read();
    // Re-read on window refocus so the banner tracks a sharing-mode change made
    // in Settings while the sidebar stayed mounted (closing that dialog refocuses
    // the window). Without this the mount-time read goes stale.
    window.addEventListener('focus', read);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', read);
    };
  }, []);

  if (!hasProjectSkills || localOnlyHidden !== true) return null;

  // No try/finally: this repo's React Compiler can't lower a finalizer clause,
  // so capture the result/error and settle `busy` after the await (mirrors
  // SharingSection's handler).
  const share = async () => {
    const bridge = window.okDesktop?.sharing;
    if (!bridge || busy) return;
    setBusy(true);
    let result: Awaited<ReturnType<typeof bridge.setSkillsShared>> | null = null;
    let err: unknown = null;
    try {
      result = await bridge.setSkillsShared(true);
    } catch (caught) {
      err = caught;
    }
    setBusy(false);
    if (err !== null) {
      // A wire-protocol violation surfaces as `ok:sharing:dispatch: ...` from the
      // preload — meaningless to end users, so show a generic message instead.
      const raw = err instanceof Error ? err.message : '';
      toast.error(
        raw.startsWith('ok:sharing:dispatch:')
          ? t`Couldn't share skills: internal error. Please restart the app.`
          : raw || t`Couldn't share skills`,
      );
      return;
    }
    if (result === null) return;
    if (result.kind === 'applied') {
      toast.success(t`Skills are now shared. Commit .ok/skills to share them with your team.`);
      setLocalOnlyHidden(false);
    } else if (result.kind === 'no-exclude') {
      // Map internal reason codes to plain English (mirrors SharingSection).
      const detail =
        result.reason === 'no-git'
          ? t`no git repository here`
          : result.reason === 'inaccessible'
            ? t`the git exclude file isn't writable`
            : t`git configuration is unavailable`;
      toast.warning(t`Couldn't share skills — ${detail}.`);
    }
  };

  return (
    <div className="mx-2 mb-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs dark:border-amber-700 dark:bg-amber-950">
      <p className="mb-2 text-amber-900 dark:text-amber-200">
        <Trans>
          This project is local-only, so .ok/skills is hidden from git and these skills can't be
          committed or shared. Share just the skills folder — the rest of your OK config stays on
          this computer.
        </Trans>
      </p>
      <Button size="sm" className="h-6 px-2 text-xs" disabled={busy} onClick={() => void share()}>
        <Trans>Share skills</Trans>
      </Button>
    </div>
  );
}
