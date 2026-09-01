import type { SkillInstallTarget, SkillsListEntry } from '@inkeep/open-knowledge-core';
import {
  AGENTS_SKILLS_ROOT,
  EDITOR_LABELS,
  isSkillInstallTarget,
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
import {
  deriveSkillInstallRows,
  GLOBAL_INSTALL_EDITORS,
  INSTALL_EDITORS,
  pluginCoverageOf,
  type SkillInstallMenuSkill,
} from '@/lib/skill-install-rows';
import { aliasSubscribersOf, skillHostRootDir } from '@/lib/skill-scope';
import { placeSkill, putSkillFolderAction, setSkillSource, unplaceSkill } from '@/lib/skills-api';

export { GLOBAL_INSTALL_EDITORS, INSTALL_EDITORS } from '@/lib/skill-install-rows';

export const SKILL_INSTALL_MENU_WIDTH = 'min-w-[24rem]';

export interface SkillHostToggles {
  hostSet: ReadonlySet<string>;
  installed: boolean;
  installing: boolean;
  toggleEditor: (editor: SkillInstallTarget, on: boolean) => void;
  installAll: () => void;
  linkMode: boolean;
  setSource?: (host: string) => void;
  placeAt: (root: string, mode: 'copy' | 'link') => void;
  unplaceAt?: (path: string) => void;
  convertLocation?: (target: string, mode: 'copy' | 'link') => void;
  convertLocations?: (targets: readonly { target: string; mode: 'copy' | 'link' }[]) => void;
  sourceHost?: string;
}

export function useSkillHostToggles(
  skill: SkillsListEntry,
  actions: SkillActions,
): SkillHostToggles {
  const inFlight = actions.installingName === skill.name;
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
  useEffect(() => {
    if (optimisticHosts === null) liveHostsRef.current = skill.hosts;
  }, [optimisticHosts, skill.hosts]);

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
    const run = async () => {
      pendingInstallRef.current = null;
      installTimer.current = null;
      const result = await actions.install(skill, nextHosts.filter(isSkillInstallTarget));
      if (!result.ok) {
        setSkillOverlay(overlayKey, { hosts: null });
        return;
      }
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
      const editorVocab = skill.scope === 'global' ? GLOBAL_INSTALL_EDITORS : INSTALL_EDITORS;
      const nonEditor = liveHostsRef.current.filter(
        (h) => !(editorVocab as readonly string[]).includes(h),
      );
      const installable = skill.installableEditors ?? editorVocab;
      const editors = editorVocab.filter(
        (e) => installable.includes(e) || liveHostsRef.current.includes(e),
      );
      commitHosts([...nonEditor, ...editors], false);
    },
    linkMode: serverLink,
    sourceHost: optimisticSource ?? skill.hosts[0],
    placeAt(root, mode) {
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
      void actions.convertLocations(skill, [{ target, mode }]);
    },
    convertLocations(targets) {
      void actions.convertLocations(skill, targets);
    },
  };
}

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

