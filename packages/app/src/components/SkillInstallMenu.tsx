import type {
  SkillInstallTarget,
  SkillsListEntry,
  SkillTargetEditor,
} from '@inkeep/open-knowledge-core';
import {
  EDITOR_LABELS,
  isSkillInstallTarget,
  SkillTargetEditorSchema,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { Folder, Settings as SettingsIcon } from 'lucide-react';
import { type ReactElement, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { AgentBrandIcon } from '@/components/AgentIconCluster';
import { ChangedOutsideBadge } from '@/components/ChangedOutsideBadge';
import type { SkillActions } from '@/components/skill-actions';
import {
  SkillMenuCheckboxItem,
  SkillMenuItem,
  type SkillMenuKind,
  SkillMenuLabel,
  SkillMenuSeparator,
} from '@/components/skill-menu-primitives';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSkills } from '@/hooks/use-skills';
import { emitSkillsChanged } from '@/lib/documents-events';
import {
  getSkillOverlay,
  setSkillOverlay,
  skillOverlayKey,
  subscribeToSkillOverlay,
} from '@/lib/skill-install-overlay-store';
import { aliasSubscribersOf, customPlacementRoot, skillHostRootDir } from '@/lib/skill-scope';
import { placeSkill, putSkillFolderAction, setSkillSource, unplaceSkill } from '@/lib/skills-api';

// The editors a project skill can install into — the narrowed `.options` of the
// canonical schema, so this can never drift from the install verb + picker. The
// editor toolbar badge reuses this for its installed-agent icon cluster (stable
// order + `SkillTargetEditor` typing for `TargetIcon`).
export const INSTALL_EDITORS: readonly SkillTargetEditor[] = SkillTargetEditorSchema.options;

/**
 * Width floor for any container holding {@link SkillInstallMenuItems}.
 *
 * The rows ARE paths (`~/.opencode/skills/<name>`), and a truncated path is the
 * one thing this menu cannot afford to hide — it is the whole disclosure. Each
 * surface used to pick its own width, so the same menu clipped in the toolbar
 * and fit in the sidebar. One constant, applied at every call site.
 */
export const SKILL_INSTALL_MENU_WIDTH = 'min-w-[24rem]';

export interface SkillHostToggles {
  hostSet: ReadonlySet<string>;
  installed: boolean;
  installing: boolean;
  toggleEditor: (editor: SkillInstallTarget, on: boolean) => void;
  installAll: () => void;
  /** The skill's effective fan-out mode as the server reports it — new
   *  locations land this way. Read-only: mode is chosen per LOCATION now
   *  (`convertLocation`), never flipped skill-wide from the menu. */
  linkMode: boolean;
  /** Make ONE host's location the source (pure move; sticky).
   *  OPTIONAL: a surface with no installed locations (the un-imported preview)
   *  omits the location verbs, and the controls for them are gated on presence —
   *  a no-op stub renders a button whose only failure mode is silence. */
  setSource?: (host: string) => void;
  /** Place a copy/link of the skill under a known custom root. */
  placeAt: (root: string, mode: 'copy' | 'link') => void;
  /** Remove a recorded custom placement (the inverse of `placeAt`). */
  unplaceAt?: (path: string) => void;
  /** Convert ONE installed location between copy and symlink. Siblings are
   *  untouched. */
  convertLocation?: (target: string, mode: 'copy' | 'link') => void;
  /** Convert SEVERAL locations in one sequential run (the menu's convert-all). */
  convertLocations?: (targets: readonly { target: string; mode: 'copy' | 'link' }[]) => void;
  /** Source host with the optimistic overlay applied (instant tag flip). */
  sourceHost?: string;
}

/**
 * The per-editor install-state machine, shared by the editor toolbar's install
 * pill (`SkillEditorActions`) and every `SkillContextMenuItems` surface so the
 * toolbar, sidebar, and editor tab all expose the same install controls.
 *
 * Optimistic host overlay so RAPID per-editor toggles compose correctly: each click
 * builds on the LATEST intended set (via `liveHostsRef`, updated synchronously), not
 * the last server refetch (which lags a click or two). The actual install is DEBOUNCED
 * so N quick clicks become ONE set-exact write, avoiding concurrent installs racing on
 * the marker file. `actions` is passed in so both surfaces share one install-in-flight.
 *
 * The overlay itself lives in a module store keyed `scope:name`, NOT in component
 * state: several surfaces can be on screen together, and a per-component overlay
 * meant the clicked one read "Installed" while its neighbour still read "Install".
 */
export function useSkillHostToggles(
  skill: SkillsListEntry,
  actions: SkillActions,
): SkillHostToggles {
  const inFlight = actions.installingName === skill.name;
  // A write is not "done" when its request returns — it is done when the list
  // reflects it. The write triggers a watcher refetch, so between the request
  // returning and that refetch landing the menu is still rendering the state
  // from BEFORE (or mid-way through) the write. Treating that window as settled
  // is what let a location flash a form tag it never earned. Stay busy until
  // the entry actually changes.
  const settledEntryRef = useRef(skill);
  const [awaitingRefetch, setAwaitingRefetch] = useState(false);
  const wasInFlight = useRef(false);
  useEffect(() => {
    if (wasInFlight.current && !inFlight) setAwaitingRefetch(true);
    wasInFlight.current = inFlight;
  }, [inFlight]);
  useEffect(() => {
    if (skill !== settledEntryRef.current) {
      settledEntryRef.current = skill;
      setAwaitingRefetch(false);
    }
  }, [skill]);
  const installing = inFlight || awaitingRefetch;
  const overlayKey = skillOverlayKey(skill.scope, skill.name);
  const overlay = useSyncExternalStore(
    (onChange) => subscribeToSkillOverlay(overlayKey, onChange),
    () => getSkillOverlay(overlayKey),
  );
  const optimisticHosts = overlay.hosts;
  // Instant-feedback overlay for the slower source move: applied on click,
  // cleared when the refetched entry catches up (or rolled back on failure).
  // The disk work can take a moment; the menu can't.
  const optimisticSource = overlay.source;
  useEffect(() => {
    if (optimisticSource !== null && skill.hosts[0] === optimisticSource)
      setSkillOverlay(overlayKey, { source: null });
  }, [skill.hosts, optimisticSource, overlayKey]);
  const serverLink = skill.linkMode === true;
  const effectiveHosts = optimisticHosts ?? skill.hosts;
  const hostSet = new Set(effectiveHosts);
  const installed = optimisticHosts ? optimisticHosts.length > 0 : skill.installed;

  const liveHostsRef = useRef<string[]>(skill.hosts);
  // Re-sync the ref to server truth whenever the overlay is cleared.
  useEffect(() => {
    if (optimisticHosts === null) liveHostsRef.current = skill.hosts;
  }, [optimisticHosts, skill.hosts]);

  // Drop the overlay once the server's fetched hosts catch up to it.
  const serverHostsKey = [...skill.hosts].sort().join(',');
  useEffect(() => {
    const pending = getSkillOverlay(overlayKey).hosts;
    if (pending && [...pending].sort().join(',') === serverHostsKey)
      setSkillOverlay(overlayKey, { hosts: null });
  }, [serverHostsKey, overlayKey]);

  const installTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingInstallRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      if (installTimer.current) clearTimeout(installTimer.current);
      pendingInstallRef.current?.();
      pendingInstallRef.current = null;
    },
    [],
  );
  function commitHosts(nextHosts: string[], debounce: boolean) {
    liveHostsRef.current = nextHosts;
    setSkillOverlay(overlayKey, { hosts: nextHosts });
    if (installTimer.current) clearTimeout(installTimer.current);
    // On failure the server state is unchanged; roll back the overlay so the pill
    // doesn't stick on the attempted set (the refetch returns the OLD hosts, which
    // never match the overlay, so the convergence effect never clears it).
    //
    // The REQUEST carries only install-target editor ids: an in-place skill's
    // hosts include non-editor members (the `.agents` hub), which the server's
    // targets schema rejects — but they stay in the OVERLAY so it converges with
    // the refetched host set.
    const run = async () => {
      pendingInstallRef.current = null;
      installTimer.current = null;
      const result = await actions.install(skill, nextHosts.filter(isSkillInstallTarget));
      if (!result.ok) {
        setSkillOverlay(overlayKey, { hosts: null });
        return;
      }
      // Snap the overlay to the SERVER's post-op host set — the response can
      // legitimately differ from the click-set (hub/alias-covered hosts,
      // conflict skips), and an overlay that never matches the refetched list
      // would otherwise stick forever, hiding real state.
      liveHostsRef.current = [...result.hosts];
      setSkillOverlay(overlayKey, { hosts: [...result.hosts] });
    };
    if (debounce) {
      pendingInstallRef.current = () => void run();
      installTimer.current = setTimeout(() => void run(), 350);
    } else {
      pendingInstallRef.current = null;
      void run();
    }
  }

  return {
    hostSet,
    installed,
    installing,
    toggleEditor(editor, on) {
      const next = new Set<string>(liveHostsRef.current);
      if (on) next.add(editor);
      else next.delete(editor);
      commitHosts([...next], true);
    },
    installAll() {
      // Preserve non-editor hosts (the `.agents` hub) in the overlay set.
      const nonEditor = liveHostsRef.current.filter(
        (h) => !(INSTALL_EDITORS as readonly string[]).includes(h),
      );
      // "All" targets only editors installable on THIS machine for the
      // scope (plus any the skill is already in) — installing into an undetected
      // editor just no-ops and reverts.
      const installable = skill.installableEditors ?? INSTALL_EDITORS;
      const editors = INSTALL_EDITORS.filter(
        (e) => installable.includes(e) || liveHostsRef.current.includes(e),
      );
      commitHosts([...nonEditor, ...editors], false);
    },
    linkMode: serverLink,
    sourceHost: optimisticSource ?? skill.hosts[0],
    placeAt(root, mode) {
      // Report failures. The same control on an un-imported preview toasts, so
      // silence here meant a permission error or a refused hand-edited copy
      // just left the checkbox un-flipped with no explanation.
      void actions
        .runLocationWrite(skill, () =>
          placeSkill({ scope: skill.scope, name: skill.name, dir: root, mode }),
        )
        .then((r) => {
          if (!r.ok) toast.error(r.error);
        });
    },
    unplaceAt(path) {
      void actions
        .runLocationWrite(skill, () => unplaceSkill({ scope: skill.scope, name: skill.name, path }))
        .then((r) => {
          if (!r.ok) toast.error(r.error);
        });
    },
    setSource(host) {
      setSkillOverlay(overlayKey, { source: host });
      void actions
        .runLocationWrite(skill, () =>
          setSkillSource({ scope: skill.scope, name: skill.name, target: host }),
        )
        .then((r) => {
          if (!r.ok) {
            setSkillOverlay(overlayKey, { source: null });
            toast.error(r.error);
          }
        });
    },
    convertLocation(target, mode) {
      // No optimistic overlay: the row's form is read from the disk scan
      // (`symlinkedHosts` / placement modes), which the `skills-changed` refetch
      // refreshes. Guessing here would fight that read on failure. Routed
      // through the shared action so the surfaces showing this skill report
      // "Working" while folders are being rewritten.
      void actions.convertLocations(skill, [{ target, mode }]);
    },
    convertLocations(targets) {
      void actions.convertLocations(skill, targets);
    },
  };
}

