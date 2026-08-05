/**
 * The Pierre `<OkFileTree>` half of the Skills sidebar, split out of
 * `SkillsSidebarSection.tsx`. The section owns data loading, dialogs and the
 * section chrome, and hands this everything it needs as props.
 *
 * `EMPTY_SCOPE_SENTINEL` lives here because `SKILLS_TREE_CSS` interpolates it;
 * the section imports it back, so the dependency runs section -> tree only.
 */
import type { CatalogSkill, SkillScope, SkillsListEntry } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { FILE_TREE_TAG_NAME, type FileTreeSortComparator } from '@pierre/trees';
import { useFileTree } from '@pierre/trees/react';
import { Compass, Sparkles, SquarePen, Upload } from 'lucide-react';
import { __iconNode as lockIcon } from 'lucide-react/dist/esm/icons/lock';
import { __iconNode as packageIcon } from 'lucide-react/dist/esm/icons/package';
import { useTheme } from 'next-themes';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { AgentBrandIcon } from '@/components/AgentIconCluster';
import { createFileTreeStyle } from '@/components/file-tree-density';
import {
  buildOkFileTreeOptions,
  createLucideSpriteSymbol,
  OK_FILE_TREE_READONLY_UNSAFE_CSS,
} from '@/components/file-tree-shared';
import type { AddSkillTab } from '@/components/ImportSkillDialog';
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
  SkillRevealMenuItem,
} from '@/components/skill-actions';
import {
  applyInstallClusters,
  HOST_POOL_KEY_ATTR,
  installPillFromEvent,
  type RowInstallDecor,
  SKILL_INSTALL_CLUSTER_CSS,
} from '@/components/skill-install-cluster';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { asDirectoryHandle } from '@/components/use-selection-mirror';
import {
  skillClusterHosts,
  skillDir,
  skillEntryDirs,
  skillHostRootDir,
  tildeHomePath,
} from '@/lib/skill-scope';
import { SKILL_MD_PATH } from '@/lib/skill-sort';

// A scope with ZERO skills renders no child, and Pierre drops a childless
// directory from the visible tree — so the GLOBAL / PROJECT header would vanish
// and the sibling scope slides to the top (breaks "project always first" when the
// project has no skills). Give an empty scope ONE sentinel child so its folder +
// header always render in SKILL_SCOPE_ORDER. The sentinel row is display:none'd
// (SKILLS_TREE_CSS) and every row handler skips it (skillFor/detectedFor return
// undefined for it). Underscores can't appear in a real skill name (SKILL_NAME_REGEX),
// so it can't collide. Works WITH `flattenEmptyDirectories: false` — that keeps the
// resulting single-child folder from collapsing back into the sentinel.
export const EMPTY_SCOPE_SENTINEL = '__ok_empty_scope__';

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
 * The single Pierre tree. Remounted by the parent on path/state changes so it
 * re-derives decorations; selection is synced imperatively (below) so opening a
 * doc never remounts. Owns the decoration / context-menu / selection wiring for
 * both managed and detected rows.
 */
export function SkillsTree({
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
                // Every bundle dir offers New file seeded with its own path,
                // plus the same Reveal its sibling file rows carry — a nested
                // folder is the one row kind that could not be opened on disk.
                // `node.sub` is non-null here (the null case is handled above).
                menuItems = (
                  <>
                    <SkillRevealMenuItem
                      absolutePath={
                        skill.absolutePath
                          ? `${skillDir(skill.absolutePath)}/${node.sub}`
                          : undefined
                      }
                    />
                    <DropdownMenuItem
                      onSelect={() => actions.requestFileCreate(skill, `${node.sub}/`)}
                    >
                      <Trans>New file</Trans>
                    </DropdownMenuItem>
                  </>
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
