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
import { groupDeletableSkills, groupUpdatableSkills } from '@/lib/skill-group-update';
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

const PLUGIN_PACKAGE_ICON_ID = 'ok-skills-plugin-package-decoration';
const SKILLS_DECORATION_EXTRA_SYMBOLS = createLucideSpriteSymbol(
  PLUGIN_PACKAGE_ICON_ID,
  packageIcon,
);

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

let pendingRowOpen: { path: string; at: number } | null = null;
const PENDING_ROW_OPEN_TTL_MS = 3000;

let rangeAnchor: string | null = null;
let rangeCursor: string | null = null;

function suppressSelection(ref: { current: number }): void {
  ref.current = performance.now() + 50;
}
function selectionSuppressed(ref: { current: number }): boolean {
  return performance.now() < ref.current;
}

interface TreeNode {
  scopeLabel: string;
  group: string | undefined;
  skillDisplay: string | undefined;
  sub: string | null;
  isGroupRow: boolean;
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
  onExpandedChange: (paths: ReadonlySet<string>) => void;
  sort: FileTreeSortComparator;
  skillByPrefix: Map<string, SkillsListEntry>;
  detectedByPrefix: Map<string, CatalogSkill>;
  groupByPrefix: ReadonlyMap<string, ProvenanceBucket>;
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
  const iconPoolRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const [installMenu, setInstallMenu] = useState<{
    skill: SkillsListEntry;
    x: number;
    y: number;
  } | null>(null);
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
  const titleForPath = (treePath: string): string | null => {
    const node = parseTreePath(treePath, groupByPrefix);
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
    const labels = skillEntryDirs(skill).map((d) => {
      const dir = node.sub ? `${d.dir}/${node.sub}` : d.dir;
      return d.symlink ? t`${dir} (symlink)` : dir;
    });
    return labels.join(', ');
  };
  const updatableForNode = (node: TreeNode): SkillsListEntry[] => {
    if (!node.isGroupRow || node.group === undefined) return [];
    const groupPrefix = `${node.scopeLabel}/${node.group}`;
    return groupUpdatableSkills({
      groupPrefix,
      bucket: groupByPrefix.get(groupPrefix),
      skillByPrefix,
    });
  };
  const rowHasContextMenu = (node: TreeNode): boolean => {
    const scope = labelToScope.get(node.scopeLabel);
    if (!scope) return false;
    if (node.isGroupRow)
      return (
        updatableForNode(node).length > 0 ||
        (node.group !== undefined && groupByPrefix.has(`${node.scopeLabel}/${node.group}`))
      );
    if (node.skillDisplay === undefined) return true;
    if (detectedFor(node)) return true;
    const skill = skillFor(node);
    if (!skill) return false;
    if (skill.managed) return node.sub === null;
    return true;
  };
  const markFromBucket = (
    bucket: ProvenanceBucket | null,
    isGroupRow: boolean,
  ): RowProvenanceMark => {
    if (!bucket) return null;
    if (bucket.kind === 'plugin') {
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
      const plugin = bucket.id;
      const url = bucket.url ?? bucket.parent?.url ?? null;
      if (url === null) return { kind: 'plugin', title: t`Part of the ${plugin} plugin` };
      return { kind: 'plugin', title: t`View the ${plugin} plugin repo`, href: url };
    }
    const publisher = bucket.publisher;
    if (!publisher) {
      if (!isGroupRow) return null;
      const source = bucket.id;
      return {
        kind: 'library',
        title: bucket.url ? t`${source} · skills.sh source` : t`${source} · imported source`,
        ...(bucket.url === null ? {} : { href: bucket.url }),
      };
    }
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
    if (node.inProvenanceGroup || node.skillDisplay === undefined) return null;
    if (node.sub !== null) return null;
    const skill = skillFor(node);
    if (skill) return markFromBucket(bucketForSkill(skill), false);
    const d = detectedFor(node);
    return markFromBucket(d ? bucketForDetected(d) : null, false);
  };

