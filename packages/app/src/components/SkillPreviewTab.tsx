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
import { SkillBundlePreview } from '@/components/SkillBundlePreview';
import { SKILL_INSTALL_MENU_WIDTH, SkillInstallMenuItems } from '@/components/SkillInstallMenu';
import { SkillPluginBundleBanner } from '@/components/SkillPluginBundleBanner';
import type { SkillBundleDisclosure } from '@/components/SkillPluginBundleDialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useExplorePreviewInstall } from '@/hooks/use-explore-preview-install';
import { useOpenSkill } from '@/hooks/use-open-skill';
import { useSkillOrigin } from '@/hooks/use-skill-origin';
import { hashFromSkillFile, hashFromSkillPreview, type SkillPreviewFlavor } from '@/lib/doc-hash';
import { useSkillScopeLabels } from '@/lib/skill-scope';
import { discoverSkillsInSource, fetchSkillDetail } from '@/lib/skills-api';

interface Props {
  /** `explore` = a skills.sh catalog entry; `detected` = a skill found in another
   *  tool; `builtin` = one of OK's own shipped skills (read-only, nothing to import). */
  flavor: SkillPreviewFlavor;
  /** skills.sh source identifier for Explore, or a local directory for Detected. */
  source: string;
  name: string;
  /** Repo (explore) or the detected skill's source harness (which the manage action targets). */
  subtitle: string;
  /** The scope the skill sits at, shown read-only in the preview's Level row. */
  level?: SkillScope;
  /** Shift the header actions clear of the floating terminal reveal tab. */
  reserveRightGutter?: boolean;
  /** The selected bundle file (`SKILL.md` / `references/x.md`), from the hash —
   *  so a sidebar tree click and the preview's own FILES list share one
   *  selection. Absent = SKILL.md. */
  path?: string;
}

/**
 * Full-page, read-only preview of an un-imported skill, opened as its own tab
 * (not a modal) before the skill exists as a project doc. Wraps the shared
 * {@link SkillBundlePreview} with a Manage/Import action and, for skills.sh
 * results, the discovery links + Open Graph fallback. Once acquired the skill is
 * a real content doc, so we hand off to the live editor via `openManagedArtifactTab`.
 */
const SKILL_MD = 'SKILL.md';

/**
 * Provenance link + Update action for one of OK's built-in skills.
 *
 * Its own component so `useSkillOrigin` — whose update check dry-run-fetches
 * upstream — mounts ONLY for built-ins. Hoisting the hook into
 * {@link SkillPreviewTab} would fire that fetch for every explore/detected
 * preview too, which have no origin to re-pull.
 *
 * Built-ins carry no stored lockfile entry; the server synthesizes one from the
 * installed content (source `inkeep/open-knowledge-skills`, `autoUpdate: false`),
 * so the Update button is always a deliberate click and never an auto-apply.
 * Content stays read-only in-app — a re-pull is the sanctioned way it changes.
 */
