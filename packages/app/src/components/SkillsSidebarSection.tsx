import {
  type CatalogSkill,
  catalogRawScopeToOkScope,
  externalSkillLiveDocName,
  humanFormat,
  type SkillScope,
  type SkillsListEntry,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { AddSkillTab } from '@/components/ImportSkillDialog';
import { NewSkillDialog } from '@/components/NewSkillDialog';
import { SkillsTree } from '@/components/SkillsTree';
import { useSkillActions } from '@/components/skill-actions';
import { Button } from '@/components/ui/button';
import { SidebarGroup, SidebarGroupContent } from '@/components/ui/sidebar';
import { Spinner } from '@/components/ui/spinner';
import { useDocumentContext } from '@/editor/DocumentContext';
import { findLocalSkillPreviewTabId } from '@/editor/editor-tabs';
import { useCreateBlankSkill } from '@/hooks/use-create-blank-skill';
import { useOpenSkill } from '@/hooks/use-open-skill';
import { useOpenSkillForEdit } from '@/hooks/use-open-skill-for-edit';
import { useSkills } from '@/hooks/use-skills';
import { useConfigContext } from '@/lib/config-provider';
import {
  hashFromDocName,
  hashFromSkillFile,
  hashFromSkillPreview,
  pushHashWithoutNavigation,
  type SkillPreviewHashTarget,
} from '@/lib/doc-hash';
import { subscribeToSkillScopeMoved, subscribeToSkillsChanged } from '@/lib/documents-events';
import { skillEntryFileLiveDocName, skillEntryLiveDocName } from '@/lib/managed-artifact-doc-name';
import { PIN_FIELD, readPins, togglePin } from '@/lib/skill-pins';
import {
  SKILL_SCOPE_ORDER,
  skillDir,
  skillNameSetsByScope,
  useSkillScopeDescriptions,
  useSkillScopeLabels,
} from '@/lib/skill-scope';
import { createSkillSortComparator, SKILL_MD_PATH } from '@/lib/skill-sort';
import { requestSkillTrackPrompt } from '@/lib/skill-track-prompt-store';
import {
  fetchSkillPreview,
  getSkillBundledFiles,
  listDetectedSkills,
  type SkillBundledFile,
} from '@/lib/skills-api';
import { buildSkillsTreePaths, detectedId, isSkillDocActive } from '@/lib/skills-tree-paths';

// Lazy-load the full add-skill modal (skills.sh search + upload + new skill) —
// the SAME dialog the Skills empty state opens — so its weight stays out of the
// always-mounted sidebar bundle and loads only on first open.
const ImportSkillDialog = lazy(() =>
  import('@/components/ImportSkillDialog').then((m) => ({ default: m.ImportSkillDialog })),
);

/**
 * "Skills" section of the file sidebar — ONE `<OkFileTree>` (the same Pierre
 * component as the main file tree). GLOBAL / PROJECT are top-level folder rows
 * (styled as muted uppercase labels via `SKILLS_TREE_CSS`); each scope's skills
 * nest under it. A scope holds this project's skills (store + in-place)
 * and skills OK detected in your other tools (editable in place). A single tree
 * means Pierre's native single-select "just works". `SKILL.md` opens the editor;
 * a detected row opens its editable in-place buffer.
 */
export function SkillsSidebarSection({ dockExpanded = false }: { dockExpanded?: boolean } = {}) {
  const state = useSkills();
  const { openTarget, activeDocName, activeTarget, openTabs, activateTab } = useDocumentContext();
  const { merged, userBinding, projectLocalBinding } = useConfigContext();
  // Preview tabs off means every sidebar click opens its own tab — same
  // preference the Files tree honors.
  const tabBehavior: 'append' | 'replace-active' =
    (merged?.editor?.previewTabs ?? true) ? 'replace-active' : 'append';
  // Grouping by provenance. Defaults on, but it is a pure view toggle: off
  // renders exactly the flat tree that shipped before it existed.
  const showSkillGroups = merged?.appearance?.sidebar?.showSkillGroups ?? true;
  // Pinned skills, read per scope. The two lists live in different config layers
  // (project-local vs user) because pin scope follows skill scope — see
  // `skill-pins.ts` — but the merged view flattens that, so reading is uniform.
  const pinnedByScope = {
    project: readPins(merged, 'project'),
    global: readPins(merged, 'global'),
  };
  // Pin scope decides the LAYER, which is the whole point of the two lists: a
  // project pin is per-machine-per-project (beside `showSkillGroups`), a global pin
  // is per-user so a pinned global skill follows you into every project.
  const togglePinned = (scope: SkillScope, name: string, pinned: boolean) => {
    const binding = scope === 'global' ? userBinding : projectLocalBinding;
    if (binding === null) return;
    const next = togglePin(pinnedByScope[scope], name, pinned);
    const result = binding.patch({ appearance: { sidebar: { [PIN_FIELD[scope]]: next } } });
    if (!result.ok) {
      toast.error(pinned ? t`Couldn't pin ${name}` : t`Couldn't unpin ${name}`, {
        description: humanFormat(result.error),
      });
    }
  };

  const openSkill = useOpenSkill();
  const openSkillForEdit = useOpenSkillForEdit();
  const actions = useSkillActions();
  const { t } = useLingui();
  const scopeLabel = useSkillScopeLabels();
  const scopeDescription = useSkillScopeDescriptions();

  // A pin follows its skill across a scope move. The two pin lists live in
  // different config layers, so without this a move silently dropped the pin
  // and the skill fell back into the flat tree. Best-effort: pin state is a
  // convenience, so a failed migration never surfaces as a move failure.
  const togglePinnedRef = useRef(togglePinned);
  useEffect(() => {
    togglePinnedRef.current = togglePinned;
  });
  const pinnedByScopeRef = useRef(pinnedByScope);
  useEffect(() => {
    pinnedByScopeRef.current = pinnedByScope;
  });
  useEffect(
    () =>
      subscribeToSkillScopeMoved(({ name, fromScope, toScope }) => {
        if (!pinnedByScopeRef.current[fromScope].has(name)) return;
        togglePinnedRef.current(fromScope, name, false);
        togglePinnedRef.current(toScope, name, true);
      }),
    [],
  );

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
    if (!dockExpanded) return;
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
  }, [dockExpanded]);

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
    // Only the Skills tree consumes filesByKey, so skip the N fetches + the
    // skillsChanged subscription until the dock is expanded. Radix unmounts a
    // closed `CollapsibleContent` (no `forceMount`), so today this mostly covers
    // the closing transition — it is also what keeps a future `forceMount` from
    // silently reviving a fetch per skill on every collapsed sidebar.
    if (!dockExpanded) return;
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
  }, [filesKey, dockExpanded]);

  // --- scroll preservation across tree remounts ---
  //
  // `SkillsTree` remounts on every path-set or install-state change (its `key`;
  // Pierre cannot reconcile those in place), and the fresh instance renders
  // SHORT until its async ready-flip. The dock's scroller clamps to the shrunken
  // content in that window, so a remount that coincided with a click read as
  // "the skills studio section scrolls back to the top". The scroller belongs
  // to the dock (the CollapsibleContent above this section): capture its
  // position continuously here; `TreeScrollKeeper` — keyed WITH the tree, so
  // its mount IS the remount signal — restores it once the new tree has grown
  // tall enough to hold it.
  const sectionRef = useRef<HTMLDivElement | null>(null);
  const lastScrollTopRef = useRef(0);
  const restoringRef = useRef(false);
  useEffect(() => {
    if (!dockExpanded) return;
    const scroller = sectionRef.current?.closest<HTMLElement>(DOCK_SCROLLER_SELECTOR);
    if (!scroller) return;
    const onScroll = () => {
      // Clamp events during a restore are the symptom, not the user — recording
      // them would overwrite the position being restored.
      if (!restoringRef.current) lastScrollTopRef.current = scroller.scrollTop;
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [dockExpanded]);

  // Collapsed, the dock renders its header row only — this body contributes
  // nothing and, more importantly, the two fetches above never fire.
  if (!dockExpanded) {
    return null;
  }

  // --- open routing (parameterized by skill) ---
  // Open a skill's live doc (project content doc OR `__skill__/…` managed-
  // artifact doc — both resolve to a `{kind:'doc'}` target) REPLACING the active
  // tab, the same preview-tab behavior the Files tree uses on click: clicking
  // through skills reuses one tab instead of stacking a new one each time (§8.7).
  // A pinned active tab is preserved (replace-active falls back to append when
  // pinned, handled in openTargetWithOptions). Users who want a tab per click
  // turn `editor.previewTabs` off, which pins `tabBehavior` to append.
  const openSkillDoc = (docName: string) => {
    openTarget({ kind: 'doc', target: docName, docName }, { tabBehavior });
    pushHashWithoutNavigation(hashFromDocName(docName));
  };
  const openSkillMd = (skill: SkillsListEntry) => {
    // Route through the SHARED opener rather than opening the doc directly.
    // `useOpenSkill` documents itself as the single entry point every
    // open-a-skill surface must use, and this one had drifted: it minted the doc
    // name itself, so every fix applied there (scope resolution, the fresh-entry
    // fallback, pinning the surface to Skills) silently did not apply to a
    // sidebar click. Same visible action behaving differently depending on where
    // it was invoked from is what made these bugs so hard to pin down.
    openSkill(skill.scope, skill.name, {
      replaceActive: tabBehavior === 'replace-active',
      ...(skill.path ? { path: skill.path } : {}),
      ...(skill.hostQualifier !== undefined ? { host: skill.hostQualifier } : {}),
    });
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
        target.subtitle ?? '',
        target.level,
      );
      if (existing) {
        activateTab(existing);
        pushHashWithoutNavigation(hashFromSkillPreview(target));
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
      { tabBehavior },
    );
    pushHashWithoutNavigation(hashFromSkillPreview(target));
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
    // Same gate as the SKILL doc: nothing in a gitignored bundle is indexed.
    // NOT for a managed built-in: OK ships those bundles read-only, a repo that
    // ignores them means it, and they open as a read-only preview anyway — so
    // offering to git-track one is an offer the user must not take.
    if (skill.ignored === true && !skill.managed) {
      requestSkillTrackPrompt({ scope: skill.scope, name: skill.name });
      return;
    }
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
      { tabBehavior },
    );
    pushHashWithoutNavigation(
      hashFromSkillFile({
        scope: skill.scope,
        name: skill.name,
        path: filePath,
        ...(host ? { host } : {}),
      }),
    );
  };
  // A read-only skill-preview tab (built-in / plugin-resident / foreign) is as
  // much "this skill is open" as an editable doc tab — without this the row of
  // any preview-opening skill never highlights, so the tree looks dead after
  // the click. `path` distinguishes the SKILL row (no path) from a bundle-file
  // selection inside the same preview tab.
  const isPreviewActiveFor = (name: string, scope: SkillScope, path?: string): boolean =>
    activeTarget?.kind === 'skill-preview' &&
    activeTarget.name === name &&
    activeTarget.level === scope &&
    activeTarget.path === path;
  const isFileActive = (skill: SkillsListEntry, filePath: string): boolean => {
    const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
    if (!skill.managed && (ext === 'md' || ext === 'mdx')) {
      return activeDocName === skillEntryFileLiveDocName(skill, filePath);
    }
    return (
      (activeTarget?.kind === 'skill-file' &&
        activeTarget.scope === skill.scope &&
        activeTarget.name === skill.name &&
        activeTarget.path === filePath) ||
      isPreviewActiveFor(skill.name, skill.scope, filePath)
    );
  };
  const isSkillMdActive = (skill: SkillsListEntry): boolean =>
    // Pure + unit-tested (see skills-tree-paths.test.ts). Requires a real OPEN
    // tab, not just a matching `activeDocName`: a skill-file viewer or preview
    // leaves that value stale on the last doc tab, and an open that never
    // landed leaves it pointing at a doc with no tab — either way the row reads
    // active and the tree's click guard then swallows the retry.
    isSkillDocActive({
      activeTargetKind: activeTarget?.kind,
      activeDocName,
      openTabs,
      docName: skillEntryLiveDocName(skill),
    }) || isPreviewActiveFor(skill.name, skill.scope);

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
    // Two ways the editable in-place buffer is a trap, both answered by the
    // read-only preview whose one action is a copy the user owns:
    //   - a Claude PLUGIN-CACHE resident is vendor-managed, versioned state, so
    //     a plugin update clobbers any edit;
    //   - a skill OUTSIDE the open project is only listed because worktree
    //     enumeration resolves to the parent checkout, so an edit would land in
    //     a different checkout on a different branch.
    // Provenance answers only the first. Locality is a separate axis and gets a
    // separate flavor — a non-plugin skill must not be dressed up as a plugin.
    const trapped =
      s.provenance.plugin !== undefined ? 'detected' : s.outsideProject ? 'foreign' : null;
    if (trapped !== null) {
      openPreviewReplacing({
        flavor: trapped,
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
    // Same `tabBehavior` decision as every other open in this sidebar. Hard-
    // coding reuse here left the two halves of this function disagreeing: the
    // plugin branch above already routes through `openPreviewReplacing`, so
    // with `previewTabs` off a detected skill was the one row that still stole
    // the active tab. `replaceActive` maps 1:1 onto the two values — the hook
    // passes `tabBehavior: 'replace-active'` when true, and `openTarget`
    // defaults to `'append'` otherwise.
    const replaceActive = tabBehavior === 'replace-active';
    void openSkillForEdit(s.name, source, { replaceActive, rel }).then((r) => {
      if (!r.ok) toast.error(t`Couldn't open ${s.name} for editing: ${r.error}`);
    });
  };

  // Build paths + a `<scopeLabel>/<segment>` → skill lookup. Every scope always
  // appears (as an empty folder if it has no skills) so its "New / Add" menu is
  // always reachable. Pure + unit-tested (see skills-tree-paths.test.ts).
  const labelToScope = new Map(SKILL_SCOPE_ORDER.map((s) => [scopeLabel[s], s] as const));
  const {
    paths,
    expanded,
    activePath,
    skillByPrefix,
    detectedByPrefix,
    groupByPrefix,
    pinnedPrefixes,
  } = buildSkillsTreePaths({
    skills,
    detected,
    scopeLabel,
    filesByKey,
    detectedFilesById,
    userExpanded,
    hostQualifierOf,
    rowKeyFor: skillRowKey,
    isSkillMdActive,
    isFileActive,
    isDetectedActive: (s) =>
      activeDocName === externalSkillLiveDocName(s.name) ||
      isPreviewActiveFor(s.name, catalogRawScopeToOkScope(s.provenance.scope)),
    showSkillGroups,
    pinnedByScope,
  });

  // Pure, unit-tested comparator (see skill-sort.test.ts). The depth semantics
  // it encodes are load-bearing and previously shipped wrong; keep the coverage.
  const skillSort = createSkillSortComparator(
    labelToScope,
    detectedByPrefix,
    groupByPrefix,
    skillByPrefix,
    pinnedPrefixes,
  );

  // Remount key: path set + per-skill state (installed/update) + detected count —
  // NOT the active row (selection is synced imperatively so opening a doc never
  // remounts / collapses the tree).
  const stateKey = `${skills.map((s) => `${s.installed ? 1 : 0}`).join('')}|d${detectedByPrefix.size}`;

  // First list load, or the N-per-skill bundle-file fetch in flight — surface it
  // so a folder with many skills reads as "loading", not broken/empty.
  const skillsLoading = state.status === 'loading' || bundleLoading;
  // Pins are part of the key: the sort comparator and the pin-row CSS are both
  // baked at tree creation, and an UNGROUPED pin changes no paths — without
  // this, pinning (or the async config load delivering existing pins) neither
  // floats nor marks the row until something else forces a remount.
  const treeKey = `${paths.join('|')}::${stateKey}::p${[...pinnedPrefixes].sort().join(',')}`;

  return (
    <SidebarGroup ref={sectionRef} className="px-0">
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
            <Spinner className="size-3.5" aria-hidden />
            <Trans>Loading skills</Trans>
          </div>
        ) : null}
        <TreeScrollKeeper
          key={`keep::${treeKey}`}
          sectionRef={sectionRef}
          lastScrollTopRef={lastScrollTopRef}
          restoringRef={restoringRef}
        />
        <SkillsTree
          key={treeKey}
          paths={paths}
          activePath={activePath}
          initialExpandedPaths={expanded}
          onExpandedChange={setUserExpanded}
          sort={skillSort}
          pinnedPrefixes={pinnedPrefixes}
          isPinned={(scope, name) => pinnedByScope[scope].has(name)}
          onTogglePin={togglePinned}
          skillByPrefix={skillByPrefix}
          detectedByPrefix={detectedByPrefix}
          groupByPrefix={groupByPrefix}
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

// The dock's scroller (SkillsSidebarDock's CollapsibleContent). One constant so
// the capture and restore sites cannot drift onto different nodes; `data-slot`
// is shadcn's own marker on that element.
const DOCK_SCROLLER_SELECTOR = '[data-slot="collapsible-content"]';

/**
 * Restores the dock scroller's position after a `SkillsTree` remount. Rendered
 * with a key derived from the SAME key that remounts the tree, so this mounts
 * exactly when the tree does — and its mount effect retries by frame (briefly)
 * because the new tree grows asynchronously and Pierre emits no "ready" event
 * an ancestor could await. Renders nothing.
 */
function TreeScrollKeeper({
  sectionRef,
  lastScrollTopRef,
  restoringRef,
}: {
  sectionRef: React.RefObject<HTMLDivElement | null>;
  lastScrollTopRef: React.RefObject<number>;
  restoringRef: React.RefObject<boolean>;
}) {
  useLayoutEffect(() => {
    const saved = lastScrollTopRef.current;
    if (saved <= 0) return;
    const scroller = sectionRef.current?.closest<HTMLElement>(DOCK_SCROLLER_SELECTOR);
    if (!scroller) return;
    restoringRef.current = true;
    const deadline = Date.now() + 1000;
    let raf = 0;
    const tick = () => {
      if (scroller.scrollHeight - scroller.clientHeight >= saved) {
        scroller.scrollTop = saved;
        restoringRef.current = false;
        return;
      }
      if (Date.now() < deadline) {
        raf = requestAnimationFrame(tick);
        return;
      }
      // Unreachable target (the list shrank under the saved offset): clamp the
      // saved value, or it stays pending forever — recording is suppressed
      // while a restore is pending, and only recording could fix the value.
      lastScrollTopRef.current = Math.min(
        saved,
        Math.max(0, scroller.scrollHeight - scroller.clientHeight),
      );
      restoringRef.current = false;
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      restoringRef.current = false;
    };
  }, [sectionRef, lastScrollTopRef, restoringRef]);
  return null;
}