  const rowHasContextMenuRef = useRef(rowHasContextMenu);
  useEffect(() => {
    rowHasContextMenuRef.current = rowHasContextMenu;
  });
  const groupByPrefixRef = useRef(groupByPrefix);
  useEffect(() => {
    groupByPrefixRef.current = groupByPrefix;
  });
  const labelToScopeRef = useRef(labelToScope);
  useEffect(() => {
    labelToScopeRef.current = labelToScope;
  });
  const skillRowOrderRef = useRef<readonly string[]>([]);
  useEffect(() => {
    const order: string[] = [];
    const seen = new Set<string>();
    for (const p of paths) {
      const node = parseTreePath(p, groupByPrefix);
      if (node.skillDisplay === undefined || node.isGroupRow) continue;
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
    const hosts = skillClusterHosts(skill);
    if (hosts.length > 0)
      return {
        kind: 'icons',
        poolKeys: hosts.map(poolKeyFor),
        title: t`Installed in ${hosts.map((h) => skillHostRootDir(h, skill.scope)).join(', ')}`,
      };
    if (skill.managed) return null;
    return { kind: 'install', title: t`Install ${skill.name}` };
  };
  const draggableEntryFor = (treePath: string): SkillsListEntry | null => {
    const node = parseTreePath(treePath, groupByPrefix);
    if (node.skillDisplay === undefined || node.sub !== null || node.isGroupRow) return null;
    if (detectedFor(node)) return null;
    const skill = skillFor(node);
    return skill && !skill.managed ? skill : null;
  };
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
        if (node.skillDisplay === undefined || node.sub !== null) return null;
        const det = detectedFor(node);
        if (det?.provenance.plugin !== undefined && !node.inProvenanceGroup) {
          return {
            icon: PLUGIN_PACKAGE_ICON_ID,
            title: t`Part of the ${det.provenance.plugin} plugin — read-only; open it to edit a copy`,
          };
        }
        return null;
      },
    }),
    onSelectionChange: (selected) => handleSelectionChangeRef.current(selected),
    sort,
    flattenEmptyDirectories: false,
  });

  const releaseSelection = (path: string) => model.getItem(path)?.deselect();

  const activePathRef = useRef(activePath);
  useEffect(() => {
    activePathRef.current = activePath;
  });

  const [multiSelected, setMultiSelected] = useState<ReadonlySet<string>>(new Set());
  const multiSelectedRef = useRef(multiSelected);
  useEffect(() => {
    multiSelectedRef.current = multiSelected;
  });
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
  const bulkMoveScopeRef = useRef(bulkMoveScope);
  useEffect(() => {
    bulkMoveScopeRef.current = bulkMoveScope;
  });

  const chevronPointerRef = useRef(false);
  const selectionEventCountRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: model.getItem / releaseSelection are per-render closures over the stable tree model; the shadow-root listeners wire once per tree mount (`ready`), not per render.
  useEffect(() => {
    if (!ready) return;
    const shadow = hostRef.current?.querySelector(FILE_TREE_TAG_NAME)?.shadowRoot;
    if (!shadow) return;
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
    let gestureHandled = false;
    const applyMultiSelection = (next: Set<string>) => {
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
          if (skillRootPathAt(e) !== null) {
            rangeAnchor = rowPath;
            rangeCursor = null;
          }
        }
      }
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
    const timers: ReturnType<typeof setTimeout>[] = [];
    const onClick = (e: Event) => {
      if (!(e instanceof MouseEvent) || e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("[data-item-section='icon']") != null) return;
      const row = target?.closest?.('[data-item-path]') as HTMLElement | null;
      const path = row?.getAttribute('data-item-path');
      if (!path) return;
      const seen = selectionEventCountRef.current;
      timers.push(
        setTimeout(() => {
          if (selectionEventCountRef.current !== seen) return;
          chevronPointerRef.current = false;
          handleSelectionChangeRef.current([path]);
        }, 250),
      );
    };
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
      if (!(e instanceof KeyboardEvent)) return;
      const lowerKey = e.key.toLowerCase();
      const isDeleteKey =
        !e.altKey &&
        !e.shiftKey &&
        ((e.metaKey && !e.ctrlKey && lowerKey === 'backspace') ||
          (!e.metaKey && !e.ctrlKey && lowerKey === 'delete'));
      if (isDeleteKey && multiSelectedRef.current.size > 0) {
        const del = e.target as HTMLElement | null;
        if (del?.closest?.('[contenteditable], input, textarea, [role="textbox"]')) return;
        const entries = [...multiSelectedRef.current]
          .map((p) => injectInputsRef.current.skillFor(parseTreePath(p, groupByPrefixRef.current)))
          .filter((s): s is SkillsListEntry => s !== undefined);
        if (entries.length === 0) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        setBulkDelete(entries);
        return;
      }
      if (!e.shiftKey) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('[contenteditable], input, textarea, [role="textbox"]')) return;
      const treeFocused = hostRef.current?.contains(document.activeElement);
      if (multiSelectedRef.current.size === 0 && !treeFocused) return;
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
      if (pendingRowOpen !== null && selected[0] === pendingRowOpen.path) pendingRowOpen = null;
      if (selectionSuppressed(suppressSelectionEventsUntilRef)) return;
      if (multiSelectedRef.current.size > 0) {
        multiSelectedRef.current = new Set();
        setMultiSelected(new Set());
      }
      const p = selected[0];
      const fromChevron = chevronPointerRef.current;
      chevronPointerRef.current = false;
      if (fromChevron && p) {
        releaseSelection(p);
        return;
      }
      if (!p || p === activePath) return;
      const node = parseTreePath(p, groupByPrefix);
      if (node.sub !== null && node.isDir) return;
      const d = detectedFor(node);
      if (d) {
        onOpenDetected(d, node.sub ?? undefined);
        releaseSelection(p);
        return;
      }
      const skill = skillFor(node);
      if (!skill) return;
      if (node.sub === null || node.sub === SKILL_MD_PATH) {
        (skill.managed ? onOpenManaged : onOpenSkillMd)(skill);
      } else {
        onOpenFile(skill, node.sub);
      }
      releaseSelection(p);
    };
    if (swallowedClick !== null) {
      pendingRowOpen = null;
      chevronPointerRef.current = false;
      handleSelectionChangeRef.current([swallowedClick]);
    }
  });

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
      for (const prefix of inputs.groupByPrefix.keys()) check(`${prefix}/`);
      const prev = lastSentRef.current;
      if (prev.size === next.size && [...next].every((p) => prev.has(p))) return;
      lastSentRef.current = next;
      inputs.onExpandedChange(next);
    };
    sync();
    return model.subscribe(sync);
  }, [model]);

  useEffect(() => {
    if (!ready) return;
    return model.subscribe(() => {
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

  useEffect(() => {
    if (!ready) return;
    if (multiSelected.size > 0) return;
    for (const p of model.getSelectedPaths()) {
      if (p !== activePath) model.getItem(p)?.deselect();
    }
    if (activePath) {
      model.getItem(activePath)?.select();
      model.focusPath(activePath);
      const node = parseTreePath(activePath, groupByPrefixRef.current);
      if (node.skillDisplay !== undefined) {
        const parent =
          node.group === undefined ? node.scopeLabel : `${node.scopeLabel}/${node.group}`;
        asDirectoryHandle(model.getItem(`${parent}/${node.skillDisplay}/`))?.expand();
      }
      revealActiveRow(model, activePath);
    }
  }, [ready, activePath, model, multiSelected]);

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
      applyProvenanceMarks(shadow, {
        markFor: (p) => injectInputsRef.current.markForPath(p),
        iconPool: iconPoolRef.current,
        version: resolvedTheme ?? 'light',
      });
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
    const onClick = (e: Event) => {
      const pill = installPillFromEvent(e.target);
      if (!pill) return;
      e.preventDefault();
      e.stopPropagation();
      const skill = injectInputsRef.current.skillFor(parseTreePath(pill.path, groupByPrefix));
      if (skill) setInstallMenu({ skill, x: pill.rect.left, y: pill.rect.bottom });
    };
    shadow.addEventListener('click', onClick, true);
    return () => {
      observer.disconnect();
      shadow.removeEventListener('click', onClick, true);
    };
  }, [ready, resolvedTheme, installSignal]);

  return (
    <>
      {}
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
        {}
        <span {...{ [PROVENANCE_POOL_KEY_ATTR]: PROVENANCE_PLUGIN_POOL_KEY }}>
          <Package />
        </span>
        {}
        <span {...{ [PROVENANCE_POOL_KEY_ATTR]: PROVENANCE_PIN_POOL_KEY }}>
          <Pin />
        </span>
        {}
        <span {...{ [PROVENANCE_POOL_KEY_ATTR]: PROVENANCE_LIBRARY_POOL_KEY }}>
          <LibraryBig />
        </span>
      </div>
      {}
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
          const bulkEntries =
            multiSelected.size > 1 && multiSelected.has(item.path)
              ? [...multiSelected]
                  .map((p) => skillFor(parseTreePath(p, groupByPrefix)))
                  .filter((s): s is SkillsListEntry => s !== undefined)
              : [];
          if (bulkEntries.length > 1) {
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
          } else if (node.isGroupRow) {
            const members = updatableForNode(node);
            const bucket =
              node.group !== undefined
                ? groupByPrefix.get(`${node.scopeLabel}/${node.group}`)
                : undefined;
            const deletable =
              node.group !== undefined
                ? groupDeletableSkills({
                    groupPrefix: `${node.scopeLabel}/${node.group}`,
                    bucket,
                    skillByPrefix,
                  })
                : [];
            if (members.length === 0 && deletable.length === 0 && !bucket) return null;
            const sourceLabel = node.group ?? '';
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
                {deletable.length > 0 ? (
                  <>
                    {members.length === 0 && bucket ? <DropdownMenuSeparator /> : null}
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => setBulkDelete(deletable)}
                    >
                      <Trash2 aria-hidden />
                      <Trans>Delete {deletable.length} skills</Trans>
                    </DropdownMenuItem>
                  </>
                ) : null}
              </>
            );
          } else if (node.skillDisplay === undefined) {
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

function SkillInstallMenuBody({
  skill,
  actions,
  onRunStart,
}: {
  skill: SkillsListEntry;
  actions: SkillActions;
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
