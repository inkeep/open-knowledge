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
import { fetchSkillPreview, listDetectedSkills } from '@/lib/skills-api';
import { buildSkillsTreePaths, detectedId, isSkillDocActive } from '@/lib/skills-tree-paths';

const ImportSkillDialog = lazy(() =>
  import('@/components/ImportSkillDialog').then((m) => ({ default: m.ImportSkillDialog })),
);

export function SkillsSidebarSection({ dockExpanded = false }: { dockExpanded?: boolean } = {}) {
  const state = useSkills();
  const { openTarget, activeDocName, activeTarget, openTabs, activateTab } = useDocumentContext();
  const { merged, userBinding, projectLocalBinding } = useConfigContext();
  const tabBehavior: 'append' | 'replace-active' =
    (merged?.editor?.previewTabs ?? true) ? 'replace-active' : 'append';
  const showSkillGroups = merged?.appearance?.sidebar?.showSkillGroups ?? true;
  const pinnedByScope = {
    project: readPins(merged, 'project'),
    global: readPins(merged, 'global'),
  };
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
  const [userExpanded, setUserExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const { createBlank, creating } = useCreateBlankSkill();
  const [addSkill, setAddSkill] = useState<{ scope: SkillScope; tab: AddSkillTab } | null>(null);
  const [newSkillScope, setNewSkillScope] = useState<SkillScope | null>(null);

  const [detected, setDetected] = useState<CatalogSkill[] | null>(null);
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

  const filesByKey: Record<string, readonly { path: string }[]> = Object.fromEntries(
    skills.map((s) => [skillRowKey(s), (s.filePaths ?? []).map((path) => ({ path }))]),
  );

  const sectionRef = useRef<HTMLDivElement | null>(null);
  const lastScrollTopRef = useRef(0);
  const restoringRef = useRef(false);
  useEffect(() => {
    if (!dockExpanded) return;
    const scroller = sectionRef.current?.closest<HTMLElement>(DOCK_SCROLLER_SELECTOR);
    if (!scroller) return;
    const onScroll = () => {
      if (!restoringRef.current) lastScrollTopRef.current = scroller.scrollTop;
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [dockExpanded]);

  if (!dockExpanded) {
    return null;
  }

  const openSkillDoc = (docName: string) => {
    openTarget({ kind: 'doc', target: docName, docName }, { tabBehavior });
    pushHashWithoutNavigation(hashFromDocName(docName));
  };
  const openSkillMd = (skill: SkillsListEntry) => {
    openSkill(skill.scope, skill.name, {
      replaceActive: tabBehavior === 'replace-active',
      ...(skill.path ? { path: skill.path } : {}),
      ...(skill.hostQualifier !== undefined ? { host: skill.hostQualifier } : {}),
    });
  };
  const openPreviewReplacing = (target: SkillPreviewHashTarget) => {
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
    openPreviewReplacing({
      flavor: 'builtin',
      source: skillDir(skill.absolutePath ?? ''),
      name: skill.name,
      subtitle: '',
      level: skill.scope,
    });
  };
  const openFile = (skill: SkillsListEntry, filePath: string) => {
    if (skill.ignored === true && !skill.managed) {
      requestSkillTrackPrompt({ scope: skill.scope, name: skill.name });
      return;
    }
    const dot = filePath.lastIndexOf('.');
    const ext = dot >= 0 ? filePath.slice(dot + 1).toLowerCase() : '';
    if (!skill.managed && (ext === 'md' || ext === 'mdx')) {
      openSkillDoc(skillEntryFileLiveDocName(skill, filePath));
      return;
    }
    const host = hostQualifierOf(skill);
    openTarget(
      {
        kind: 'skill-file' as const,
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
    isSkillDocActive({
      activeTargetKind: activeTarget?.kind,
      activeDocName,
      openTabs,
      docName: skillEntryLiveDocName(skill),
    }) || isPreviewActiveFor(skill.name, skill.scope);

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
    const replaceActive = tabBehavior === 'replace-active';
    void openSkillForEdit(s.name, source, { replaceActive, rel }).then((r) => {
      if (!r.ok) toast.error(t`Couldn't open ${s.name} for editing: ${r.error}`);
    });
  };

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

  const skillSort = createSkillSortComparator(
    labelToScope,
    detectedByPrefix,
    groupByPrefix,
    skillByPrefix,
    pinnedPrefixes,
  );

  const stateKey = `${skills.map((s) => `${s.installed ? 1 : 0}`).join('')}|d${detectedByPrefix.size}`;

  const skillsLoading = state.status === 'loading';
  const treeKey = `${paths.join('|')}::${stateKey}::p${[...pinnedPrefixes].sort().join(',')}`;

  return (
    <SidebarGroup ref={sectionRef} className="px-0">
      <SidebarGroupContent>
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

const DOCK_SCROLLER_SELECTOR = '[data-slot="collapsible-content"]';

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
