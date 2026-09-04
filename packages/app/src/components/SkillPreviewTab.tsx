import {
  type PluginBundleMetadata,
  type PluginSourceMetadata,
  type SkillDetail,
  type SkillScope,
  skillsShSkillLinks,
} from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import { ArrowUpRightIcon, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { requestFilesSectionReveal } from '@/components/files-section-reveal-store';
import { SkillBundlePreview } from '@/components/SkillBundlePreview';
import { SkillEditorActions } from '@/components/SkillEditorActions';
import { SKILL_INSTALL_MENU_WIDTH, SkillInstallMenuItems } from '@/components/SkillInstallMenu';
import { SkillPluginBundleBanner } from '@/components/SkillPluginBundleBanner';
import type { SkillBundleDisclosure } from '@/components/SkillPluginBundleDialog';
import { SkillScopeSegment } from '@/components/SkillScopeSegment';
import { writeSkillsDockExpanded } from '@/components/skills-dock-expanded-store';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useDocumentContext } from '@/editor/DocumentContext';
import { parseEditorTabId } from '@/editor/editor-tabs';
import { useExplorePreviewInstall } from '@/hooks/use-explore-preview-install';
import { useOpenSkill } from '@/hooks/use-open-skill';
import { useSkillOrigin } from '@/hooks/use-skill-origin';
import { useSkills } from '@/hooks/use-skills';
import { hashFromSkillFile, hashFromSkillPreview, type SkillPreviewFlavor } from '@/lib/doc-hash';
import { skillEntryLiveDocName } from '@/lib/managed-artifact-doc-name';
import { openManagedArtifactTab } from '@/lib/open-managed-artifact-tab';
import { useSkillScopeLabels } from '@/lib/skill-scope';
import { discoverSkillsInSource, fetchSkillDetail, getSkillCurrentPath } from '@/lib/skills-api';

interface Props {
  flavor: SkillPreviewFlavor;
  source: string;
  name: string;
  subtitle: string;
  level?: SkillScope;
  reserveRightGutter?: boolean;
  path?: string;
}

const SKILL_MD = 'SKILL.md';

export function BuiltinHeaderActions({ scope, name }: { scope: SkillScope; name: string }) {
  const { origin, github, updateAvailable, reimport, reimporting } = useSkillOrigin({
    scope,
    name,
  });
  const install = <SkillEditorActions scope={scope} name={name} showNewFile={false} />;
  if (!origin) return <div className="flex gap-1">{install}</div>;
  return (
    <div className="flex items-center gap-1">
      {github ? (
        <Button variant="ghost" size="sm" className="px-2" asChild>
          <a href={github} target="_blank" rel="noreferrer">
            <Trans>Source</Trans>
            <ArrowUpRightIcon className="h-3.5 w-3.5" />
          </a>
        </Button>
      ) : null}
      {updateAvailable ? (
        <Button size="sm" onClick={() => void reimport()} disabled={reimporting}>
          {reimporting ? <Trans>Updating</Trans> : <Trans>Update</Trans>}
        </Button>
      ) : null}
      {install}
    </div>
  );
}

