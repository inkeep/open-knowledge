import {
  type CatalogSkill,
  catalogRawScopeToOkScope,
  externalSkillLiveDocName,
  type SkillScope,
  type SkillsListEntry,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { lazy, Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { AddSkillTab } from '@/components/ImportSkillDialog';
import { NewSkillDialog } from '@/components/NewSkillDialog';
import { EMPTY_SCOPE_SENTINEL, SkillsTree } from '@/components/SkillsTree';
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
import { subscribeToSkillsChanged } from '@/lib/documents-events';
import { skillEntryFileLiveDocName, skillEntryLiveDocName } from '@/lib/managed-artifact-doc-name';
import {
  SKILL_SCOPE_ORDER,
  skillDir,
  skillDisplayName,
  skillNameSetsByScope,
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

// OK's own core product skills — managing them with OK is circular, so they
// never show as "Detected". Its shipped *packs* (`open-knowledge-pack-*`) are
// fair game to adopt, so they are NOT excluded.
const OK_OWN_SKILLS = new Set([
  'open-knowledge',
  'open-knowledge-discovery',
  'open-knowledge-write-skill',
]);

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
  const { merged } = useConfigContext();
  // Preview tabs off means every sidebar click opens its own tab — same
  // preference the Files tree honors.
  const tabBehavior: 'append' | 'replace-active' =
    (merged?.editor?.previewTabs ?? true) ? 'replace-active' : 'append';
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
  // pinned, handled in openTargetWithOptions). Users who want a tab per click
  // turn `editor.previewTabs` off, which pins `tabBehavior` to append.
  const openSkillDoc = (docName: string) => {
    openTarget({ kind: 'doc', target: docName, docName }, { tabBehavior });
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
      { tabBehavior },
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
            <Spinner className="size-3.5" aria-hidden />
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