/**
 * A menu hint, rendered through Radix instead of the native `title` attribute.
 *
 * Native tooltips do not appear at all while the window is unfocused, and they
 * arrive on the OS's own delay — so the hints here, which are the ONLY place
 * several of these controls explain themselves (a checked row's hint is where
 * "click to remove" is written, and the brand marks are unreadable without one),
 * were invisible exactly when someone was reading the menu with their attention
 * elsewhere. `side="right"` keeps the hint clear of the row beneath it.
 */
function Hint({ hint, children }: { hint: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" className="max-w-xs">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The install control's menu body — per-editor checkboxes + Install-on-all +
 * Uninstall. Renders inside a `DropdownMenuContent` (toolbar pill) OR a
 * `DropdownMenuSubContent` (sidebar three-dot submenu), so both surfaces are
 * behaviorally identical. Checkbox rows keep the menu OPEN on toggle so several
 * editors can be flipped in a row (§9.1); the title hint makes uninstall
 * discoverable (§9.2).
 */
export function SkillInstallMenuItems({
  toggles,
  skill,
  onResolveFork,
  onRunStart,
  menuKind = 'dropdown',
}: {
  toggles: SkillHostToggles;
  /** Each row shows the REAL target path (`.codex/skills/<name>`) — path-first
   *  disclosure of what installing actually copies where. `hosts` /
   *  `symlinkedHosts` (when present) mark THE source row and link rows. Always
   *  passed (every install surface has a skill); the detail fields stay Partial
   *  because an un-imported preview carries only `{scope, name}`. */
  skill: Pick<SkillsListEntry, 'scope' | 'name'> &
    Partial<
      Pick<
        SkillsListEntry,
        | 'hosts'
        | 'symlinkedHosts'
        | 'path'
        | 'customPlacements'
        | 'hostAliases'
        | 'conflictHosts'
        | 'driftPaths'
        | 'installableEditors'
      >
    >;
  /** Opens the fork-resolution dialog for a conflicted editor's copy. */
  onResolveFork?: (editor: string) => void;
  /**
   * Fired when a click kicks off a run that rewrites folders. The surface that
   * owns this popover closes it: the rows are read from a disk scan that
   * refetches mid-run, so leaving it open shows form and drift marks for a
   * half-converted state — they flip and then settle, which reads as breakage.
   */
  onRunStart?: () => void;
  /** Match the Radix primitive family of the parent menu. */
  menuKind?: SkillMenuKind;
}) {
  const { t } = useLingui();
  const { hostSet, toggleEditor, installAll } = toggles;
  const pathFor = (host: string): string | null =>
    skill ? `${skillHostRootDir(host, skill.scope)}/${skill.name}` : null;
  const allSkills = useSkills();
  // The `.agents` hub is EXISTENCE-ACTIVATED: offered only when this project
  // already adopted it (any skill lives there or lists it as a host). OK never
  // pushes the hub on a repo — adopting it is one Custom path away, and the
  // first placement there lights this row up for every skill.
  const hubActive =
    skill !== undefined &&
    ((skill.hosts ?? []).includes('agents') ||
      (allSkills.status === 'ready' &&
        allSkills.data.some((s) => s.hosts.includes('agents') || s.path.startsWith('.agents/'))));
  // Folder-level aliases (host id → base-relative target root). An aliased
  // folder is a derived view of its target: NO row of its own (checking it
  // could only write through the alias), its agent icon rides the target
  // root's row instead. Observable disk facts only — a row's audience is the
  // set of folders that resolve into it, never a vendor-capability claim.
  // Folder-level links are a property of the SCOPE's dirs, not of one skill —
  // a not-yet-installed skill (explore preview) has no entry to carry them, so
  // fall back to the union across installed same-scope skills; otherwise the
  // preview menu shows aliased folders as plain rows (inconsistent menus).
  const aliases: Record<string, string> =
    skill?.hostAliases ??
    (skill && allSkills.status === 'ready'
      ? Object.assign(
          {},
          ...allSkills.data.filter((s) => s.scope === skill.scope).map((s) => s.hostAliases ?? {}),
        )
      : {});
  // only OFFER editors installable on THIS machine for the skill's
  // scope — for global skills that is the set whose user-home dir exists, so we
  // don't show an editor (e.g. Copilot with no `~/.copilot`) whose install
  // silently no-ops and flashes a checkmark that reverts. Same same-scope
  // fallback as `aliases` for a preview skill that carries no entry of its own;
  // null = no data → offer everything (never over-hide). The `.agents` hub and
  // any editor the skill is ALREADY in are always kept (uninstall stays reachable).
  const installableList: readonly string[] | undefined =
    skill?.installableEditors ??
    (skill && allSkills.status === 'ready'
      ? allSkills.data.find((s) => s.scope === skill.scope)?.installableEditors
      : undefined);
  const installable = installableList ? new Set<string>(installableList) : null;
  const rows: Array<SkillInstallTarget> = (
    hubActive ? (['agents', ...INSTALL_EDITORS] as const) : INSTALL_EDITORS
  )
    .filter((e) => !(e in aliases))
    .filter((e) => e === 'agents' || installable === null || installable.has(e) || hostSet.has(e));
  const stdPaths = new Set(rows.map((e) => pathFor(e)));
  const homePrefix = skill?.scope === 'global' ? '~/' : '';
  // `path` is `<dir>/SKILL.md`; the guard on '/' skips placeholder entries.
  const entryDir = skill?.path?.includes('/')
    ? `${homePrefix}${skill.path.replace(/\/SKILL\.mdx?$/i, '')}`
    : null;
  const sourceRow = entryDir !== null && !stdPaths.has(entryDir) ? entryDir : null;
  // A host row carries the SOURCE badge ONLY when the skill's real dir IS that
  // host's dir (in-place skills). A store-backed skill's source is its own
  // row (`sourceRow`) — badging hosts[0] there showed TWO sources.
  const sourceHost = sourceRow === null ? (toggles.sourceHost ?? skill?.hosts?.[0]) : undefined;
  const subscribersOf = (rootRel: string): string[] => aliasSubscribersOf(aliases, rootRel);
  const hostLabel = (h: string): string =>
    h === 'agents' ? '.agents' : ((EDITOR_LABELS as Record<string, string>)[h] ?? h);
  // Friction dialog 2 (locked design): checking a row read by MORE than its
  // own agent states the actual reach before writing.
  // ponytail: native confirm(); swap for AlertDialog if the menu grows one.
  const confirmReach = (rootRel: string): boolean => {
    const subs = subscribersOf(rootRel);
    if (subs.length === 0) return true;
    return window.confirm(
      t`Adds the skill to ${rootRel} — also read by ${subs.map(hostLabel).join(', ')}`,
    );
  };
  // Audience icons are the A3 trigger (user-locked): clicking the codex mark
  // on a pool row means "codex shouldn't get this skill". The remedy is
  // remedy 2 of the locked design — the subscriber's folder stops FOLLOWING
  // the pool and keeps every other skill it sees (per-skill links), minus
  // this one. Remedy 1 (move the source out) stays available via the
  // source/remove controls. Plain confirm, then the folder verb.
  const audienceIcon = (h: string, poolRootRel: string) => {
    const subRoot = h.includes('/') ? h : skillHostRootDir(h, skill?.scope ?? 'project');
    return (
      <Hint
        key={h}
        hint={t`${hostLabel(h)} reads this skill via ${poolRootRel}. Click to stop ${hostLabel(h)} getting "${skill?.name ?? ''}" — ${subRoot} keeps its other skills but stops following ${poolRootRel}.`}
      >
        <Button
          variant="ghost"
          size="sm"
          className="h-4 shrink-0 px-0"
          // The icon is the only child and is aria-hidden, so without this the
          // control announces as an unlabeled button — and it rewrites folders.
          // A tooltip is not an accessible name.
          aria-label={t`Stop ${hostLabel(h)} reading this skill`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (
              !window.confirm(
                t`Stop ${hostLabel(h)} reading "${skill.name}"? ${subRoot} will keep its other skills (as symlinks) but stop following ${poolRootRel} — new skills added there won't reach ${hostLabel(h)} automatically.`,
              )
            )
              return;
            void putSkillFolderAction({
              scope: skill.scope,
              root: subRoot,
              action: 'unlink',
              exclude: [skill.name],
            }).then((r) => {
              if (!r.ok) toast.error(t`Couldn't update ${subRoot}: ${r.error}`);
              // Refresh locally like the Settings folders surface does. Relying
              // on the cross-client signal alone left the chip looking unclicked
              // for a beat — the same verb, two latencies.
              else emitSkillsChanged();
            });
          }}
          data-testid={`skill-audience-unfollow-${h}`}
        >
          <AgentBrandIcon host={h} aria-hidden className="size-3.5" />
        </Button>
      </Hint>
    );
  };
  const conflicted = new Set(skill?.conflictHosts ?? []);
  // Drift = OK's record of what it wrote disagrees with disk (another tool
  // rewrote the path). PASSIVE disclosure only — OK only writes on explicit
  // clicks, so there is no war to referee and no hands-off state to manage.
  // Ledger paths are base-relative; display paths may carry `~/` — strip.
  const drifted = new Set(skill?.driftPaths ?? []);
  // While a run is in flight the folders are mid-rewrite and the list refetches
  // underneath us, so per-row form and drift are snapshots of a half-converted
  // state — they flip to "symlink"/"changed outside" and then settle, which
  // reads as breakage rather than progress. Freeze the menu for the run: no
  // second click can land on state that is about to change, and the transient
  // per-row marks stay hidden until it settles.
  const busy = toggles.installing;
  const relOf = (display: string | null): string => (display ?? '').replace(/^~\//, '');
  const linked = new Set(skill?.symlinkedHosts ?? []);
  // The mode a location is EXPECTED to have: what the skill's other locations
  // are, falling back to the server's effective preference when there are none
  // to compare against. A row matching this says nothing (a menu of identical
  // COPY tags was pure noise); a row that DIVERGES gets a tag that converts it.
  const otherStates: Array<'copy' | 'link'> = [
    ...[...hostSet]
      .filter((h) => h !== sourceHost && !(h in aliases) && !conflicted.has(h) && !h.includes('/'))
      .map((h) => (linked.has(h) ? ('link' as const) : ('copy' as const))),
    ...(skill?.customPlacements ?? []).map((cp) => cp.mode),
  ];
  const linkCount = otherStates.filter((st) => st === 'link').length;
  const expectedMode: 'copy' | 'link' =
    otherStates.length === 0
      ? toggles.linkMode
        ? 'link'
        : 'copy'
      : linkCount * 2 >= otherStates.length
        ? 'link'
        : 'copy';
  // Every location this skill has BESIDES its source, with the form each one is
  // in — the same membership `otherStates` measures, kept addressable so the
  // skill-wide convert below can write each one. The source is never included:
  // it is the real folder the others copy or point at.
  const convertible: Array<{ target: string; display: string; mode: 'copy' | 'link' }> = [
    ...[...hostSet]
      .filter((h) => h !== sourceHost && !(h in aliases) && !conflicted.has(h) && !h.includes('/'))
      .map((h) => ({
        target: h,
        display: pathFor(h) ?? hostLabel(h),
        mode: linked.has(h) ? ('link' as const) : ('copy' as const),
      })),
    ...(skill?.customPlacements ?? []).map((cp) => ({
      target: customPlacementRoot(cp),
      display: `${homePrefix}${cp.path}`,
      mode: cp.mode,
    })),
  ];
  // Row-level convert (never skill-wide): state the whole effect, then write
  // exactly one path. The old skill-wide Copies/Symlinks tabs silently
  // reconverted every existing location on click, which is what this replaces.
  // ponytail: native confirm(), like the two friction dialogs above.
  const convertRow = (target: string, display: string, from: 'copy' | 'link') => {
    const to: 'copy' | 'link' = from === 'link' ? 'copy' : 'link';
    return (
      <Hint
        hint={
          from === 'link'
            ? t`${display} is a symlink to the source while the skill's other locations are copies. Click to make it an independent copy.`
            : t`${display} is an independent copy while the skill's other locations are symlinks. Click to make it a symlink to the source.`
        }
      >
        <Button
          variant="ghost"
          size="sm"
          className="h-5 shrink-0 rounded border border-yellow-500/40 bg-yellow-500/10 px-1 font-normal text-[10px] text-yellow-600 uppercase tracking-wide hover:bg-yellow-500/20"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (
              !window.confirm(
                to === 'link'
                  ? t`Replace the copy at ${display} with a symlink to the skill's source folder? Nothing else moves.`
                  : t`Replace the symlink at ${display} with an independent copy of the skill? Nothing else moves.`,
              )
            )
              return;
            onRunStart?.();
            toggles.convertLocation?.(target, to);
          }}
          data-testid={`skill-convert-${target}`}
        >
          {from === 'link' ? <Trans>symlink</Trans> : <Trans>copy</Trans>}
        </Button>
      </Hint>
    );
  };
  // Non-standard locations that actually hold this skill get their own rows:
  // the skill's OWN folder when it isn't an editor dir (e.g. a `.ok/skills`
  // store bundle — the true SOURCE), and every recorded custom placement.
  // KNOWN custom roots travel between SKILLS (per-machine): every distinct
  // parent dir any skill at this scope has a recorded placement under becomes
  // an offerable row on EVERY skill's menu — use a custom path once and it's a
  // first-class choice from then on. Checked when THIS skill is placed there.
  const myPlacements = new Map(
    (skill?.customPlacements ?? []).map((cp) => [customPlacementRoot(cp), cp]),
  );
  const knownRoots = new Set<string>(myPlacements.keys());
  if (allSkills.status === 'ready' && skill) {
    for (const s of allSkills.data) {
      if (s.scope !== skill.scope) continue;
      for (const cp of s.customPlacements ?? []) {
        const root = customPlacementRoot(cp);
        // `.ok/skills` is the retired store, offered like any other custom root
        // so projects that still keep skills there can manage them; the rest of
        // `.ok/` is OK's own state and the server refuses it.
        if (root !== '') knownRoots.add(root);
      }
    }
  }
  const customRootRows =
    skill !== undefined
      ? [...knownRoots]
          .sort()
          .map((root) => ({
            root,
            display: `${homePrefix}${root}/${skill.name}`,
            placed: myPlacements.get(root) ?? null,
          }))
          // Alias-covered custom roots (a folder-symlink into another root)
          // get NO row — same rule as editor folders: their icon rides the
          // target root's audience instead.
          .filter((r) => !stdPaths.has(r.display) && r.display !== entryDir && !(r.root in aliases))
      : [];
  return (
    <>
      {/* NO skill-wide Copies/Symlinks tabs: they applied the chosen mode to
          EVERY existing location on click, so opening the menu and tapping the
          mode you thought you were already in silently rewrote every install.
          A new location follows the skill's existing ones (symlinks for a
          skill that has none yet — one real folder, no duplicated bytes in
          git); a location that diverges carries its own convert control. */}
      {/* "All" rides the section label instead of being its own bottom row —
          the old footer (Install-on-all + Settings, each fenced by separators)
          read as three stacked strips. */}
      <SkillMenuLabel menuKind={menuKind} className="flex items-center justify-between gap-2">
        <Trans>Install on</Trans>
        <Hint hint={t`Install on all agents`}>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 font-normal text-[11px] text-muted-foreground hover:text-foreground"
            disabled={busy}
            onClick={() => installAll()}
            data-testid="skill-install-all"
          >
            <Trans>All</Trans>
          </Button>
        </Hint>
      </SkillMenuLabel>
      {/* The skill's OWN folder when it isn't a standard editor dir (a store
          bundle / unusual location) — the true SOURCE, shown so no occupied
          location is ever invisible here. Static: the source can't be
          unchecked (that would be deletion). */}
      {sourceRow !== null ? (
        <Hint hint={t`The skill's own folder — the source other locations copy or link from`}>
          <SkillMenuCheckboxItem
            menuKind={menuKind}
            disabled={busy}
            checked
            onSelect={(e) => e.preventDefault()}
            data-testid="skill-source-row"
          >
            {/* Every custom root gets the same mark. `.ok/skills` is an
                ordinary one — branding it read as "OK's official home for
                skills", which is exactly the standing the store no longer has. */}
            <Folder aria-hidden className="size-4 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span className="min-w-0 truncate font-mono text-xs">{sourceRow}</span>
              {(() => {
                const rootRel = relOf(sourceRow).split('/').slice(0, -1).join('/');
                const subs = subscribersOf(rootRel);
                return subs.length > 0 ? (
                  <span
                    className="flex shrink-0 items-center gap-0.5"
                    data-testid="skill-row-audience-source"
                  >
                    {subs.map((h) => audienceIcon(h, rootRel))}
                  </span>
                ) : null;
              })()}
              <span className="inline-flex h-5 shrink-0 items-center rounded border border-border/60 px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                <Trans>source</Trans>
              </span>
            </span>
          </SkillMenuCheckboxItem>
        </Hint>
      ) : null}
      {rows.map((editor) => {
        const path = pathFor(editor);
        const label = editor === 'agents' ? '.agents' : EDITOR_LABELS[editor];
        const rootRel = relOf(path).split('/').slice(0, -1).join('/');
        const audience = subscribersOf(rootRel);
        return (
          <Hint
            key={editor}
            hint={
              conflicted.has(editor)
                ? t`A DIFFERENT skill named like this one lives at ${path ?? label} — that folder is not this skill. Rename or delete one of the two to resolve.`
                : editor === sourceHost
                  ? path
                    ? t`The skill's own folder (${path}) — the source other locations copy or link from`
                    : label
                  : hostSet.has(editor)
                    ? path
                      ? t`Installed at ${path} — click to remove`
                      : t`Installed in ${label} — click to remove`
                    : path
                      ? expectedMode === 'link'
                        ? t`Symlinks the skill to ${path}`
                        : t`Copies the skill to ${path}`
                      : t`Click to install in ${label}`
            }
          >
            <SkillMenuCheckboxItem
              menuKind={menuKind}
              disabled={busy}
              checked={hostSet.has(editor)}
              onCheckedChange={(on) => {
                // Conflicted slot: occupied by a DIFFERENT skill — nothing to
                // install or remove here (the hint explains).
                if (conflicted.has(editor)) return;
                if (on === true && !confirmReach(rootRel)) return;
                toggleEditor(editor, on === true);
              }}
              onSelect={(e) => e.preventDefault()}
              className="group"
              data-testid={`skill-install-editor-${editor}`}
            >
              <AgentBrandIcon host={editor} aria-hidden className="size-4" />
              {/* Path-first: the row IS the destination path (the brand icon
                carries the editor identity); no brand words to decode. */}
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="min-w-0 truncate font-mono text-xs">{path ?? label}</span>
                {/* Audience: folders that resolve INTO this row's root (their
                  own rows are omitted) — who else reads what lands here. */}
                {audience.length > 0 ? (
                  <span
                    className="flex shrink-0 items-center gap-0.5"
                    data-testid={`skill-row-audience-${editor}`}
                  >
                    {audience.map((h) => audienceIcon(h, rootRel))}
                  </span>
                ) : null}
                {conflicted.has(editor) ? (
                  <Hint hint={t`Different version here — click to compare and resolve`}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 shrink-0 rounded border border-yellow-500/40 bg-yellow-500/10 px-1 text-[10px] text-yellow-600 uppercase tracking-wide hover:bg-yellow-500/20"
                      onClick={(e) => {
                        e.preventDefault();
                        onResolveFork?.(editor);
                      }}
                      data-testid={`skill-fork-chip-${editor}`}
                    >
                      <Trans>conflict</Trans>
                    </Button>
                  </Hint>
                ) : editor === sourceHost ? (
                  <span className="inline-flex h-5 shrink-0 items-center rounded border border-border/60 px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    <Trans>source</Trans>
                  </span>
                ) : hostSet.has(editor) && skill?.hosts ? (
                  <>
                    {/* Only a DIVERGENT location shows its form — and the tag is
                      the fix for the divergence, converting this one path.
                      Hidden mid-run for the same reason as the drift mark: the
                      watcher refetches the list while folders are still being
                      written, so a location that is about to become a symlink
                      reads as a copy for a beat and flashes a tag it never
                      earned. */}
                    {!busy && (linked.has(editor) ? 'link' : 'copy') !== expectedMode
                      ? convertRow(editor, path ?? label, linked.has(editor) ? 'link' : 'copy')
                      : null}
                    {/* Set-source rides the row on hover: promoting a location to
                      "the real folder" is deliberate, not something to bump
                      into while scanning the list. */}
                    <Hint hint={t`Make this the source — the skill's real folder moves here`}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 shrink-0 rounded border border-border/60 px-1 font-normal text-[10px] text-muted-foreground uppercase tracking-wide opacity-0 focus-visible:opacity-100 group-hover:opacity-100 hover:border-foreground/40 hover:text-foreground"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          toggles.setSource?.(editor);
                        }}
                        data-testid={`skill-set-source-${editor}`}
                      >
                        <Trans>make source</Trans>
                      </Button>
                    </Hint>
                  </>
                ) : null}
                {!busy && drifted.has(relOf(path)) ? (
                  // PASSIVE disclosure: something outside OK changed this path's
                  // form since OK last wrote it. No action — OK only writes on
                  // explicit clicks, and the chips always show disk truth.
                  <Hint
                    hint={t`Changed outside OK since it last wrote here — the state shown is what's on disk now`}
                  >
                    <ChangedOutsideBadge testId={`skill-drift-${editor}`} />
                  </Hint>
                ) : null}
              </span>
            </SkillMenuCheckboxItem>
          </Hint>
        );
      })}
      {/* KNOWN custom roots — any path this machine has placed skills under,
          offered on every skill. Check = place here (in the skill's mode);
          uncheck = remove (lossless-only; a hand-edited copy is refused
          server-side). Icons: OK blob for `.ok`, plain folder otherwise —
          brand marks stay first-party-only. */}
      {customRootRows.map((r) => (
        <Hint
          key={r.root}
          hint={
            r.placed !== null
              ? t`Installed at ${r.display} — click to remove`
              : expectedMode === 'link'
                ? t`Symlinks the skill to ${r.display}`
                : t`Copies the skill to ${r.display}`
          }
        >
          <SkillMenuCheckboxItem
            menuKind={menuKind}
            disabled={busy}
            checked={r.placed !== null}
            onCheckedChange={(on) => {
              if (on === true && r.placed === null) {
                if (!confirmReach(r.root)) return;
                toggles.placeAt(r.root, expectedMode);
              } else if (r.placed !== null) {
                toggles.unplaceAt?.(r.placed.path);
              }
            }}
            onSelect={(e) => e.preventDefault()}
            className="group"
            data-testid={`skill-custom-root-${r.root}`}
          >
            {r.root === '.agents/skills' ? (
              <AgentBrandIcon host="agents" aria-hidden className="size-4" />
            ) : (
              <Folder aria-hidden className="size-4 text-muted-foreground" />
            )}
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span className="min-w-0 truncate font-mono text-xs">{r.display}</span>
              {subscribersOf(r.root).length > 0 ? (
                <span
                  className="flex shrink-0 items-center gap-0.5"
                  data-testid={`skill-row-audience-custom-${r.root}`}
                >
                  {subscribersOf(r.root).map((h) => audienceIcon(h, r.root))}
                </span>
              ) : null}
              {!busy && r.placed !== null && drifted.has(r.placed.path) ? (
                <Hint
                  hint={t`Changed outside OK since it last wrote here — the state shown is what's on disk now`}
                >
                  <ChangedOutsideBadge testId={`skill-drift-custom-${r.root}`} />
                </Hint>
              ) : r.placed !== null ? (
                // Same contract as the host rows: divergent form gets a convert
                // tag, set-source rides the row on hover.
                <>
                  {!busy && r.placed.mode !== expectedMode
                    ? convertRow(r.root, r.display, r.placed.mode)
                    : null}
                  <Hint hint={t`Make this the source — the skill's real folder moves here`}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 shrink-0 rounded border border-border/60 px-1 font-normal text-[10px] text-muted-foreground uppercase tracking-wide opacity-0 focus-visible:opacity-100 group-hover:opacity-100 hover:border-foreground/40 hover:text-foreground"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        toggles.setSource?.(r.root);
                      }}
                      data-testid={`skill-set-source-custom-${r.root}`}
                    >
                      <Trans>make source</Trans>
                    </Button>
                  </Hint>
                </>
              ) : null}
            </span>
          </SkillMenuCheckboxItem>
        </Hint>
      ))}

      {/* Skill-wide form change, deliberately last and quiet. The per-row tag
          fixes ONE divergent location; this is the "make them all the same"
          verb, and the only place the whole set changes at once. It explains
          copies vs symlinks and names every path before writing — a silent
          skill-wide reconvert is exactly what the old mode tabs got wrong.
          Hidden when there is nothing besides the source to convert. */}
      {convertible.length > 0 && toggles.convertLocations ? (
        <div className="flex items-center gap-1 px-2 pt-1 pb-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-auto whitespace-normal p-0 text-left font-normal text-[11px] text-muted-foreground leading-snug hover:bg-transparent hover:text-foreground"
            onClick={(e) => {
              e.preventDefault();
              const to: 'copy' | 'link' = expectedMode === 'link' ? 'copy' : 'link';
              const targets = convertible.filter((c) => c.mode !== to);
              if (targets.length === 0) return;
              const explainer =
                to === 'copy'
                  ? t`A copy is a real folder of its own, and OK keeps it in step with the source: edit the skill here and every copy is refreshed. That stops the moment you hand-edit a copy outside OK — from then on it goes its own way and shows up as a separate skill.`
                  : t`A symlink is a pointer to the source folder rather than a folder of its own. Every location reads the exact same bytes, so nothing can drift, and a location stops working if the source is deleted.`;
              const question =
                to === 'copy'
                  ? t`Replace these symlinks with independent copies?`
                  : t`Replace these copies with symlinks to the source?`;
              const paths = targets.map((c) => c.display).join('\n');
              if (
                !window.confirm(
                  `${explainer}\n\n${question}\n\n${paths}\n\n${t`The source folder itself does not move.`}`,
                )
              )
                return;
              // One sequential run, not one request per location: the ledger
              // update behind each conversion is a read-modify-write of a single
              // file, and the surfaces stay in "Working" until the last one lands.
              onRunStart?.();
              toggles.convertLocations?.(targets.map((c) => ({ target: c.target, mode: to })));
            }}
            disabled={busy}
            data-testid="skill-convert-all"
          >
            {expectedMode === 'link' ? (
              <Trans>Convert locations to copies</Trans>
            ) : (
              <Trans>Convert locations to symlinks</Trans>
            )}
          </Button>
          {/* The difference between the two forms is the thing people actually
              need explained, and it belongs BEFORE the click — the confirm
              already repeats it, but by then you have committed to reading a
              dialog. A `?` keeps that available without spending a line of the
              menu on prose. */}
          <Hint
            hint={t`A copy is a real folder of its own, and OK keeps it in step with the source: edit the skill here and every copy is refreshed. That stops the moment you hand-edit a copy outside OK — from then on it goes its own way and shows up as a separate skill. A symlink is a pointer to the source instead, so nothing can drift, but a location stops working if the source is deleted.`}
          >
            <Button
              variant="ghost"
              size="sm"
              aria-label={t`What is the difference between copies and symlinks?`}
              className="size-4 shrink-0 rounded-full border border-border/60 p-0 font-normal text-[9px] text-muted-foreground hover:border-foreground/40 hover:bg-transparent hover:text-foreground"
              onClick={(e) => e.preventDefault()}
              data-testid="skill-convert-all-help"
            >
              ?
            </Button>
          </Hint>
        </div>
      ) : null}
      <SkillMenuSeparator menuKind={menuKind} />
      {/* Folder-level wiring lives one level up from this menu: this menu places
          THIS skill, that pane links whole FOLDERS (so two agents share every
          skill) and registers custom roots. Named for what it manages rather
          than "Settings", and the hint says where it goes — the row navigates
          away, which a bare gear does not communicate. */}
      <Hint
        hint={t`Opens Settings → Skills, where you link a whole folder into another so both agents read the same skills, and add custom skill roots.`}
      >
        <SkillMenuItem
          menuKind={menuKind}
          onSelect={() => {
            // Land on the pane that governs THIS skill's folders. A global skill's
            // roots live under `~`, which the project pane doesn't manage at all,
            // so sending it there opened settings that couldn't act on it.
            window.location.hash =
              skill?.scope === 'global' ? '#settings/user-skills' : '#settings/skills';
          }}
        >
          <SettingsIcon aria-hidden />
          <Trans>Manage skill folders</Trans>
        </SkillMenuItem>
      </Hint>
    </>
  );
}
