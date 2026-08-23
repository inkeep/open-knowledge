/**
 * The Pierre `<OkFileTree>` half of the Skills sidebar, split out of
 * `SkillsSidebarSection.tsx`. The section owns data loading, dialogs and the
 * section chrome, and hands this everything it needs as props.
 *
 * `EMPTY_SCOPE_SENTINEL` is owned by the path builder that emits it; this file
 * imports it because the per-tree CSS interpolates it. The pinned section's
 * segment is translated, so it arrives as a prop rather than a constant.
 */
import type { CatalogSkill, SkillScope, SkillsListEntry } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { FILE_TREE_TAG_NAME, type FileTreeSortComparator } from '@pierre/trees';
import { useFileTree } from '@pierre/trees/react';
import {
  ArrowUpRight,
  Compass,
  Copy as CopyIcon,
  DownloadCloud,
  Eye,
  FilePlus,
  LibraryBig,
  Package,
  Pin,
  PinOff,
  Sparkles,
  SquarePen,
  Trash2,
  Upload,
} from 'lucide-react';
import { __iconNode as packageIcon } from 'lucide-react/dist/esm/icons/package';
import { useTheme } from 'next-themes';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AgentBrandIcon } from '@/components/AgentIconCluster';
import { createFileTreeStyle } from '@/components/file-tree-density';
import { revealActiveRow } from '@/components/file-tree-reveal';
import {
  buildOkFileTreeOptions,
  createLucideSpriteSymbol,
  OK_FILE_TREE_READONLY_UNSAFE_CSS,
} from '@/components/file-tree-shared';
import type { AddSkillTab } from '@/components/ImportSkillDialog';
import { OkFileTree } from '@/components/OkFileTree';
import { SkillBulkDeleteDialog } from '@/components/SkillBulkDeleteDialog';
import {
  GLOBAL_INSTALL_EDITORS,
  SKILL_INSTALL_MENU_WIDTH,
  SkillInstallMenuItems,
  useSkillHostToggles,
} from '@/components/SkillInstallMenu';
import {
  type SkillActions,
  SkillContextMenuItems,
  SkillFileContextMenuItems,
  SkillManagedContextMenuItems,
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
  applyProvenanceMarks,
  PROVENANCE_LIBRARY_POOL_KEY,
  PROVENANCE_PIN_POOL_KEY,
  PROVENANCE_PLUGIN_POOL_KEY,
  PROVENANCE_POOL_KEY_ATTR,
  type RowProvenanceMark,
  SKILL_PROVENANCE_MARK_CSS,
} from '@/components/skill-provenance-mark';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { asDirectoryHandle } from '@/components/use-selection-mirror';
import { useOpenSkill } from '@/hooks/use-open-skill';
import { openExternalUrl } from '@/lib/external-link';
import { scheduleClipboardWrite } from '@/lib/share/clipboard-adapter';
import { groupUpdatableSkills } from '@/lib/skill-group-update';
import {
  bucketForDetected,
  bucketForSkill,
  type ProvenanceBucket,
} from '@/lib/skill-provenance-bucket';
import {
  skillClusterHosts,
  skillDir,
  skillEntryDirs,
  skillHostRootDir,
  tildeHomePath,
} from '@/lib/skill-scope';
import { SKILL_MD_PATH } from '@/lib/skill-sort';
import { importSkill, moveSkillScope } from '@/lib/skills-api';
import { EMPTY_SCOPE_SENTINEL } from '@/lib/skills-tree-paths';

// The sentinel row is display:none'd (SKILLS_TREE_CSS) and every row handler
// skips it (skillFor/detectedFor return undefined for it). Works WITH
// `flattenEmptyDirectories: false` — that keeps the resulting single-child
// folder from collapsing back into the sentinel.

// Plugin-cache residents get a package glyph: "this is vendor state, editing it
// here makes a copy", with the way out in the tooltip. The only native Pierre
// decoration left — built-ins used to hold a lock here and no longer do, since
// read-only never barred installing them and the slot is better spent on the
// install cluster.
const PLUGIN_PACKAGE_ICON_ID = 'ok-skills-plugin-package-decoration';
const SKILLS_DECORATION_EXTRA_SYMBOLS = createLucideSpriteSymbol(
  PLUGIN_PACKAGE_ICON_ID,
  packageIcon,
);

// Per-tree CSS (Pierre `unsafeCSS`):
//  - Installed/Draft/Detected decoration badge: ~11px, right-aligned, never truncates.
//  - Focus ring only on the SELECTED (open) row, not a merely-focused one.
//  - Scope rows (top-level = aria-level 1): hidden folder icon + uppercase muted
//    text, so GLOBAL / PROJECT read as section labels rather than plain folders.
const skillsTreeCss = `
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
  /* Drop-target scope header while a skill drag hovers the other scope. After
     the selected-state transparent rule on purpose: equal specificity, later
     source order wins, so the highlight shows even on a selected scope row. */
  [aria-level='1'][data-ok-drop-scope='true'] {
    background-color: var(--accent) !important;
    color: var(--foreground) !important;
  }
`;

/**
 * The last primary-button row click, recorded at pointerdown and cleared the
 * moment ANY dispatcher handles it. Module scope on purpose: an install/import
 * remounts the tree several times in a row, and a click that lands mid-swap
 * dies with the old instance — its Pierre selection, its 250ms fallback timer,
 * everything. The record is what survives, so the next mount can complete the
 * click the user actually made. TTL-bounded; only ever written from a real
 * pointerdown, so completing it can never phantom-open (the selection-based
 * guess this replaces re-opened closed tabs and looped two navigations into a
 * Maximum-update-depth crash).
 */
let pendingRowOpen: { path: string; at: number } | null = null;
const PENDING_ROW_OPEN_TTL_MS = 3000;

/** Shift-range anchor — the last skill-root row pressed (plain or cmd/ctrl).
 *  Module scope for the same reason as {@link pendingRowOpen}: opening the
 *  anchor row remounts the tree, and a per-instance ref would forget the
 *  anchor before the shift-click that needs it. */
let rangeAnchor: string | null = null;
/** Moving end of the keyboard range (shift+arrow) — anchor stays put, the
 *  cursor walks. Reset whenever the anchor moves. */
let rangeCursor: string | null = null;

/** Open a short window in which Pierre selection events are ours, not the
 *  user's (event handlers may be impure; render-scoped closures may not, which
 *  is why these live at module scope). */
function suppressSelection(ref: { current: number }): void {
  ref.current = performance.now() + 50;
}
function selectionSuppressed(ref: { current: number }): boolean {
  return performance.now() < ref.current;
}

/**
 * A tree path split into its parts. Two shapes now share the tree:
 *
 *   `<ScopeLabel>/<skillDisplay>/<sub…>`             — ungrouped
 *   `<ScopeLabel>/<GroupId>/<skillDisplay>/<sub…>`   — inside a provenance group
 *
 * Position alone cannot tell them apart, because authored skills and flattened
 * singletons carry no group segment. So the parse consults `groupByPrefix` (the
 * builder's own record of which prefixes ARE groups) rather than counting
 * slashes — the same reason `skillByPrefix` is consulted instead of guessed.
 */
interface TreeNode {
  scopeLabel: string;
  /** Provenance group segment, or undefined when the row is not inside one. */
  group: string | undefined;
  /** undefined = the scope row itself; equal to `group` on a group row. */
  skillDisplay: string | undefined;
  /** path within the skill (SKILL.md, references/x, …); null = the skill folder. */
  sub: string | null;
  /** True when this path IS a group row rather than a skill inside one. */
  isGroupRow: boolean;
  /** True only inside a PROVENANCE group. */
  inProvenanceGroup: boolean;
  isDir: boolean;
}

