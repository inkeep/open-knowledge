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
  /** `explore` = a skills.sh catalog entry; `detected` = a skill found in another
   *  tool; `builtin` = one of OK's own shipped skills (read-only, nothing to import);
   *  `foreign` = a skill found in another tool but stored outside the open project,
   *  so the one action is a copy IN rather than an in-place edit. */
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
  // The install control renders even without an origin. Read-only bars edits,
  // not lifecycle — choosing which agents load a built-in is the one thing this
  // tab could not do, and the sidebar row is a poor place to hunt for it while
  // you are reading the skill.
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
  // A skill whose bundle is a SYMLINK into the content tree (a repo keeping its
  // plugin sources in `plugins/<x>/skills/` and linking them into
  // `.agents/skills/`). The FILE is the editable source of truth and opens as a
  // plain document from the Files tree; this skill-shaped view is read-only and
  // says so — the same edit-gate/lifecycle split built-ins have, for the same
  // reason: another owner holds the pen on the content.
  const linked = flavor === 'linked';
  // Lives outside the open project (parent checkout of a linked worktree, or any
  // other tree): read-only here, and the action copies it IN rather than editing
  // a file this project does not own.
  const foreign = flavor === 'foreign';
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
  // Redirect against the scope the bundle ACTUALLY landed at, never the live
  // `scope` selector. `useOpenSkill` resolves a skill's doc by (scope, name), so
  // if the selector has moved since the import — or the import ran at a scope the
  // selector no longer shows — the tab opens a document that does not exist and
  // strands on "Couldn't load document" until it times out. Falls back to the
  // selector only for the bulk-install path, which imports at the current scope
  // and reports no scope of its own.
  const landedScope = previewInstall.importedScope ?? previewInstall.scope;
  // Redirect as soon as the import/install REPORTS where it landed. This was
  // once gated on the skill appearing in the skills list, but that list lags
  // an install by a full refetch - seconds on a large content root - so the
  // preview sat un-redirected long enough to read as "install didn't open the
  // skill". `useOpenSkill` now resolves a not-yet-listed skill itself (fresh
  // fetch for project, direct managed doc for global) and busy-marks it
  // against the tab reconciler, so the early fire no longer burns the
  // fire-once attempt on a lookup that cannot succeed.
  //
  // Still gated on `landedName`, so previewing a marketplace skill whose name
  // already exists locally does not bounce you straight out of the preview.
  const { openTabs, closeTab } = useDocumentContext();
  const allSkills = useSkills();
  // While the destination menu is open the redirect HOLDS: the first toggle
  // imports and would otherwise replace this tab, unmounting the menu the user
  // is still picking editors in ("I wanted to click claude and stuff") — the
  // remaining choices become unreachable and the install reads as .agents-only.
  // The redirect fires when the menu closes; the fire-once ref still guards it.
  const [installMenuOpen, setInstallMenuOpen] = useState(false);
  const linkedEntry =
    linked && allSkills.status === 'ready'
      ? allSkills.data.find((sk) => sk.scope === targetScope && sk.name === name)
      : undefined;
  const importedNow =
    (flavor === 'explore' || foreign || pluginInfo !== null) && landedName !== null;
  useEffect(() => {
    // `installing` holds the redirect like the open menu does: an install
    // toggle can RELOCATE the just-imported bundle (set-exact fan-out picks
    // the canonical dir), and a redirect fired mid-install opens a doc whose
    // dir is about to move — the server auth-rejects it and the cleanup
    // closes the tab, landing the user on Home with nothing open.
    if (
      !importedNow ||
      redirectedRef.current ||
      installMenuOpen ||
      previewInstall.toggles.installing
    )
      return;
    redirectedRef.current = true;
    // Capture THIS preview's tab id(s) before opening, then close them after.
    // `replaceActive` only opens with preview DISPOSITION — it swaps whatever
    // holds the preview slot, which is not the same thing as replacing this tab.
    // A skill-preview tab opened permanently therefore survives, and the real
    // skill lands beside it: two tabs for one skill, the stale one still
    // advertising "Install it into your agents" for a skill you already own.
    const stalePreviewTabIds = openTabs.filter((id) => {
      const tab = parseEditorTabId(id);
      return tab.kind === 'skill-preview' && tab.name === name;
    });
    const openLanded = (path: string | undefined) => {
      openSkill(landedScope, landedName as string, {
        ...(path !== undefined ? { path } : {}),
        replaceActive: true,
        // This open REPLACES the preview the user is standing on, so it takes
        // that history entry rather than stacking a second one for the same skill.
        replaceHistory: true,
      });
      // After the open, so a failure to resolve can never leave zero tabs.
      for (const id of stalePreviewTabIds) closeTab(id);
    };
    if (previewInstall.toggles.hostSet.size === 0) {
      // The import's own path report: the open resolves with zero
      // skills-list round-trips, which on a large content root is the
      // difference between instant and seconds.
      openLanded(previewInstall.importedPath ?? undefined);
    } else {
      // An install toggle can RELOCATE the just-imported bundle (set-exact
      // fan-out picks the canonical dir), so the import-time path report may
      // now point at a dir that no longer exists — opening it auth-rejects
      // server-side and the tab self-closes to Home. Re-resolve the current
      // location with the per-skill detail read (fast; the skills LIST is
      // the read that lags by seconds on large roots), falling back to the
      // import report if the read fails.
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
    // A plugin-cache resident: the harness owns and replaces that folder on
    // plugin updates, so editing it in place would be silent data loss. The
    // one action is the way out: an editable copy the user owns.
    <Trans>
      {boldName} is part of the{' '}
      <strong className="font-medium text-foreground">{pluginInfo.plugin}</strong> plugin
      {pluginVersion} — read-only. {boldHarness} replaces plugin files on update.
    </Trans>
  ) : foreign ? (
    // Names the CHECKOUT, not the scope: scope reads identically for a skill
    // that works here and one that does not, so quoting it misleads.
    <Trans>
      {boldName} lives outside this project, at{' '}
      <strong className="font-medium text-foreground">{source}</strong> — agents running here can't
      load it. Copy it in to edit.
    </Trans>
  ) : detected ? (
    // No action: a detected skill is edited in place from the sidebar.
    <Trans>
      This is a preview of {boldName}, detected in {boldHarness} at the {boldLevel} level.
    </Trans>
  ) : bundleDisclosure && bundleDisclosure.names.length > 1 ? (
    // The source carries siblings: state the scope of Install up front — one
    // skill, not the set — so the bundle banner below never reads as "Install
    // takes all N".
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
    // Import is implied — the action is "Install"; scope is chosen in the menu.
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
            // "Open file" means "show me the real file": open the source doc
            // AND land the sidebar on the file browser with it revealed —
            // opening the tab alone left the sidebar parked on Skills Studio,
            // which reads as nothing happening.
            openManagedArtifactTab(skillEntryLiveDocName(linkedEntry));
            writeSkillsDockExpanded(false);
            requestFilesSectionReveal();
          }}
        >
          <Trans>Open file</Trans>
        </Button>
      ) : null}
      {/* Lifecycle is ordinary for a linked skill — read-only gates the EDIT,
          not which agents load it. */}
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
        // Explore installs and plugin copies go through the SAME destination
        // menu. The first destination choice performs the import, so "Edit a
        // copy" never silently defaults to `.agents` or any other root.
        <DropdownMenu
          // modal=false: the first destination pick triggers the import whose
          // auto-open REPLACES this tab, unmounting the menu mid-close. A modal
          // menu locks `body` with pointer-events:none while open, and that
          // abrupt unmount skips the unlock — the whole app then ignores every
          // click until reload (caught live: orphaned open menu + body stuck at
          // pointer-events:none). Non-modal never locks, so there is nothing to
          // leak; outside-click and Escape still dismiss.
          modal={false}
          onOpenChange={setInstallMenuOpen}
        >
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
                    // Scoped label: beside the bundle banner, a bare "Install"
                    // reads as possibly-all-N. Only the bundle case pays the
                    // longer label.
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
            {/* Says what the menu DOES, for the two buttons that promise a copy.
                Both open straight onto "Level" and a list of agent destinations,
                which reads as an install picker — so the person who clicked
                "Edit a copy" expecting a copy got a menu about somewhere else
                and stopped ("i thought clicking edit a copy would create a copy
                for me to edit?"). The destination choice IS the copy; that was
                only ever written in a code comment. Install needs no such line:
                the button already names what the menu does. */}
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
            previewedName={name}
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