export function SkillInstallMenuItems({
  toggles,
  skill,
  onResolveFork,
  onRunStart,
  menuKind = 'dropdown',
}: {
  toggles: SkillHostToggles;
  skill: SkillInstallMenuSkill;
  onResolveFork?: (editor: string) => void;
  onRunStart?: () => void;
  menuKind?: SkillMenuKind;
}) {
  const { t } = useLingui();
  const { hostSet, toggleEditor, installAll } = toggles;
  const allSkills = useSkills();
  const {
    pathFor,
    aliases,
    rows,
    sourceRow,
    sourceHost,
    conflicted,
    drifted,
    linked,
    expectedMode,
    convertible,
    customRootRows,
  } = deriveSkillInstallRows({
    skill,
    allSkills: allSkills.status === 'ready' ? allSkills.data : null,
    hostSet,
    sourceHostOverlay: toggles.sourceHost,
    linkMode: toggles.linkMode,
  });
  const subscribersOf = (rootRel: string): string[] => aliasSubscribersOf(aliases, rootRel);
  const hostLabel = (h: string): string =>
    h === 'agents' ? '.agents' : ((EDITOR_LABELS as Record<string, string>)[h] ?? h);
  const confirmReach = (rootRel: string): boolean => {
    const subs = subscribersOf(rootRel);
    if (subs.length === 0) return true;
    return window.confirm(
      t`Adds the skill to ${rootRel} — also read by ${subs.map(hostLabel).join(', ')}`,
    );
  };
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
  const busy = toggles.installing;
  const pluginCoverage = pluginCoverageOf(skill);
  const relOf = (display: string | null): string => (display ?? '').replace(/^~\//, '');
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
  return (
    <>
      {}
      {}
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
      {}
      {sourceRow !== null ? (
        <Hint hint={t`The skill's own folder — the source other locations copy or link from`}>
          <SkillMenuCheckboxItem
            menuKind={menuKind}
            disabled={busy}
            checked
            onSelect={(e) => e.preventDefault()}
            data-testid="skill-source-row"
          >
            {}
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
                    : pluginCoverage?.editor === editor
                      ? t`${label} already loads "${skill?.name ?? ''}" from the ${pluginCoverage.plugin} plugin. Installing here puts a copy at ${path ?? label} that ${label} uses instead of the plugin's — it stops tracking plugin updates.`
                      : path
                        ? sourceHost === undefined
                          ? t`Installs the skill to ${path} — the first location holds its own copy`
                          : expectedMode === 'link'
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
                if (conflicted.has(editor)) return;
                if (on === true && !confirmReach(rootRel)) return;
                toggleEditor(editor, on === true);
              }}
              onSelect={(e) => e.preventDefault()}
              className="group"
              data-testid={`skill-install-editor-${editor}`}
            >
              <AgentBrandIcon host={editor} aria-hidden className="size-4" />
              {}
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="min-w-0 truncate font-mono text-xs">{path ?? label}</span>
                {}
                {audience.length > 0 ? (
                  <span
                    className="flex shrink-0 items-center gap-0.5"
                    data-testid={`skill-row-audience-${editor}`}
                  >
                    {audience.map((h) => audienceIcon(h, rootRel))}
                  </span>
                ) : null}
                {pluginCoverage?.editor === editor && !hostSet.has(editor) ? (
                  <span
                    className="inline-flex h-5 shrink-0 items-center rounded border border-border/60 px-1 text-[10px] uppercase tracking-wide text-muted-foreground"
                    data-testid={`skill-row-plugin-covered-${editor}`}
                  >
                    <Trans>via plugin</Trans>
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
                    {}
                    {!busy && (linked.has(editor) ? 'link' : 'copy') !== expectedMode
                      ? convertRow(editor, path ?? label, linked.has(editor) ? 'link' : 'copy')
                      : null}
                    {}
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
      {}
      {customRootRows.map((r) => {
        const path = r.display;
        return (
          <Hint
            key={r.root}
            hint={
              r.placed !== null
                ? t`Installed at ${path} — click to remove`
                : sourceHost === undefined
                  ? t`Installs the skill to ${path} — the first location holds its own copy`
                  : expectedMode === 'link'
                    ? t`Symlinks the skill to ${path}`
                    : t`Copies the skill to ${path}`
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
              {r.root === AGENTS_SKILLS_ROOT ? (
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
        );
      })}

      {}
      {rows.length === 0 && customRootRows.length === 0 && sourceRow === null ? (
        <div
          className="px-2 py-1.5 text-[11px] text-muted-foreground leading-snug"
          data-testid="skill-install-no-destinations"
        >
          <Trans>No agent folders yet</Trans>
        </div>
      ) : null}

      {}
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
          {}
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
      {}
      <Hint
        hint={t`Opens Settings → Skills Studio, where you link a whole folder into another so both agents read the same skills, and add custom skill roots.`}
      >
        <SkillMenuItem
          menuKind={menuKind}
          onSelect={() => {
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