function parseTreePath(
  treePath: string,
  groupByPrefix: ReadonlyMap<string, unknown> = new Map(),
): TreeNode {
  const isDir = treePath.endsWith('/');
  const clean = isDir ? treePath.slice(0, -1) : treePath;
  const parts = clean.split('/');
  const scopeLabel = parts[0] ?? '';
  const second = parts.length >= 2 ? parts[1] : undefined;
  const grouped = second !== undefined && groupByPrefix.has(`${scopeLabel}/${second}`);
  if (!grouped) {
    return {
      scopeLabel,
      group: undefined,
      skillDisplay: second,
      sub: parts.length >= 3 ? parts.slice(2).join('/') : null,
      isGroupRow: false,
      inProvenanceGroup: false,
      isDir,
    };
  }
  // Provenance can nest TWO levels — a repo/marketplace parent over its
  // pack/plugin child (`<scope>/<repo>/<pack>/<skill>/…`). `group` carries the
  // whole chain so `${scopeLabel}/${group}` still addresses the immediate
  // parent folder of the skill row, one level or two.
  const third = parts.length >= 3 ? parts[2] : undefined;
  const nested = third !== undefined && groupByPrefix.has(`${scopeLabel}/${second}/${third}`);
  const group = nested ? `${second}/${third}` : second;
  const skillIndex = nested ? 3 : 2;
  return {
    scopeLabel,
    group,
    skillDisplay: parts.length > skillIndex ? parts[skillIndex] : undefined,
    sub: parts.length > skillIndex + 1 ? parts.slice(skillIndex + 1).join('/') : null,
    isGroupRow: parts.length === (nested ? 3 : 2),
    inProvenanceGroup: true,
    isDir,
  };
}

/**
 * Pin / Unpin for one skill row.
 *
 * Its own component because three row kinds render it (managed, built-in,
 * detected) and the label has to flip on state — inlining it three times is how
 * two of them end up saying the wrong thing after a later edit.
 */