export function SkillPreviewTab({
  flavor,
  source,
  name,
  subtitle,
  level,
  reserveRightGutter,
  path,
}: Props) {
  const selectedPath = path ?? SKILL_MD;
  const scopeLabels = useSkillScopeLabels();
  const openSkill = useOpenSkill();
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [imageOk, setImageOk] = useState(true);

  useEffect(() => {
    if (flavor !== 'explore') return;
    let cancelled = false;
    void fetchSkillDetail({ source, name }).then((res) => {
      if (cancelled) return;
      if (res.ok) setDetail(res);
    });
    return () => {
      cancelled = true;
    };
  }, [flavor, source, name]);

  const [pluginInfo, setPluginInfo] = useState<PluginSourceMetadata | null>(null);
  const [pluginBundle, setPluginBundle] = useState<PluginBundleMetadata | null>(null);
  const marketplaceLinks = flavor === 'explore' ? skillsShSkillLinks(source, name) : null;
  const sourceUrl =
    flavor === 'explore'
      ? (detail?.sourceUrl ?? marketplaceLinks?.sourceUrl)
      : pluginInfo?.repositoryUrl;
  const sourceKind = detail?.sourceKind ?? marketplaceLinks?.sourceKind;
  const [siteSiblings, setSiteSiblings] = useState<readonly string[] | null>(null);
  useEffect(() => {
    setSiteSiblings(null);
    if (flavor !== 'explore' || sourceKind !== 'site') return;
    const ctrl = new AbortController();
    void discoverSkillsInSource(source, ctrl.signal).then((res) => {
      if (ctrl.signal.aborted || !res.ok) return;
      setSiteSiblings(res.skills.map((s) => s.name));
    });
    return () => ctrl.abort();
  }, [flavor, sourceKind, source]);
  const bundleDisclosure: SkillBundleDisclosure | null = pluginBundle
    ? {
        plugin: pluginBundle.plugin,
        names: pluginBundle.bundledSkills,
        capabilities: pluginBundle.capabilities,
        ...(pluginBundle.repositoryUrl ? { repositoryUrl: pluginBundle.repositoryUrl } : {}),
      }
    : siteSiblings
      ? { plugin: null, names: siteSiblings }
      : null;
  const detected = flavor === 'detected';
  const builtin = flavor === 'builtin';
  const linked = flavor === 'linked';
  const foreign = flavor === 'foreign';
  const targetScope: SkillScope = level ?? 'project';
  const previewInstall = useExplorePreviewInstall({
    source,
    name,
    initialScope: targetScope,
    marketplace: flavor === 'explore',
  });
  const redirectedRef = useRef(false);
  const [bulkInstalledName, setBulkInstalledName] = useState<string | null>(null);
  const landedName = previewInstall.importedName ?? bulkInstalledName;
  const landedScope = previewInstall.importedScope ?? previewInstall.scope;
  const { openTabs, closeTab } = useDocumentContext();
  const allSkills = useSkills();
  const [installMenuOpen, setInstallMenuOpen] = useState(false);
  const linkedEntry =
    linked && allSkills.status === 'ready'
      ? allSkills.data.find((sk) => sk.scope === targetScope && sk.name === name)
      : undefined;
  const importedNow =
    (flavor === 'explore' || foreign || pluginInfo !== null) && landedName !== null;
  useEffect(() => {
    if (
      !importedNow ||
      redirectedRef.current ||
      installMenuOpen ||
      previewInstall.toggles.installing
    )
      return;
    redirectedRef.current = true;
    const stalePreviewTabIds = openTabs.filter((id) => {
      const tab = parseEditorTabId(id);
      return tab.kind === 'skill-preview' && tab.name === name;
    });
    const openLanded = (path: string | undefined) => {
      openSkill(landedScope, landedName as string, {
        ...(path !== undefined ? { path } : {}),
        replaceActive: true,
        replaceHistory: true,
      });
      for (const id of stalePreviewTabIds) closeTab(id);
    };
    if (previewInstall.toggles.hostSet.size === 0) {
      openLanded(previewInstall.importedPath ?? undefined);
    } else {
      void getSkillCurrentPath(landedScope, landedName as string).then((current) =>
        openLanded(current ?? previewInstall.importedPath ?? undefined),
      );
    }
  }, [
    importedNow,
    installMenuOpen,
    landedScope,
    landedName,
    openSkill,
    openTabs,
    name,
    closeTab,
    previewInstall.importedPath,
    previewInstall.toggles.installing,
    previewInstall.toggles.hostSet,
  ]);
  const harnessLabel = subtitle ? subtitle.charAt(0).toUpperCase() + subtitle.slice(1) : subtitle;

  const levelLabel = scopeLabels[targetScope];
  const boldName = <strong className="font-medium text-foreground">{name}</strong>;
  const boldLevel = <strong className="font-medium text-foreground">{levelLabel}</strong>;
  const boldHarness = <strong className="font-medium text-foreground">{harnessLabel}</strong>;
  const pluginVersion = pluginInfo?.version ? ` (v${pluginInfo.version})` : '';
  const linkedFile = linkedEntry?.canonicalPath ?? linkedEntry?.path ?? null;
  const headerLine = linked ? (
    <Trans>
      {boldName} is a symlink — its editable source is{' '}
      <strong className="font-medium text-foreground">{linkedFile ?? source}</strong>. Edit the file
      there; this skill view is read-only.
    </Trans>
  ) : builtin ? (
    <Trans>
      This is a preview of {boldName} — a built-in skill shipped with Open Knowledge. It's
      read-only.
    </Trans>
  ) : pluginInfo ? (
    <Trans>
      {boldName} is part of the{' '}
      <strong className="font-medium text-foreground">{pluginInfo.plugin}</strong> plugin
      {pluginVersion} — read-only. {boldHarness} replaces plugin files on update.
    </Trans>
  ) : foreign ? (
    <Trans>
      {boldName} lives outside this project, at{' '}
      <strong className="font-medium text-foreground">{source}</strong> — agents running here can't
      load it. Copy it in to edit.
    </Trans>
  ) : detected ? (
    <Trans>
      This is a preview of {boldName}, detected in {boldHarness} at the {boldLevel} level.
    </Trans>
  ) : bundleDisclosure && bundleDisclosure.names.length > 1 ? (
    sourceKind === 'site' ? (
      <Trans>
        This is a preview of {boldName} — one of {bundleDisclosure.names.length} skills at this
        source. Install it into your agents.
      </Trans>
    ) : (
      <Trans>
        This is a preview of {boldName} — one of {bundleDisclosure.names.length} skills in this
        repo. Install it into your agents.
      </Trans>
    )
  ) : (
    <Trans>This is a preview of {boldName}. Install it into your agents.</Trans>
  );

  const headerActions = linked ? (
    <div className="flex items-center gap-1">
      {linkedEntry ? (
        <Button
          variant="ghost"
          size="sm"
          className="px-2"
          data-testid="skill-preview-open-source-file"
          onClick={() => {
            openManagedArtifactTab(skillEntryLiveDocName(linkedEntry));
            writeSkillsDockExpanded(false);
            requestFilesSectionReveal();
          }}
        >
          <Trans>Open file</Trans>
        </Button>
      ) : null}
      {}
      <SkillEditorActions scope={targetScope} name={name} showNewFile={false} />
    </div>
  ) : builtin ? (
    <BuiltinHeaderActions scope={targetScope} name={name} />
  ) : (
    <>
      <div className="flex gap-1">
        {detail?.skillsUrl ? (
          <Button variant="ghost" size="sm" className="px-2" asChild>
            <a href={detail.skillsUrl} target="_blank" rel="noreferrer">
              <Trans>skills.sh</Trans>
              <ArrowUpRightIcon className="h-3.5 w-3.5" />
            </a>
          </Button>
        ) : null}
        {sourceUrl ? (
          <Button variant="ghost" size="sm" className="px-2" asChild>
            <a href={sourceUrl} target="_blank" rel="noreferrer">
              {flavor === 'explore' && sourceKind === 'site' ? (
                <Trans>Source</Trans>
              ) : (
                <Trans>Repository</Trans>
              )}
              <ArrowUpRightIcon className="h-3.5 w-3.5" />
            </a>
          </Button>
        ) : null}
      </div>
      {!linked && (pluginInfo || !detected) ? (
        <DropdownMenu modal={false} onOpenChange={setInstallMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              disabled={previewInstall.toggles.installing}
              data-testid={
                pluginInfo
                  ? 'skill-preview-edit-a-copy'
                  : foreign
                    ? 'skill-preview-copy-in'
                    : undefined
              }
            >
              {previewInstall.toggles.installing ? (
                pluginInfo || foreign ? (
                  <Trans>Copying</Trans>
                ) : (
                  <Trans>Installing</Trans>
                )
              ) : (
                <>
                  {pluginInfo ? (
                    <Trans>Edit a copy</Trans>
                  ) : foreign ? (
                    <Trans>Copy in</Trans>
                  ) : bundleDisclosure && bundleDisclosure.names.length > 1 ? (
                    <Trans>Install this skill</Trans>
                  ) : (
                    <Trans>Install</Trans>
                  )}
                  <ChevronDown className="size-4 opacity-60" aria-hidden />
                </>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className={SKILL_INSTALL_MENU_WIDTH}>
            {}
            {pluginInfo || foreign ? (
              <>
                <DropdownMenuLabel className="font-normal text-muted-foreground text-xs leading-snug whitespace-normal">
                  <Trans>Pick where your copy goes. Choosing a destination creates it.</Trans>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <SkillScopeSegment
              value={previewInstall.scope}
              onSelect={previewInstall.setScope}
              disabled={previewInstall.scopeLocked}
            />
            <DropdownMenuSeparator />
            <SkillInstallMenuItems
              toggles={previewInstall.toggles}
              skill={{ scope: previewInstall.scope, name }}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </>
  );

  const onBundlePathClick = (clickedPath: string): boolean => {
    if (flavor === 'explore') {
      window.location.hash = hashFromSkillPreview({
        flavor,
        source,
        name,
        subtitle,
        level,
        path: clickedPath,
      });
      return true;
    }
    window.location.hash = hashFromSkillFile({
      scope: targetScope,
      name,
      path: clickedPath,
    });
    return true;
  };

  return (
    <SkillBundlePreview
      source={source}
      name={name}
      subtitle={subtitle}
      tintKey={subtitle || name}
      onBundlePathClick={onBundlePathClick}
      headerActions={headerActions}
      headerLine={headerLine}
      reserveRightGutter={reserveRightGutter}
      selectedPath={selectedPath}
      onPreviewMeta={(preview) => {
        const next = detected ? (preview.plugin ?? null) : null;
        setPluginInfo((current) =>
          current?.provider === next?.provider &&
          current?.plugin === next?.plugin &&
          current?.version === next?.version &&
          current?.marketplace === next?.marketplace &&
          current?.repositoryUrl === next?.repositoryUrl
            ? current
            : next,
        );
        setPluginBundle(flavor === 'explore' ? (preview.pluginBundle ?? null) : null);
      }}
      banner={
        bundleDisclosure ? (
          <SkillPluginBundleBanner
            bundle={bundleDisclosure}
            source={source}
            scope={previewInstall.scope}
            previewedName={name}
            onInstalled={(landed) => {
              const landedName = landed.get(name);
              if (landedName !== undefined) setBulkInstalledName(landedName);
            }}
          />
        ) : undefined
      }
      scope={builtin ? targetScope : undefined}
      noPreviewFallback={
        detail?.image && imageOk ? (
          <img
            src={detail.image}
            alt=""
            className="max-h-full max-w-full rounded-xl border border-border bg-muted"
            onError={() => setImageOk(false)}
          />
        ) : undefined
      }
    />
  );
}