export function BuiltinHeaderActions({ scope, name }: { scope: SkillScope; name: string }) {
  const { origin, github, updateAvailable, reimport, reimporting } = useSkillOrigin({
    scope,
    name,
  });
  if (!origin) return null;
  return (
    <div className="flex gap-1">
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
  // skills.sh discovery metadata (links + OG image); detected skills have none.
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

  // Plugin providers normalize their manifest/cache formats at the server
  // boundary. The UI never parses provider-specific paths.
  const [pluginInfo, setPluginInfo] = useState<PluginSourceMetadata | null>(null);
  // The skills.sh source repo is itself a plugin bundling several skills — the
  // disclosure that offers "import the whole set" (and is how a skill's
  // `/other-skill` refs resolve: siblings live in the same plugin).
  const [pluginBundle, setPluginBundle] = useState<PluginBundleMetadata | null>(null);
  const marketplaceLinks = flavor === 'explore' ? skillsShSkillLinks(source, name) : null;
  const sourceUrl =
    flavor === 'explore'
      ? (detail?.sourceUrl ?? marketplaceLinks?.sourceUrl)
      : pluginInfo?.repositoryUrl;
  const sourceKind = detail?.sourceKind ?? marketplaceLinks?.sourceKind;
  // A WEBSITE source has no plugin manifest to inspect — its `.well-known`
  // index is the only statement of what it publishes, and skills.sh surfaces
  // one skill at a time. Enumerate it so a multi-skill origin gets the same
  // sibling disclosure a plugin repo gets. Site-only: for a repo the preview's
  // own clone already answered this via `pluginBundle`, and enumerating anyway
  // would clone the repo a second time per preview open.
  const [siteSiblings, setSiteSiblings] = useState<readonly string[] | null>(null);
  useEffect(() => {
    // Clear FIRST: between two site-typed previews the source changes but the
    // effect only resolves asynchronously, so the previous source's sibling list
    // stayed on screen — the disclosure would offer to import skills that belong
    // to a different publisher.
    setSiteSiblings(null);
    if (flavor !== 'explore' || sourceKind !== 'site') return;
    const ctrl = new AbortController();
    void discoverSkillsInSource(source, ctrl.signal).then((res) => {
      if (ctrl.signal.aborted || !res.ok) return;
      setSiteSiblings(res.skills.map((s) => s.name));
    });
    return () => ctrl.abort();
  }, [flavor, sourceKind, source]);
  // One shape for the banner + picker: the plugin manifest when the source
  // declares one, else the website index's sibling list.
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
  const targetScope: SkillScope = level ?? 'project';
  // Explore and plugin-copy previews install through the shared per-agent menu.
  // Import is implied on the first destination choice, so opening/cancelling the
  // menu never creates a draft or silently privileges one skills root.
  const previewInstall = useExplorePreviewInstall({
    source,
    name,
    initialScope: targetScope,
    // Explore rows come from a skills.sh listing the user picked, so the
    // install counts toward it; the plugin-copy flow's source is a local
    // harness cache dir and must not be announced to the marketplace.
    marketplace: flavor === 'explore',
  });
  // The moment the IMPORT completes (bundle on disk), replace this preview with
  // the real editable skill tab — the editor-install fan-out keeps running in
  // the background and the INSTALLED badge catches up via the list refetch.
  // Waiting for the full install held the redirect hostage to the slowest copy.
  // Fire-once ref so re-renders can never re-dispatch the open (a replaceActive
  // loop is a crash).
  const redirectedRef = useRef(false);
  // A bulk plugin install lands entirely inside the banner, so `previewInstall`
  // (which only tracks ITS own import-then-place cycle) never sees it.
  const [bulkInstalledName, setBulkInstalledName] = useState<string | null>(null);
  const landedName = previewInstall.importedName ?? bulkInstalledName;
  const importedNow = (flavor === 'explore' || pluginInfo !== null) && landedName !== null;
  useEffect(() => {
    if (!importedNow || redirectedRef.current) return;
    redirectedRef.current = true;
    openSkill(previewInstall.scope, landedName as string, {
      replaceActive: true,
    });
  }, [importedNow, previewInstall.scope, landedName, openSkill]);
  // Capitalized harness for the header copy ("detected in Claude"), matching
  // the "From Claude" provenance chip.
  const harnessLabel = subtitle ? subtitle.charAt(0).toUpperCase() + subtitle.slice(1) : subtitle;

  // Left-side header sentence: states that this is a preview and names the exact
  // next action (matching the button) so a day-zero user knows nothing lands
  // until they click it. Bolds the skill name, source harness, and level for
  // scannability. `<strong>` wraps each variable so Lingui extracts them as
  // inline placeholders.
  const levelLabel = scopeLabels[targetScope];
  const boldName = <strong className="font-medium text-foreground">{name}</strong>;
  const boldLevel = <strong className="font-medium text-foreground">{levelLabel}</strong>;
  const boldHarness = <strong className="font-medium text-foreground">{harnessLabel}</strong>;
  const pluginVersion = pluginInfo?.version ? ` (v${pluginInfo.version})` : '';
  const headerLine = builtin ? (
    <Trans>
      This is a preview of {boldName} — a built-in skill shipped with Open Knowledge. It's
      read-only.
    </Trans>
  ) : pluginInfo ? (
    // A plugin-cache resident: the harness owns and replaces that folder on
    // plugin updates, so editing it in place would be silent data loss. The
    // one action is the way out: an editable copy the user owns.
    <Trans>
      {boldName} is part of the{' '}
      <strong className="font-medium text-foreground">{pluginInfo.plugin}</strong> plugin
      {pluginVersion} — read-only. {boldHarness} replaces plugin files on update.
    </Trans>
  ) : detected ? (
    // No action: a detected skill is edited in place from the sidebar.
    <Trans>
      This is a preview of {boldName}, detected in {boldHarness} at the {boldLevel} level.
    </Trans>
  ) : (
    // Import is implied — the action is "Install"; scope is chosen in the menu.
    <Trans>This is a preview of {boldName}. Install it into your agents.</Trans>
  );

  const headerActions = builtin ? (
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
      {pluginInfo || !detected ? (
        // Explore installs and plugin copies go through the SAME destination
        // menu. The first destination choice performs the import, so "Edit a
        // copy" never silently defaults to `.agents` or any other root.
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              disabled={previewInstall.toggles.installing}
              data-testid={pluginInfo ? 'skill-preview-edit-a-copy' : undefined}
            >
              {previewInstall.toggles.installing ? (
                pluginInfo ? (
                  <Trans>Copying</Trans>
                ) : (
                  <Trans>Installing</Trans>
                )
              ) : (
                <>
                  {pluginInfo ? <Trans>Edit a copy</Trans> : <Trans>Install</Trans>}
                  <ChevronDown className="size-4 opacity-60" aria-hidden />
                </>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className={SKILL_INSTALL_MENU_WIDTH}>
            <DropdownMenuLabel>
              <Trans>Level</Trans>
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={previewInstall.scope}
              onValueChange={(v) => previewInstall.setScope(v as SkillScope)}
            >
              <DropdownMenuRadioItem
                value="project"
                disabled={previewInstall.scopeLocked}
                onSelect={(e) => e.preventDefault()}
              >
                {scopeLabels.project}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem
                value="global"
                disabled={previewInstall.scopeLocked}
                onSelect={(e) => e.preventDefault()}
              >
                {scopeLabels.global}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
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

  // A clicked `references/…` chip opens that file the same way every other
  // bundle file opens: its own read-only skill-file tab, labelled by the file
  // (`references/x.md`) rather than by the skill. Matches the sidebar, so one
  // file has one tab and one label no matter which surface opened it.
  //
  // Only for a skill that exists on disk. An `explore` preview is un-imported,
  // so `/api/skill-file` has nothing to read — those keep selecting in place.
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
    // The hash IS the navigation spine — App's hashchange listener turns a
    // skill-file hash into the tab, so there is no second open path to keep in
    // step with the sidebar's.
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
        // The bundle disclosure is an EXPLORE concern (a fresh skills.sh source);
        // a detected/plugin-copy preview already lives on disk.
        setPluginBundle(flavor === 'explore' ? (preview.pluginBundle ?? null) : null);
      }}
      banner={
        bundleDisclosure ? (
          <SkillPluginBundleBanner
            bundle={bundleDisclosure}
            source={source}
            scope={previewInstall.scope}
            onInstalled={(landed) => {
              // The bulk import runs inside the banner, so `previewInstall`
              // never learns about it and the redirect effect below stays
              // dormant. Without this the tab keeps reading "This is a preview"
              // for a skill the user owns, its slash-links stay dead (preview
              // mode disables them), and its INSTALL menu is still armed — one
              // click from re-importing as `<name>-imported`.
              const landedName = landed.get(name);
              if (landedName !== undefined) setBulkInstalledName(landedName);
            }}
          />
        ) : undefined
      }
      // Only a built-in skill has real, resolvable bundle docs; passing its
      // scope lets `references/*` links in the SKILL.md resolve instead of
      // rendering broken (§8.3). An un-imported explore/detected skill has no
      // OK bundle docs, so leave its links unresolved.
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