function PinMenuItem({
  scope,
  name,
  pinned,
  onToggle,
}: {
  scope: SkillScope;
  name: string;
  pinned: boolean;
  onToggle: (scope: SkillScope, name: string, pinned: boolean) => void;
}) {
  return (
    <DropdownMenuItem onSelect={() => onToggle(scope, name, !pinned)}>
      {pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
      {pinned ? <Trans>Unpin</Trans> : <Trans>Pin to top</Trans>}
    </DropdownMenuItem>
  );
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
  groupByPrefix,
  pinnedPrefixes,
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
  isPinned,
  onTogglePin,
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
  /** Which `<ScopeLabel>/<GroupId>` prefixes are provenance groups (see `parseTreePath`). */
  groupByPrefix: ReadonlyMap<string, ProvenanceBucket>;
  /** Row prefixes of pinned skills — the CSS marks them (glyph + edge). */
  pinnedPrefixes: ReadonlySet<string>;
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
  isPinned: (scope: SkillScope, name: string) => boolean;
  onTogglePin: (scope: SkillScope, name: string, pinned: boolean) => void;
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
    node.skillDisplay === undefined
      ? undefined
      : node.group === undefined
        ? `${node.scopeLabel}/${node.skillDisplay}`
        : `${node.scopeLabel}/${node.group}/${node.skillDisplay}`;
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
    const node = parseTreePath(treePath, groupByPrefix);
    // Scope header row (no skill name) → no path tooltip: skills at either
    // level live wherever their folder is (editor dirs or `.ok/skills`),
    // so a single store dir would lie. The header's context-menu label
    // carries the scope description instead.
    // Group row -> provenance, not the tree path: Pierre's default title reads
    // "Project/eng", which says nothing. The group exists BECAUSE these skills
    // share an upstream, so the hover names it (plugin, skills.sh source, or a
    // plain imported source). MUST run before the skillDisplay guard below — a
    // group row has no skill name, so the guard would swallow it.
    if (node.isGroupRow) {
      const bucket = node.group ? groupByPrefix.get(`${node.scopeLabel}/${node.group}`) : undefined;
      if (!bucket) return null;
      if (bucket.kind === 'plugin') {
        return bucket.url ? t`${bucket.id} plugin · ${bucket.url}` : t`${bucket.id} plugin`;
      }
      const source = bucket.publisher ? `${bucket.publisher}/${bucket.id}` : bucket.id;
      return bucket.url ? t`${source} · skills.sh source` : t`${source} · imported source`;
    }
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
  /**
   * The tracked skills nested under a group row that an update can actually
   * refresh.
   *
   * Built-ins are IN, deliberately. They are not on a separate cadence: each
   * carries an ordinary lock entry naming `inkeep/open-knowledge-skills` and the
   * per-skill Update already refreshes them through the same endpoint, so a
   * group update that skipped them would leave most of that group untouched
   * while claiming to have updated it. Their read-only-ness is about editing
   * them here, which this is not.
   *
   * Out: plugin groups, whose members are vendor state that refreshes when the
   * plugin does — a copy you made out of one is individually updatable, but the
   * group row still speaks for the vendor's set. Out too: detected rows (OK does
   * not track them, so there is no recorded upstream), and `adopt:<harness>`
   * copies, whose "source" is another editor's folder rather than a fetchable
   * remote — the same exclusion `canReimport` makes for the per-skill button.
   */
  const updatableForNode = (node: TreeNode): SkillsListEntry[] => {
    if (!node.isGroupRow || node.group === undefined) return [];
    const groupPrefix = `${node.scopeLabel}/${node.group}`;
    return groupUpdatableSkills({
      groupPrefix,
      bucket: groupByPrefix.get(groupPrefix),
      skillByPrefix,
    });
  };
  // Whether a row gets a context menu at all. Built-in (managed) skills are
  // read-only — no mutate menu — and neither are their bundle files or nested
  // folders. `renderContextMenu` returns null for exactly these; this predicate
  // MUST mirror it (kept adjacent so they change together), and the hover `···`
  // trigger is suppressed for rows where it is false (§2.1/§2.2).
  const rowHasContextMenu = (node: TreeNode): boolean => {
    const scope = labelToScope.get(node.scopeLabel);
    if (!scope) return false;
    // A provenance group is a derived view, not a place: nothing is created in
    // one and nothing is dropped into one. Its one action is updating every
    // member from the source it names (when it has updatable members), plus
    // the group's own identity: what this plugin/source is and a link to it.
    // A known bucket is enough to earn the menu even when nothing is
    // updatable — a plugin group's members are vendor state, but the group
    // row still answers "what is this and where does it come from".
    if (node.isGroupRow)
      return (
        updatableForNode(node).length > 0 ||
        (node.group !== undefined && groupByPrefix.has(`${node.scopeLabel}/${node.group}`))
      );
    if (node.skillDisplay === undefined) return true; // scope row → New / Upload / Explore
    if (detectedFor(node)) return true; // detected → Edit + Pin
    const skill = skillFor(node);
    if (!skill) return false;
    // A built-in is read-only, but pinning is not a mutation of the skill — it is
    // a view preference — and built-ins are exactly the rows a crowded library
    // buries. So they earn a menu, but only on the skill's OWN row: the renderer
    // has nothing to offer for a built-in's bundle files, and a predicate that
    // said yes for those put a hover `···` on rows whose menu opens nothing.
    if (skill.managed) return node.sub === null;
    return true; // skill row, SKILL.md, a bundle folder (New file), or a file
  };
  /**
   * The leading provenance mark for a row, or null.
   *
   * Only the row that NAMES a source carries it. That is the group row when a
   * bucket grouped, and the skill row itself when a bucket of one collapsed onto
   * it. A member inside a group gets nothing — the group above already said where
   * it came from, and repeating it down the list is noise.
   */
  const markFromBucket = (
    bucket: ProvenanceBucket | null,
    isGroupRow: boolean,
  ): RowProvenanceMark => {
    if (!bucket) return null;
    if (bucket.kind === 'plugin') {
      // A plugin resident ALREADY carries a package glyph: the native row
      // decoration, which is also the row's read-only signal and holds the
      // "open it to edit a copy" tooltip. So the leading mark is the GROUP
      // row's alone — on a flattened singleton it would be the same fact,
      // same glyph, twice on one row. A PACK row is different: it has no
      // native decoration, so a flattened one falls back to its parent
      // source's mark rather than showing nothing.
      if (!isGroupRow) {
        if (!bucket.parent) return null;
        const parentAsBucket: ProvenanceBucket = {
          kind: 'source',
          id: bucket.parent.id,
          publisher: bucket.parent.publisher,
          url: bucket.parent.url,
        };
        return markFromBucket(parentAsBucket, false);
      }
      // Named placeholder, not a template expression: it makes this the SAME
      // msgid the plugin banner already ships, so all eleven locales carry it.
      const plugin = bucket.id;
      // Linked when the harness registry recorded a repo for the marketplace.
      // A plugin that doesn't know its own repo borrows its parent tier's —
      // a marketplace plugin lives in the marketplace's repo. A
      // directory-installed marketplace has neither, and that row stays a label.
      const url = bucket.url ?? bucket.parent?.url ?? null;
      if (url === null) return { kind: 'plugin', title: t`Part of the ${plugin} plugin` };
      return { kind: 'plugin', title: t`View the ${plugin} plugin repo`, href: url };
    }
    const publisher = bucket.publisher;
    // A source group with no resolvable avatar still marks its row: the
    // distribution tier reads as a tier, not a bare folder. Linked when the
    // bucket knows its page.
    if (!publisher) {
      if (!isGroupRow) return null;
      const source = bucket.id;
      return {
        kind: 'library',
        title: bucket.url ? t`${source} · skills.sh source` : t`${source} · imported source`,
        ...(bucket.url === null ? {} : { href: bucket.url }),
      };
    }
    // Linked when the source is skills.sh-addressable, which is the whole reason
    // the mark is worth clicking: it goes to the page listing everything else
    // that source publishes. A local path or a bare git URL has no such page and
    // stays a label rather than a link that lands nowhere useful.
    const title =
      bucket.url === null ? t`Published by ${publisher}` : t`View ${publisher} on skills.sh`;
    return {
      kind: 'publisher',
      login: publisher,
      title,
      ...(bucket.url === null ? {} : { href: bucket.url }),
    };
  };
  const markForPath = (treePath: string): RowProvenanceMark => {
    const node = parseTreePath(treePath, groupByPrefix);
    // A pinned row's leading mark IS the pin — that answers "why is this row
    // first", which on the floated twin outranks where it came from.
    if (
      !node.inProvenanceGroup &&
      node.skillDisplay !== undefined &&
      node.sub === null &&
      pinnedPrefixes.has(`${node.scopeLabel}/${node.skillDisplay}`)
    ) {
      return { kind: 'pin', title: t`Pinned` };
    }
    if (node.isGroupRow) {
      return markFromBucket(groupByPrefix.get(`${node.scopeLabel}/${node.group}`) ?? null, true);
    }
    // Inside a group, or not a skill's own row. `sub !== null` is every bundle
    // file INCLUDING `SKILL.md`: it is the skill's child row, not the skill, and
    // marking it repeated the source glyph one level down on every open skill.
    if (node.inProvenanceGroup || node.skillDisplay === undefined) return null;
    if (node.sub !== null) return null;
    const skill = skillFor(node);
    if (skill) return markFromBucket(bucketForSkill(skill), false);
    const d = detectedFor(node);
    return markFromBucket(d ? bucketForDetected(d) : null, false);
  };

  // Latest predicate for the shadow-root observer below, without re-subscribing
  // the observer every render (its closure identity changes with `skills` /
  // `detected`). Updated in an effect — never mutate a ref during render.
  const rowHasContextMenuRef = useRef(rowHasContextMenu);
  useEffect(() => {
    rowHasContextMenuRef.current = rowHasContextMenu;
  });
  // Same treatment for the group map: the builder mints a fresh Map every render,
  // so declaring it as an effect dependency would re-subscribe the shadow-root
  // observer (and re-run the selection sync) on every keystroke elsewhere.
  const groupByPrefixRef = useRef(groupByPrefix);
  useEffect(() => {
    groupByPrefixRef.current = groupByPrefix;
  });
  const labelToScopeRef = useRef(labelToScope);
  useEffect(() => {
    labelToScopeRef.current = labelToScope;
  });
  // Ordered skill-root rows (tree order), for shift-click range selection.
  // Filtered to rows the multi-set accepts (real, non-detected entries), so a
  // range can never sweep in a group header, a bundle file, or a read-only row.
  const skillRowOrderRef = useRef<readonly string[]>([]);
  useEffect(() => {
    // `paths` holds the FILE entries (`…/SKILL.md`, bundle files) — the dir
    // rows Pierre renders are derived, so the skill-ROOT paths are
    // reconstructed from each entry's parsed parts and deduped in order.
    const order: string[] = [];
    const seen = new Set<string>();
    for (const p of paths) {
      const node = parseTreePath(p, groupByPrefix);
      if (node.skillDisplay === undefined || node.isGroupRow) continue;
      // Read-only (detected/plugin) rows ARE selectable — a range that halts
      // at the first plugin row reads as broken. Only the drag/move step
      // filters to movable entries.
      if (skillFor(node) === undefined && detectedFor(node) === undefined) continue;
      const parent =
        node.group === undefined ? node.scopeLabel : `${node.scopeLabel}/${node.group}`;
      const root = `${parent}/${node.skillDisplay}/`;
      if (!seen.has(root)) {
        seen.add(root);
        order.push(root);
      }
    }
    skillRowOrderRef.current = order;
  });

  // Per-row install decoration for the imperative injector: an agent-icon cluster
  // (installed → its editors; detected → its harnesses) or an Install pill
  // (uninstalled). Built-ins take the cluster like anything else, but never the
  // pill — see below.
  const poolKeyFor = (id: string): string =>
    (GLOBAL_INSTALL_EDITORS as readonly string[]).includes(id) ? id : 'generic';
  const decorForPath = (treePath: string): RowInstallDecor => {
    const node = parseTreePath(treePath, groupByPrefix);
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
    if (!skill) return null;
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
    // Installed nowhere. An ordinary skill offers the Install pill; a built-in
    // shows nothing at all, which is the honest rendering — it ships with the
    // app and is present regardless, so a pill would imply the row is inert
    // until you act. Choosing where it loads is on the row's menu instead.
    if (skill.managed) return null;
    return { kind: 'install', title: t`Install ${skill.name}` };
  };
  // Drag eligibility for scope-move DnD: a skill ROOT row backed by a real
  // list entry that is not managed. Plugin residents and other detected rows
  // resolve through `detectedFor`, never `skillFor`, so read-only rows are
  // structurally excluded rather than filtered.
  const draggableEntryFor = (treePath: string): SkillsListEntry | null => {
    const node = parseTreePath(treePath, groupByPrefix);
    if (node.skillDisplay === undefined || node.sub !== null || node.isGroupRow) return null;
    // Detected wins over the list entry, same precedence as the context menu:
    // a plugin resident can ALSO have a list entry behind it, and the row the
    // user sees is the read-only detected face — it must not drag.
    if (detectedFor(node)) return null;
    const skill = skillFor(node);
    return skill && !skill.managed ? skill : null;
  };
  // Live inputs for the injection observer, which is set up once but must see the
  // latest skills/theme/callbacks. Never mutate a ref during render.
  const injectInputsRef = useRef({
    decorForPath,
    skillFor,
    detectedFor,
    markForPath,
    draggableEntryFor,
    installLabel: t`Install`,
  });
  useEffect(() => {
    injectInputsRef.current = {
      decorForPath,
      skillFor,
      detectedFor,
      markForPath,
      draggableEntryFor,
      installLabel: t`Install`,
    };
  });
  // The tree does NOT remount when the active doc changes (remount key excludes
  // `activePath` — see stateKey), so an inline `onSelectionChange` would close over a
  // STALE `activePath` frozen at the tree's last mount and wrongly bail (or fail to
  // bail) the "don't re-dispatch the already-active row" check. Keep the real handler
  // in a ref reassigned every render (so it captures the LIVE `activePath` + open
  // callbacks) and hand the tree a stable pass-through — the same pattern OkFileTree
  // uses. Manual memo (useCallback) is banned, so the ref is how we stay current.
  const handleSelectionChangeRef = useRef<(selected: readonly string[]) => void>(() => {});
  const sweptModelRef = useRef<unknown>(null);

  const { model } = useFileTree({
    ...buildOkFileTreeOptions({
      paths,
      initialExpansion: 'closed',
      initialExpandedPaths,
      initialSelectedPaths: activePath ? [activePath] : undefined,
      stickyFolders: false,
      enableContextMenu: true,
      unsafeCSS: `${OK_FILE_TREE_READONLY_UNSAFE_CSS}\n${skillsTreeCss}\n${SKILL_INSTALL_CLUSTER_CSS}\n${SKILL_PROVENANCE_MARK_CSS}`,
      extraSpriteSymbols: SKILLS_DECORATION_EXTRA_SYMBOLS,
      renderRowDecoration: ({ item }) => {
        const node = parseTreePath(item.path, groupByPrefix);
        // Only a skill folder row (has a display name, no sub) gets a decoration.
        if (node.skillDisplay === undefined || node.sub !== null) return null;
        // A built-in carries NO lock. Read-only is an edit gate, not a lifecycle
        // one — the server treats install/uninstall on these as ordinary — so a
        // lock overstated it, and it occupied the slot where the row should say
        // the more useful thing: which harnesses actually load this skill. The
        // agent-icon cluster below now answers that for built-ins like anything
        // else; the read-only fact still shows where it bites, on the document
        // banner when you open one.
        const det = detectedFor(node);
        // Inside a plugin group the header row already carries the package
        // glyph, so repeating it on every member is the same fact six rows
        // running. The read-only affordance is unchanged either way — the row
        // opens a copy on edit regardless of what decorates it.
        if (det?.provenance.plugin !== undefined && !node.inProvenanceGroup) {
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
  // Deliberately a PASSIVE effect, not `useLayoutEffect`. Installing the handler
  // before paint also puts it in front of Pierre's own mount-time selection,
  // which then dispatches an open nobody asked for and pushes a history entry —
  // `goBack` walks duplicates instead of leaving the skill
  // (`navigation-history.e2e.ts`). The no-op window this leaves open is real but
  // narrow, and a spurious open is the worse trade.
  // Drop Pierre's own selection right after a click has been dispatched.
  //
  // Pierre emits a selection change only when the selected row CHANGES, so a row
  // it already holds selected swallows every further click on it. An open that
  // never lands leaves exactly that state — the row stays selected, `activePath`
  // never moves onto it (it requires a genuinely open tab), and the obvious
  // retry does nothing until the user clicks some other skill and comes back.
  // Releasing the selection here keeps the row clickable; the selection-sync
  // effect below re-asserts it the moment the doc actually lands, so a normal
  // open is unchanged and only the dead-row case behaves differently.
  const releaseSelection = (path: string) => model.getItem(path)?.deselect();

  // Declared before the capture handler below that reads it (the reconcile
  // effects further down share it).
  const activePathRef = useRef(activePath);
  useEffect(() => {
    activePathRef.current = activePath;
  });

  // Multi-selection: cmd/ctrl-click gathers SKILL ROOT rows (managed entries
  // only — the rows the bulk verbs can act on) into a set without opening
  // anything. Held in React state for the menu render, mirrored in a ref for
  // the imperative handlers, and reflected into Pierre per-item selection for
  // the highlight. Any plain selection event clears it — Pierre replaces the
  // selection on an unmodified click anyway, so the set must follow.
  const [multiSelected, setMultiSelected] = useState<ReadonlySet<string>>(new Set());
  const multiSelectedRef = useRef(multiSelected);
  useEffect(() => {
    multiSelectedRef.current = multiSelected;
  });
  // Suppression window: our own item.select()/deselect() calls make Pierre
  // emit selection events, and the selection handler treats any Pierre event
  // as an unmodified gesture (clearing the multi-set / dispatching an open).
  // Pierre emits synchronously, so a short timestamp window after each
  // programmatic mutation cleanly covers them without the miscount risk a
  // consume-once counter has when select() on an already-selected row emits
  // nothing.
  const suppressSelectionEventsUntilRef = useRef(0);
  const clearMultiSelection = () => {
    const held = multiSelectedRef.current;
    multiSelectedRef.current = new Set();
    suppressSelection(suppressSelectionEventsUntilRef);
    for (const p of held) {
      if (p !== activePath) releaseSelection(p);
    }
    if (held.size > 0) setMultiSelected(new Set());
  };
  const [bulkDelete, setBulkDelete] = useState<SkillsListEntry[] | null>(null);
  const openSkill = useOpenSkill();
  // "Edit a copy" on a plugin resident row: import the cached bundle into the
  // chosen scope (no install — the copy's own menu handles that) and open the
  // editable result. Same implied-import contract as the preview tab's button.
  async function editPluginCopy(d: CatalogSkill, toScope: SkillScope) {
    const res = await importSkill({
      source: skillDir(d.files.skillMd),
      skill: d.name,
      scope: toScope,
      install: false,
    });
    if (!res.ok) {
      const detail = res.error;
      toast.error(t`Couldn't copy: ${detail}`);
      return;
    }
    openSkill(toScope, res.name);
  }
  // Sequential like every other multi-skill run — the placements ledger is a
  // read-modify-write that concurrent moves would clobber. Failures toast per
  // name; one aggregate toast closes the run.
  async function bulkMoveScope(entries: readonly SkillsListEntry[], toScope: SkillScope) {
    let moved = 0;
    for (const s of entries) {
      const r = await moveSkillScope({ name: s.name, fromScope: s.scope, toScope });
      if (r.ok) moved += 1;
      else toast.error(t`Couldn't move ${s.name}: ${r.error}`);
    }
    if (moved > 0) {
      toast.success(
        toScope === 'global'
          ? t`Moved ${moved} skills to Global`
          : t`Moved ${moved} skills to Project`,
      );
    }
    clearMultiSelection();
  }
  // Latest closure for the shadow-root drag handlers (same reason as the other
  // handler refs: the listeners wire once per tree mount).
  const bulkMoveScopeRef = useRef(bulkMoveScope);
  useEffect(() => {
    bulkMoveScopeRef.current = bulkMoveScope;
  });

  // Was the click that produced this selection on the disclosure CHEVRON?
  // Pierre selects the row on any click, chevron included, and a selection on a
  // skill row opens its doc — so expanding a skill's folder also navigated to
  // the skill. The chevron is an expansion affordance, not the row: consume-once
  // flag set on pointerdown (capture, inside the shadow root), read and reset by
  // the selection handler. Keyboard opens never set it, so Enter still opens.
  const chevronPointerRef = useRef(false);
  // Monotonic count of selection events Pierre actually delivered. The click
  // fallback below compares snapshots of this to detect a click Pierre
  // swallowed entirely (selection unchanged → no event → no open — the
  // repeatedly-reported "row is dead until I click another skill" class).
  const selectionEventCountRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: model.getItem / releaseSelection are per-render closures over the stable tree model; the shadow-root listeners wire once per tree mount (`ready`), not per render.
  useEffect(() => {
    if (!ready) return;
    const shadow = hostRef.current?.querySelector(FILE_TREE_TAG_NAME)?.shadowRoot;
    if (!shadow) return;
    // Cmd/ctrl-click = selection toggle, never an open. Resolve the clicked
    // row; a skill-root row (managed entry, not a group/scope/file row) toggles
    // in and out of the multi-set, and BOTH the pointerdown and the click are
    // swallowed before Pierre sees them — otherwise Pierre would replace its
    // selection and dispatch the open this gesture exists to avoid.
    const skillRootPathAt = (e: Event): string | null => {
      const row = (e.target as HTMLElement | null)?.closest?.(
        '[data-item-path]',
      ) as HTMLElement | null;
      const path = row?.getAttribute('data-item-path');
      if (!path) return null;
      const node = parseTreePath(path, groupByPrefixRef.current);
      if (node.skillDisplay === undefined || node.sub !== null || node.isGroupRow) return null;
      if (!injectInputsRef.current.skillFor(node) && !injectInputsRef.current.detectedFor(node))
        return null;
      return path;
    };
    const multiToggleTarget = (e: Event): string | null => {
      if (!(e instanceof MouseEvent) || !(e.metaKey || e.ctrlKey)) return null;
      return skillRootPathAt(e);
    };
    const shiftRangeTarget = (e: Event): string | null => {
      if (!(e instanceof MouseEvent) || !e.shiftKey || e.metaKey || e.ctrlKey) return null;
      return skillRootPathAt(e);
    };
    // Set when pointerdown consumed the gesture (cmd toggle or shift range),
    // so the paired click is swallowed too. Reset at every pointerdown, so a
    // gesture whose click never arrives (a drag) cannot swallow a later one.
    let gestureHandled = false;
    const applyMultiSelection = (next: Set<string>) => {
      // Ref BEFORE the Pierre mutation: select()/deselect() notify model
      // subscribers synchronously, and the wedge sweep consults this ref —
      // waiting for the React commit would let the sweep unwind the gesture.
      multiSelectedRef.current = next;
      setMultiSelected(next);
      suppressSelection(suppressSelectionEventsUntilRef);
      for (const p of model.getSelectedPaths()) {
        if (!next.has(p) && p !== activePathRef.current) releaseSelection(p);
      }
      for (const p of next) model.getItem(p)?.select();
    };
    const onPointerDown = (e: Event) => {
      gestureHandled = false;
      const target = e.target as HTMLElement | null;
      chevronPointerRef.current = target?.closest?.("[data-item-section='icon']") != null;
      // Record every plain primary row press so a mid-remount click can be
      // completed by the next mount (see `pendingRowOpen`). Chevron presses
      // are expansion, not opens; modifier presses are selection gestures.
      if (
        e instanceof MouseEvent &&
        e.button === 0 &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.shiftKey &&
        !chevronPointerRef.current
      ) {
        const rowPath = target?.closest?.('[data-item-path]')?.getAttribute('data-item-path');
        if (rowPath) {
          pendingRowOpen = { path: rowPath, at: performance.now() };
          // A plain press on a skill row moves the shift-range anchor,
          // file-manager style.
          if (skillRootPathAt(e) !== null) {
            rangeAnchor = rowPath;
            rangeCursor = null;
          }
        }
      }
      // Shift-click = contiguous range from the anchor, replacing the held
      // set. Constrained to the anchor's scope: Project and Global are
      // different lifecycles, and a cross-boundary sweep would silently make
      // the selection unmovable.
      const rangeEnd = shiftRangeTarget(e);
      if (rangeEnd !== null && rangeAnchor !== null) {
        const order = visibleSkillRowOrder();
        const a = order.indexOf(rangeAnchor);
        const b = order.indexOf(rangeEnd);
        if (a !== -1 && b !== -1) {
          e.preventDefault();
          e.stopImmediatePropagation();
          gestureHandled = true;
          rangeCursor = rangeEnd;
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          const anchorScope = rangeAnchor.split('/')[0];
          const next = new Set(
            order.slice(lo, hi + 1).filter((p) => p.split('/')[0] === anchorScope),
          );
          applyMultiSelection(next);
          return;
        }
      }
      const togglePath = multiToggleTarget(e);
      if (togglePath === null) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      gestureHandled = true;
      rangeAnchor = togglePath;
      rangeCursor = null;
      const next = new Set(multiSelectedRef.current);
      const adding = !next.has(togglePath);
      if (adding) next.add(togglePath);
      else next.delete(togglePath);
      multiSelectedRef.current = next;
      setMultiSelected(next);
      suppressSelection(suppressSelectionEventsUntilRef);
      if (adding) model.getItem(togglePath)?.select();
      else if (togglePath !== activePathRef.current) releaseSelection(togglePath);
    };
    const onModifierClick = (e: Event) => {
      if (!gestureHandled) return;
      gestureHandled = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    // Belt-and-suspenders open: Pierre only emits selection events on CHANGE,
    // so a row that is already (or silently became) selected swallows clicks.
    // Watch every primary-button row click at capture; if NO selection event
    // arrives shortly after, dispatch the open directly from the clicked path.
    // The normal path stays Pierre's — this only fires when Pierre stayed
    // silent, so it cannot double-open.
    const timers: ReturnType<typeof setTimeout>[] = [];
    const onClick = (e: Event) => {
      if (!(e instanceof MouseEvent) || e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("[data-item-section='icon']") != null) return; // chevron: expand only
      const row = target?.closest?.('[data-item-path]') as HTMLElement | null;
      const path = row?.getAttribute('data-item-path');
      if (!path) return;
      const seen = selectionEventCountRef.current;
      timers.push(
        setTimeout(() => {
          if (selectionEventCountRef.current !== seen) return; // Pierre handled it
          chevronPointerRef.current = false;
          handleSelectionChangeRef.current([path]);
        }, 250),
      );
    };
    // Shift+Arrow extends the range from the anchor, one skill row at a time —
    // the keyboard half of shift-click. Capture-phase so Pierre's own focus
    // walk doesn't consume the key first.
    // Range walks follow what the user SEES: the logical order includes
    // children of collapsed provenance groups, so a cursor stepping through
    // it silently disappears into rows that aren't rendered. The DOM is the
    // visibility truth — intersect it with the known skill roots.
    const visibleSkillRowOrder = (): readonly string[] => {
      const valid = new Set(skillRowOrderRef.current);
      const out: string[] = [];
      for (const el of shadow.querySelectorAll('[data-item-path]')) {
        const path = el.getAttribute('data-item-path');
        if (path !== null && valid.has(path)) out.push(path);
      }
      return out.length > 0 ? out : skillRowOrderRef.current;
    };
    const onKeyDown = (e: Event) => {
      if (!(e instanceof KeyboardEvent) || !e.shiftKey) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      // Window-level (the swallowed shift-click leaves DOM focus outside the
      // tree). Act when a multi-selection is live OR the tree itself holds
      // focus (the just-clicked-a-row case, where shift+arrow starts
      // extending from that single row) — and never when the key is headed
      // for an editable surface, where shift+arrow is text selection.
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('[contenteditable], input, textarea, [role="textbox"]')) return;
      const treeFocused = hostRef.current?.contains(document.activeElement);
      if (multiSelectedRef.current.size === 0 && !treeFocused) return;
      // A plain row click already set the anchor; a keyboard-only walk seeds
      // it from the open row so the first Shift+Down extends from there.
      if (rangeAnchor === null && activePathRef.current !== undefined) {
        const activeNode = parseTreePath(activePathRef.current, groupByPrefixRef.current);
        if (activeNode.skillDisplay !== undefined) {
          const parent =
            activeNode.group === undefined
              ? activeNode.scopeLabel
              : `${activeNode.scopeLabel}/${activeNode.group}`;
          rangeAnchor = `${parent}/${activeNode.skillDisplay}/`;
          rangeCursor = null;
        }
      }
      if (rangeAnchor === null) return;
      // Scope-bounded BEFORE indexing: with the full order the cursor can walk
      // past the scope's last row into the other scope's (filtered-out) rows,
      // where further presses look dead until it wanders back.
      const anchorScope = rangeAnchor.split('/')[0];
      const order = visibleSkillRowOrder().filter((p) => p.split('/')[0] === anchorScope);
      const a = order.indexOf(rangeAnchor);
      if (a === -1) return;
      const cur =
        rangeCursor !== null && order.indexOf(rangeCursor) !== -1 ? order.indexOf(rangeCursor) : a;
      const nextIdx = Math.min(
        Math.max(cur + (e.key === 'ArrowDown' ? 1 : -1), 0),
        order.length - 1,
      );
      e.preventDefault();
      e.stopImmediatePropagation();
      rangeCursor = order[nextIdx] as string;
      const [lo, hi] = a <= nextIdx ? [a, nextIdx] : [nextIdx, a];
      applyMultiSelection(new Set(order.slice(lo, hi + 1)));
    };
    shadow.addEventListener('pointerdown', onPointerDown, true);
    shadow.addEventListener('click', onModifierClick, true);
    shadow.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      shadow.removeEventListener('pointerdown', onPointerDown, true);
      shadow.removeEventListener('click', onModifierClick, true);
      shadow.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKeyDown, true);
      for (const t of timers) clearTimeout(t);
    };
  }, [ready]);

  // Drag a skill between Project and Global. Only editable rows drag (the
  // injection pass stamps `draggable`, and dragstart re-checks — a read-only
  // row can neither start a drag nor ride along in a multi-select drag).
  // Dropping anywhere inside the OTHER scope's subtree moves; the scope header
  // lights up so the target is unambiguous. Reuses the bulk mover, so a
  // multi-select drag moves the whole held set with the same toasts the menu
  // verb produces.
  const dragStateRef = useRef<{ entries: SkillsListEntry[]; fromScope: SkillScope } | null>(null);
  useEffect(() => {
    if (!ready) return;
    const shadow = hostRef.current?.querySelector(FILE_TREE_TAG_NAME)?.shadowRoot;
    if (!shadow) return;
    const rowPathAt = (e: Event): string | null =>
      (
        (e.target as HTMLElement | null)?.closest?.('[data-item-path]') as HTMLElement | null
      )?.getAttribute('data-item-path') ?? null;
    const clearHighlight = () => {
      for (const el of shadow.querySelectorAll('[data-ok-drop-scope]')) {
        el.removeAttribute('data-ok-drop-scope');
      }
    };
    // The scope the hovered row belongs to, when it differs from the drag's
    // origin — the only drop that means anything.
    const dropScopeAt = (e: Event): { scope: SkillScope; label: string } | null => {
      const drag = dragStateRef.current;
      const p = rowPathAt(e);
      if (!drag || !p) return null;
      const node = parseTreePath(p, groupByPrefixRef.current);
      const scope = labelToScopeRef.current.get(node.scopeLabel);
      if (scope === undefined || scope === drag.fromScope) return null;
      return { scope, label: node.scopeLabel };
    };
    const onDragStart = (e: Event) => {
      if (!(e instanceof DragEvent)) return;
      const p = rowPathAt(e);
      const entry = p !== null ? injectInputsRef.current.draggableEntryFor(p) : null;
      if (p === null || entry === null) {
        e.preventDefault();
        return;
      }
      let entries = [entry];
      const multi = multiSelectedRef.current;
      if (multi.has(p) && multi.size > 1) {
        // A range may hold read-only (plugin/detected) rows — move the movable
        // members and leave the rest selected in place.
        const held = [...multi]
          .map((mp) => injectInputsRef.current.draggableEntryFor(mp))
          .filter((s): s is SkillsListEntry => s !== null && s.scope === entry.scope);
        if (held.length > 1) entries = held;
      }
      dragStateRef.current = { entries, fromScope: entry.scope };
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', entries.map((s) => s.name).join(', '));
      }
    };
    const onDragOver = (e: Event) => {
      if (!(e instanceof DragEvent)) return;
      const target = dropScopeAt(e);
      clearHighlight();
      if (target === null) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      shadow
        .querySelector<HTMLElement>(`[data-item-path="${target.label}/"]`)
        ?.setAttribute('data-ok-drop-scope', 'true');
    };
    const onDrop = (e: Event) => {
      const drag = dragStateRef.current;
      const target = dropScopeAt(e);
      clearHighlight();
      dragStateRef.current = null;
      if (!drag || target === null) return;
      e.preventDefault();
      e.stopPropagation();
      void bulkMoveScopeRef.current(drag.entries, target.scope);
    };
    const onDragEnd = () => {
      clearHighlight();
      dragStateRef.current = null;
    };
    shadow.addEventListener('dragstart', onDragStart, true);
    shadow.addEventListener('dragover', onDragOver, true);
    shadow.addEventListener('drop', onDrop, true);
    shadow.addEventListener('dragend', onDragEnd, true);
    return () => {
      shadow.removeEventListener('dragstart', onDragStart, true);
      shadow.removeEventListener('dragover', onDragOver, true);
      shadow.removeEventListener('drop', onDrop, true);
      shadow.removeEventListener('dragend', onDragEnd, true);
    };
  }, [ready]);

  useEffect(() => {
    // A click can land in the no-op window BEFORE this handler installs (the
    // install is deliberately post-paint — see above). Such a click selects
    // its row without dispatching an open, and Pierre only emits selection
    // events on CHANGE, so every further click on that row is swallowed — the
    // row reads as dead until the user clicks some other skill. The window is
    // WIDEST right after an install/import: the list changes remount the tree
    // several times in a row, which is when people click the skill they just
    // installed and hit a dead row.
    //
    // Sweep the wedge on install. A single wedged row that is neither the
    // active row nor part of the held multi-selection can only be a user click
    // this window swallowed — nothing else selects a non-active row at mount
    // (the selection-sync asserts the ACTIVE row; multi-select members are in
    // `multiSelectedRef`) — so COMPLETE that click by dispatching its open
    // instead of losing it. Anything else (several rows, a multi-select
    // member) is released so the next click dispatches normally.
    // Release wedged selections so the next click on them dispatches again
    // (Pierre only emits on CHANGE). Completion of an interrupted click comes
    // from the explicit `pendingRowOpen` record below — never inferred from
    // selection state, which the selection-sync also writes.
    const wedged = (model.getSelectedPaths?.() ?? []).filter((sel) => sel !== activePath);
    for (const sel of wedged) {
      if (!multiSelectedRef.current.has(sel)) releaseSelection(sel);
    }
    const firstSweepForThisMount = sweptModelRef.current !== model;
    sweptModelRef.current = model;
    const swallowedClick =
      firstSweepForThisMount &&
      pendingRowOpen !== null &&
      performance.now() - pendingRowOpen.at < PENDING_ROW_OPEN_TTL_MS &&
      pendingRowOpen.path !== activePath
        ? pendingRowOpen.path
        : null;
    handleSelectionChangeRef.current = (selected) => {
      selectionEventCountRef.current += 1;
      // This dispatcher is handling the click (Pierre event, 250ms fallback,
      // or the pending-click completion below) — consume the record so it can
      // complete at most once.
      if (pendingRowOpen !== null && selected[0] === pendingRowOpen.path) pendingRowOpen = null;
      // Selection events our own multi-select mutations caused (item.select()
      // makes Pierre emit) are not user gestures — swallow them entirely, or
      // the toggle would clear its own set and dispatch a phantom open.
      if (selectionSuppressed(suppressSelectionEventsUntilRef)) return;
      // Any other selection event came from an UNMODIFIED gesture (modifier
      // clicks are swallowed before Pierre), so the multi-selection is over —
      // Pierre has already replaced its own selection to match.
      if (multiSelectedRef.current.size > 0) {
        multiSelectedRef.current = new Set();
        setMultiSelected(new Set());
      }
      const p = selected[0];
      const fromChevron = chevronPointerRef.current;
      chevronPointerRef.current = false;
      if (fromChevron && p) {
        // Expand/collapse only — release the selection so the row's NEXT
        // real click still dispatches an open.
        releaseSelection(p);
        return;
      }
      // Bail on the row that is already open. This guard was briefly removed to
      // make a dead row retryable, which traded one bug for a worse one: the
      // re-dispatch is idempotent for TAB state but not for HISTORY, so every
      // redundant click pushed another hash entry and `goBack` walked through
      // duplicates instead of leaving the skill (caught by
      // `navigation-history.e2e.ts`).
      //
      // It is safe to keep now because `activePath` is derived from
      // `isSkillDocActive`, which requires a genuinely OPEN tab. The stale
      // `activeDocName` that made this guard swallow retries — a doc with no tab
      // behind it — no longer produces an `activePath` at all, so a dead row
      // dispatches and an open row does not.
      if (!p || p === activePath) return;
      const node = parseTreePath(p, groupByPrefix);
      if (node.sub !== null && node.isDir) return;
      const d = detectedFor(node);
      if (d) {
        // A detected skill row / SKILL.md / reference file opens the editable
        // in-place buffer. The folder stays expanded via the selection-sync
        // effect below (which re-expands on activePath change — the moment the
        // async open lands, overriding Pierre's folder-click collapse).
        onOpenDetected(d, node.sub ?? undefined);
        releaseSelection(p);
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
      releaseSelection(p);
    };
    // After the fresh handler is in place: complete the interrupted click.
    if (swallowedClick !== null) {
      pendingRowOpen = null;
      chevronPointerRef.current = false;
      handleSelectionChangeRef.current([swallowedClick]);
    }
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
    groupByPrefix,
    onExpandedChange,
  });
  useEffect(() => {
    folderInputsRef.current = {
      labelToScope,
      skillByPrefix,
      detectedByPrefix,
      groupByPrefix,
      onExpandedChange,
    };
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
      // Group folders too, or `userExpanded` accepts a prefix the builder emits
      // but this sync never captures — so opening a group and triggering any
      // remount silently collapses it again.
      for (const prefix of inputs.groupByPrefix.keys()) check(`${prefix}/`);
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

  // Keep Pierre's selection reconciled with the open doc on EVERY model event,
  // not only when `activePath` moves.
  //
  // Pierre emits a selection change only when the selection MOVES, so a row it
  // already holds selected swallows every later click on it. The handler above
  // is installed in a passive effect (deliberately — see its comment), so a
  // click landing in the window where the tree is remounting is dropped, and a
  // fresh install remounts it several times in a row as the skills list, the
  // detected scan, the bundle files and the install state each land. The
  // dropped click still SELECTS the row, and from then on `activePath` never
  // becomes it and Pierre never re-emits for it: the row is dead to every
  // retry until the user clicks some other skill and comes back. That is the
  // "I just installed it and cannot click it" report.
  //
  // Deselecting a row that is not the open doc puts it back in sync, so the
  // next click is a real selection change again. The effect below re-selects
  // the moment a doc actually lands, and the click handler already releases
  // the selection right after dispatching, so this adds no behaviour a
  // successful open did not already have.
  useEffect(() => {
    if (!ready) return;
    return model.subscribe(() => {
      // A live multi-selection owns the selection state. The tree rebuilds
      // whenever the skills list refreshes (install-state, detected scan),
      // and a rebuild drops Pierre's per-item selection — so rather than just
      // sparing the set from the sweep, RE-ASSERT any member the rebuild
      // dropped. Re-entrancy is safe: once every member is selected the
      // re-assert is a no-op and no further events fire.
      const held = multiSelectedRef.current;
      if (held.size > 0) {
        const current = new Set(model.getSelectedPaths());
        let missing = false;
        for (const p of held) {
          if (!current.has(p)) {
            missing = true;
            break;
          }
        }
        if (missing) {
          suppressSelection(suppressSelectionEventsUntilRef);
          for (const p of held) model.getItem(p)?.select();
        }
        return;
      }
      const open = activePathRef.current;
      for (const path of model.getSelectedPaths()) {
        if (path !== open) model.getItem(path)?.deselect();
      }
    });
  }, [ready, model]);

  // Selection = the open doc. Pierre selects folders on click (and folder-click
  // opens SKILL.md), so re-assert selection + focus onto the actual open row —
  // this also gives it the blue selected+focused ring. `focusPath` is internal
  // focus, not DOM focus, so it doesn't steal from the editor.
  useEffect(() => {
    if (!ready) return;
    // A live multi-selection owns the selection state; re-asserting the
    // active row here would collapse it back to one row.
    if (multiSelected.size > 0) return;
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
      const node = parseTreePath(activePath, groupByPrefixRef.current);
      // Composed from the node's own parts, INCLUDING its group segment: a
      // grouped skill lives under `<scope>/<group>/<skill>`, and rebuilding the
      // path from scope + skill alone silently misses `getItem`, leaving the
      // folder collapsed. Inlined rather than calling `prefixOf` so this effect
      // takes no dependency on a closure that changes identity every render.
      if (node.skillDisplay !== undefined) {
        const parent =
          node.group === undefined ? node.scopeLabel : `${node.scopeLabel}/${node.group}`;
        asDirectoryHandle(model.getItem(`${parent}/${node.skillDisplay}/`))?.expand();
      }
      // Scroll the row into view, exactly like the Files tree follows the
      // active doc: `focusPath` above only sets Pierre's focused index, and
      // Pierre auto-scrolls a focused row solely when the tree owns DOM focus —
      // which a tab switch or programmatic open never gives it, so the row can
      // sit below the fold in a long skills list. After the expand above, so
      // the row's visible index is final when the scroll computes.
      revealActiveRow(model, activePath);
    }
    // `multiSelected` is a real dependency: when the set clears, this re-runs
    // and restores the single active-row highlight.
  }, [ready, activePath, model, multiSelected]);

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
        hoveredPath !== undefined &&
        !rowHasContextMenuRef.current(parseTreePath(hoveredPath, groupByPrefixRef.current));
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
    const run = () => {
      applyInstallClusters(shadow, {
        decorFor: (p) => injectInputsRef.current.decorForPath(p),
        iconPool: iconPoolRef.current,
        installLabel: injectInputsRef.current.installLabel,
        version: resolvedTheme ?? 'light',
      });
      // Same pass, same observer: two injections over one row set beats two
      // observers racing each other's writes.
      applyProvenanceMarks(shadow, {
        markFor: (p) => injectInputsRef.current.markForPath(p),
        iconPool: iconPoolRef.current,
        version: resolvedTheme ?? 'light',
      });
      // Same pass again: editable skill roots become drag sources for the
      // scope-move DnD (rows recycle, so this must re-stamp with them).
      for (const row of shadow.querySelectorAll<HTMLElement>('[data-item-path]')) {
        const p = row.getAttribute('data-item-path');
        const canDrag = p !== null && injectInputsRef.current.draggableEntryFor(p) !== null;
        if (row.draggable !== canDrag) row.draggable = canDrag;
      }
    };
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
      const skill = injectInputsRef.current.skillFor(parseTreePath(pill.path, groupByPrefix));
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
        {GLOBAL_INSTALL_EDITORS.map((id) => (
          <span key={id} {...{ [HOST_POOL_KEY_ATTR]: id }}>
            <AgentBrandIcon host={id} />
          </span>
        ))}
        <span {...{ [HOST_POOL_KEY_ATTR]: 'generic' }}>
          <Sparkles />
        </span>
        {/* Plugin glyph for the provenance mark — same PackageIcon
            `SkillPluginBundleBanner` uses, so "part of a plugin" reads the same
            in the tree as it does in the editor. */}
        <span {...{ [PROVENANCE_POOL_KEY_ATTR]: PROVENANCE_PLUGIN_POOL_KEY }}>
          <Package />
        </span>
        {/* Pin glyph for pinned rows — injected through the same mark channel. */}
        <span {...{ [PROVENANCE_POOL_KEY_ATTR]: PROVENANCE_PIN_POOL_KEY }}>
          <Pin />
        </span>
        {/* Library glyph for publisher-less distribution sources. */}
        <span {...{ [PROVENANCE_POOL_KEY_ATTR]: PROVENANCE_LIBRARY_POOL_KEY }}>
          <LibraryBig />
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
      <SkillBulkDeleteDialog
        skills={bulkDelete}
        onOpenChange={(open) => {
          if (!open) setBulkDelete(null);
        }}
        onDeleted={() => {
          setBulkDelete(null);
          clearMultiSelection();
        }}
      />
      <OkFileTree
        model={model}
        hostRef={hostRef}
        ready={ready}
        className="min-h-0"
        style={createFileTreeStyle(resolvedTheme)}
        sizeToContent
        titleForPath={titleForPath}
        renderContextMenu={(item, context) => {
          const node = parseTreePath(item.path, groupByPrefix);
          if (!rowHasContextMenu(node)) return null;
          const scope = labelToScope.get(node.scopeLabel);
          if (!scope) return null;
          let menuItems: ReactNode;
          // A right-click on a row INSIDE a live multi-selection acts on the
          // whole set: bulk verbs replace the per-row menu. Right-clicking
          // outside the set falls through to the ordinary row menu (and the
          // plain-click that usually precedes it clears the set anyway).
          const bulkEntries =
            multiSelected.size > 1 && multiSelected.has(item.path)
              ? [...multiSelected]
                  .map((p) => skillFor(parseTreePath(p, groupByPrefix)))
                  .filter((s): s is SkillsListEntry => s !== undefined)
              : [];
          if (bulkEntries.length > 1) {
            // Scope-move only when the whole set can make the trip: one shared
            // scope (one destination) and no read-only managed bundles.
            const scopes = new Set(bulkEntries.map((s) => s.scope));
            const movable = scopes.size === 1 && bulkEntries.every((s) => !s.managed);
            const moveTarget: SkillScope =
              bulkEntries[0].scope === 'project' ? 'global' : 'project';
            menuItems = (
              <>
                <DropdownMenuLabel className="max-w-56 whitespace-normal font-normal text-muted-foreground text-xs">
                  <Trans>{bulkEntries.length} skills selected</Trans>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {movable ? (
                  <DropdownMenuItem onSelect={() => void bulkMoveScope(bulkEntries, moveTarget)}>
                    <DownloadCloud aria-hidden />
                    {moveTarget === 'global' ? (
                      <Trans>Move {bulkEntries.length} to Global</Trans>
                    ) : (
                      <Trans>Move {bulkEntries.length} to Project</Trans>
                    )}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem variant="destructive" onSelect={() => setBulkDelete(bulkEntries)}>
                  <Trash2 aria-hidden />
                  <Trans>Delete {bulkEntries.length} skills</Trans>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => clearMultiSelection()}>
                  <Trans>Clear selection</Trans>
                </DropdownMenuItem>
              </>
            );
          }
          // Group rows first: a group row also has no `skillDisplay`, so the
          // scope-row branch below would otherwise claim it and offer New /
          // Upload / Explore for a row that is not a place.
          else if (node.isGroupRow) {
            const members = updatableForNode(node);
            const bucket =
              node.group !== undefined
                ? groupByPrefix.get(`${node.scopeLabel}/${node.group}`)
                : undefined;
            if (members.length === 0 && !bucket) return null;
            const sourceLabel = node.group ?? '';
            // The group row speaks for the upstream: name what it is, link to
            // it, and (for tracked members) refresh from it. Same shape as the
            // scope-row menu — a describing label first, verbs after.
            menuItems = (
              <>
                {bucket ? (
                  <DropdownMenuLabel className="max-w-56 whitespace-normal font-normal text-muted-foreground text-xs">
                    {bucket.kind === 'plugin' ? (
                      <Trans>
                        The {bucket.id} plugin serves these skills from its cache — OK never edits
                        or updates them.
                      </Trans>
                    ) : bucket.publisher ? (
                      <Trans>
                        Skills from {bucket.publisher}/{bucket.id}.
                      </Trans>
                    ) : (
                      <Trans>Skills from {bucket.id}.</Trans>
                    )}
                  </DropdownMenuLabel>
                ) : null}
                {bucket?.url ? (
                  <DropdownMenuItem onSelect={() => openExternalUrl(bucket.url as string)}>
                    <ArrowUpRight aria-hidden />
                    {bucket.kind === 'plugin' ? (
                      <Trans>View plugin</Trans>
                    ) : (
                      <Trans>View source</Trans>
                    )}
                  </DropdownMenuItem>
                ) : null}
                {members.length > 0 ? (
                  <>
                    {bucket ? <DropdownMenuSeparator /> : null}
                    <DropdownMenuItem
                      onSelect={() =>
                        void actions.updateAllFromSource({
                          scope,
                          names: members.map((s) => s.name),
                          sourceLabel,
                        })
                      }
                    >
                      <DownloadCloud aria-hidden />
                      <Trans>Update all from this source</Trans>
                    </DropdownMenuItem>
                  </>
                ) : null}
              </>
            );
          } else if (node.skillDisplay === undefined) {
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
              // Detected skill row. Two kinds share it, and the primary verb
              // must keep its promise: a bare detected skill opens the
              // EDITABLE in-place buffer (→ Edit), while a plugin resident or
              // a foreign-checkout skill opens the READ-ONLY preview (→ View,
              // with the reason stated above it — the old "Edit" label was a
              // lie for those rows). Inspection verbs (reveal, copy path)
              // follow in the same order every other row menu uses.
              const residentPlugin = d.provenance.plugin?.trim() || null;
              const readOnly = residentPlugin !== null || d.outsideProject === true;
              const detectedDir = skillDir(d.files.skillMd);
              menuItems = (
                <>
                  {residentPlugin !== null ? (
                    <>
                      <DropdownMenuLabel className="max-w-56 whitespace-normal font-normal text-muted-foreground text-xs">
                        <Trans>
                          From the {residentPlugin} plugin — read-only; plugin updates replace these
                          files.
                        </Trans>
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                    </>
                  ) : d.outsideProject === true ? (
                    <>
                      <DropdownMenuLabel className="max-w-56 whitespace-normal font-normal text-muted-foreground text-xs">
                        <Trans>Lives outside this project — read-only here.</Trans>
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                    </>
                  ) : null}
                  <DropdownMenuItem onSelect={() => onOpenDetected(d)}>
                    {readOnly ? <Eye aria-hidden /> : <SquarePen aria-hidden />}
                    {readOnly ? <Trans>View</Trans> : <Trans>Edit</Trans>}
                  </DropdownMenuItem>
                  {residentPlugin !== null ? (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <SquarePen aria-hidden className="text-muted-foreground" />
                        <Trans>Edit a copy</Trans>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        <DropdownMenuLabel className="max-w-56 whitespace-normal font-normal text-muted-foreground text-xs">
                          <Trans>
                            Pick where your copy goes. Choosing a destination creates it.
                          </Trans>
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => void editPluginCopy(d, 'project')}>
                          <Trans>Project</Trans>
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void editPluginCopy(d, 'global')}>
                          <Trans>Global</Trans>
                        </DropdownMenuItem>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ) : null}
                  <DropdownMenuSeparator />
                  <SkillRevealMenuItem absolutePath={detectedDir} />
                  <DropdownMenuItem
                    onSelect={() =>
                      void scheduleClipboardWrite(detectedDir).then(
                        () => toast.success(t`Copied path`),
                        () => toast.error(t`Couldn't copy path`),
                      )
                    }
                  >
                    <CopyIcon aria-hidden />
                    <Trans>Copy Path</Trans>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <PinMenuItem
                    scope={scope}
                    name={d.name}
                    pinned={isPinned(scope, d.name)}
                    onToggle={onTogglePin}
                  />
                </>
              );
            } else {
              const skill = skillFor(node);
              if (!skill) return null;
              if (skill.managed) {
                // Read-only bars EDITS, not lifecycle or inspection: reveal,
                // copy path, the per-agent Install submenu, pin, and delete all
                // work like any other skill — only rename/duplicate/new-file/
                // scope-move are withheld. Install lives in a submenu so the
                // panel keeps the ordinary narrow width.
                if (node.sub !== null) return null;
                menuItems = (
                  <SkillManagedContextMenuItems
                    skill={skill}
                    actions={actions}
                    beforeDelete={
                      <>
                        <DropdownMenuSeparator />
                        <PinMenuItem
                          scope={scope}
                          name={skill.name}
                          pinned={isPinned(scope, skill.name)}
                          onToggle={onTogglePin}
                        />
                      </>
                    }
                  />
                );
              } else if (node.sub === null || node.sub === SKILL_MD_PATH) {
                menuItems = (
                  <>
                    <SkillContextMenuItems
                      skill={skill}
                      actions={actions}
                      existingNames={existingNames[skill.scope]}
                    />
                    <DropdownMenuSeparator />
                    <PinMenuItem
                      scope={scope}
                      name={skill.name}
                      pinned={isPinned(scope, skill.name)}
                      onToggle={onTogglePin}
                    />
                  </>
                );
              } else if (node.isDir) {
                // A bundle folder is a folder: New file seeded with its own
                // path, then the same rename / reveal / copy / delete verbs its
                // file rows carry — the server handles directories recursively.
                // `node.sub` is non-null here (the null case is handled above).
                menuItems = (
                  <>
                    <DropdownMenuItem
                      onSelect={() => actions.requestFileCreate(skill, `${node.sub}/`)}
                    >
                      <FilePlus aria-hidden />
                      <Trans>New file</Trans>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <SkillFileContextMenuItems
                      skill={skill}
                      filePath={node.sub}
                      actions={actions}
                    />
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
