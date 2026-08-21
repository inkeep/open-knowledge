/**
 * Settings → User → Configure agents.
 *
 * The single user-owned surface controlling which agents appear in the agent
 * launcher menus (footer + empty-state "Ask", header "Open with
 * AI", the file-tree right-click submenus, and the dock New-chat picker). Lists
 * every agent in three groups — In app / Terminal / External apps — each with a
 * toggle. The toggle is the source of truth: enabling shows the agent in every
 * menu, disabling hides it.
 *
 * Enablement persists to localStorage via `enabled-agents.ts`; effective state
 * is `override ?? categoryDefault` resolved through `agent-visibility.ts` so
 * this list and the menus always agree. Only a platform-unsupported in-app agent
 * is disabled; every other agent stays toggleable, with the catalog description
 * as its muted subtitle.
 */

// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { TERMINAL_CLI_IDS, TERMINAL_CLIS, type TerminalCli } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Search, WifiOff } from 'lucide-react';
import { type ReactNode, useEffect, useEffectEvent, useState } from 'react';
import { RegisteredAgentIcon } from '@/components/acp/RegisteredAgentIcon';
import { TargetIcon } from '@/components/handoff/OpenInAgentMenuItem';
import { useTerminalLaunch } from '@/components/handoff/TerminalLaunchContext';
import { cliIconTargetId } from '@/components/handoff/terminal-cli-display';
import { useInstalledAgents } from '@/components/handoff/useInstalledAgents';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import {
  isDesktopTargetEnabled,
  isInAppAgentEnabled,
  isTerminalCliEnabled,
} from '@/lib/acp/agent-visibility';
import {
  type CatalogAgent,
  fetchAgentCatalog,
  harnessPresenceRank,
  isHarnessDetected,
} from '@/lib/acp/catalog';
import {
  desktopEnabledKey,
  inAppEnabledKey,
  setAgentEnabled,
  terminalEnabledKey,
  useEnabledOverrides,
} from '@/lib/acp/enabled-agents';
import {
  reassignDefaultIfDisabled,
  registerAgent,
  useRegisteredAgents,
} from '@/lib/acp/registered-agents';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';
import { SettingsSectionHeader } from './SettingsSectionHeader';

/** One toggle row: icon + name (+ optional muted hint) on the left, Switch on
 *  the right. The icon aligns to the name line only — a two-line row (name +
 *  description hint) keeps the icon centered on the name, not the block. */
function AgentRow({
  icon,
  name,
  hint,
  checked,
  disabled,
  ariaLabel,
  testId,
  onToggle,
}: {
  icon: ReactNode;
  name: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  ariaLabel: string;
  testId: string;
  onToggle: (next: boolean) => void;
}): ReactNode {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="flex min-w-0 items-start gap-2.5">
        {/* h-5 matches the name's leading-5 line box, so the icon centers on the
            name line whether or not a hint sits below it. */}
        <span className="flex h-5 shrink-0 items-center">{icon}</span>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm leading-5">{name}</span>
          {hint ? <span className="truncate text-muted-foreground text-1sm">{hint}</span> : null}
        </div>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onToggle}
        aria-label={ariaLabel}
        data-testid={testId}
      />
    </div>
  );
}

function AgentGroup({
  label,
  labelIcon,
  children,
  labelId,
}: {
  label: ReactNode;
  /** Decorative mark beside the heading — the external-action arrow on the
   *  external-apps group, matching that section's launcher headers. */
  labelIcon?: ReactNode;
  labelId: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section aria-labelledby={labelId}>
      <h4
        id={labelId}
        className="mb-2 flex items-center gap-1.5 font-mono text-muted-foreground text-xs uppercase tracking-wide"
      >
        {label}
        {labelIcon}
      </h4>
      <div className="divide-y overflow-hidden rounded-md border">{children}</div>
    </section>
  );
}

export function ConfigureAgentsSection(): ReactNode {
  const { t } = useLingui();
  // Both group folds render through here so they extract as ONE message. Lingui
  // puts the placeholder's variable name in the msgid, so labelling them inline
  // would fork `Show {inAppHiddenCount} more` and `Show {terminalHiddenCount} more`
  // into two catalog entries with two sets of translations to keep in step.
  const showMoreLabel = (hiddenCount: number): string => t`Show ${hiddenCount} more`;
  const overrides = useEnabledOverrides();
  const registered = useRegisteredAgents();
  const { states, refresh } = useInstalledAgents();
  // Null on the web host (no docked terminal / shell), so the Terminal group is
  // absent there — matching the launcher menus.
  const terminalLaunch = useTerminalLaunch();
  const [query, setQuery] = useState('');
  // In app list is collapsed to the harness-mapped agents by default; this
  // reveals the long tail.
  const [showInAppOverflow, setShowInAppOverflow] = useState(false);
  const [showTerminalOverflow, setShowTerminalOverflow] = useState(false);

  const catalog = useQuery({
    queryKey: ['acp-catalog'],
    queryFn: ({ signal }) => fetchAgentCatalog(signal),
    staleTime: 5 * 60 * 1000,
  });

  // Refresh desktop install detection when the section mounts so a freshly
  // installed app shows as installed. `useEffectEvent` keeps `refresh` out of
  // the dependency array; the probe coordinator throttles + dedups.
  const refreshOnMount = useEffectEvent(() => {
    void refresh();
  });
  useEffect(() => {
    refreshOnMount();
  }, []);

  // Registered-agent metadata hydration (name + icon from the catalog) runs once
  // at app startup via `useHydrateRegisteredAgentMeta` in main.tsx, so it no
  // longer needs to be gated behind opening this tab; here the catalog just
  // drives the In app list.
  const catalogAgents = catalog.data?.agents;
  const registeredKeys = new Set(registered.map((a) => `${a.source}:${a.id}`));
  const installedClis = terminalLaunch?.installedClis ?? {};

  // Case-insensitive substring filter over each agent's visible name.
  const q = query.trim().toLowerCase();
  const matches = (text: string): boolean => q === '' || text.toLowerCase().includes(q);

  const inAppAgents = (catalogAgents ?? []).filter((agent) => matches(agent.name));
  // Presence-first inside Terminal and Desktop too, on the same three-valued rule
  // the In-app list uses: a probe that has positively answered `false` sinks, and
  // pending sorts with present so a slow probe never buries a tool you have.
  // Without this the Terminal group interleaved the not-installed CLIs among the
  // installed ones in catalogue order.
  // Fail-open: `installedClis` starts `{}` and fills from an async probe, so a
  // missing key is pending, not absent. Only a positive `false` counts against a
  // CLI. One definition drives the sort, the fold and the group ordering below.
  const cliPresent = (cli: TerminalCli): boolean => installedClis[cli] !== false;
  const terminalClis =
    terminalLaunch !== null
      ? TERMINAL_CLI_IDS.filter((cli) => matches(TERMINAL_CLIS[cli].displayName)).sort(
          (a, b) =>
            Number(cliPresent(b)) - Number(cliPresent(a)) ||
            TERMINAL_CLIS[a].displayName.localeCompare(TERMINAL_CLIS[b].displayName),
        )
      : [];
  // Filter on the RENDERED label ("Claude Desktop"), not the bare brand, so a
  // search for "desktop" finds this group the way the eye does — plus the
  // target id, mirroring the command palette's keywords: the id preserves the
  // Codex lineage after the ChatGPT rebrand, so searching "codex" still finds
  // that row. Sorted present-first on the same rule as the other two groups.
  // `.filter` already returns a fresh array, so the in-place `.sort` below cannot
  // reach `VISIBLE_TARGETS` — no defensive copy needed.
  const desktopTargets = VISIBLE_TARGETS.filter((target) => {
    const { displayName } = target;
    return matches(t`${displayName} Desktop`) || matches(target.id);
  }).sort(
    (a, b) => Number(states[a.id]?.installed === false) - Number(states[b.id]?.installed === false),
  );

  // With a query active, hide a group that has no matches; when every group is
  // empty, show a single no-results line instead of three empty boxes.
  const searching = q !== '';
  const catalogReady = !catalog.isLoading && !catalog.isError;
  const noMatches =
    searching &&
    catalogReady &&
    inAppAgents.length === 0 &&
    terminalClis.length === 0 &&
    desktopTargets.length === 0;
  const showInApp = !searching || catalog.isLoading || catalog.isError || inAppAgents.length > 0;
  const showTerminal = terminalLaunch !== null && (!searching || terminalClis.length > 0);
  const showDesktop = !searching || desktopTargets.length > 0;

  // Effective on/off for an in-app agent — the SAME predicate the row + menus
  // use, so this list and every launcher agree.
  const inAppChecked = (agent: CatalogAgent): boolean => {
    const isRegistered = registeredKeys.has(`${agent.source}:${agent.id}`);
    const isDetected = isHarnessDetected(agent);
    return isInAppAgentEnabled(
      overrides,
      agent.source,
      agent.id,
      isRegistered || isDetected,
      agent.supported,
    );
  };
  // Default view = harness-mapped agents the probe has NOT ruled out (present or
  // still pending), plus any agent the user has turned on so an enabled agent
  // never hides behind "Show more". Searching or expanding shows the full list.
  //
  // The `harness !== undefined` test alone used to admit every agent in the
  // `ACP_AGENT_HARNESS_CLIS` set regardless of what its probe found, so agents
  // this machine cannot run occupied the default rows while the ones it can run
  // sat below the fold. The probe result was already on the row; nothing read it.
  // One predicate for both the fold and the sort, so "what stays visible" and
  // "what floats to the top" can never disagree.
  //
  // Note `harnessPresenceRank` alone is NOT enough here: it returns 0 for an
  // agent with no harness at all, so scoring on it left every harness-free
  // catalogue agent tied with the real ones and only sank the explicitly
  // not-found few.
  const isPrimaryAgent = (a: CatalogAgent): boolean =>
    (a.harness !== undefined && harnessPresenceRank(a) === 0) || inAppChecked(a);
  const inAppPrimary = inAppAgents.filter(isPrimaryAgent);
  // Expanding must not scatter the agents that run here back into catalogue
  // order — they stay pinned at the top and everything else falls in
  // alphabetically, which is the only order that means anything for a list of
  // tools the machine has no opinion about. `sort` mutates, hence the copy.
  const inAppShown = [...(searching || showInAppOverflow ? inAppAgents : inAppPrimary)].sort(
    (a, b) => Number(isPrimaryAgent(b)) - Number(isPrimaryAgent(a)) || a.name.localeCompare(b.name),
  );
  const inAppHiddenCount = searching ? 0 : inAppAgents.length - inAppPrimary.length;

  // Terminal folds on the same rule. Most CLIs are not installed on any given
  // machine, so the full list is the same wall of noise the In-app fold exists
  // to cut, one group down.
  const terminalPrimary = terminalClis.filter(cliPresent);
  const terminalFoldable =
    terminalPrimary.length > 0 && terminalPrimary.length < terminalClis.length;
  const terminalShown =
    !terminalFoldable || searching || showTerminalOverflow ? terminalClis : terminalPrimary;
  const terminalHiddenCount =
    terminalFoldable && !searching ? terminalClis.length - terminalPrimary.length : 0;

  // Group ordering: a group holding something this host can use sorts above one
  // that does not. Two tiers, matching the rule this file already applies per
  // row rather than inventing a third for ordering. Each group scores on its
  // own notion of usable, and the three deliberately differ.
  //
  // In app is DETECTED, not merely PATH-present: `isHarnessDetected` also
  // counts an existing sign-in, so a harness whose CLI was never installed
  // still lifts the group. Scoring this one on PATH alone would sink In app
  // below External apps for exactly the user that signal exists to serve.
  //
  // Terminal is FAIL-OPEN (`cliPresent`, `!== false`): a terminal row only opens
  // a shell we own, so a probe that has not answered holds its place rather than
  // sinking and jumping back when it lands.
  //
  // External apps are STRICT (`=== true`), the same bar `isDesktopTargetEnabled`
  // applies to the rows: those deep-link into another application, so an
  // unresolved probe waits rather than asserting presence it cannot back.
  //
  // In app is held up entirely while its catalog is in flight — the rows arrive
  // asynchronously, and scoring the group on a not-yet-populated list would sort
  // it to the bottom and visibly jump it back on every open of this tab.
  const inAppHasDetected = !catalogReady || inAppAgents.some(isHarnessDetected);
  const terminalHasPresent = terminalClis.some(cliPresent);
  const desktopHasPresent = desktopTargets.some((tg) => states[tg.id]?.installed === true);

  // In app — server-hosted agents from the registry catalog.
  const inAppGroup = showInApp ? (
    <AgentGroup key="in-app" label={t`In app`} labelId="settings-configure-agents-in-app">
      {catalog.isLoading ? (
        <div className="flex items-center justify-center gap-2 px-3 py-6 text-muted-foreground text-sm">
          <Spinner className="size-4" aria-hidden="true" />
          {t`Loading agents…`}
        </div>
      ) : catalog.isError ? (
        <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-muted-foreground text-sm">
          <WifiOff className="size-5" aria-hidden="true" />
          <span>{t`Couldn't reach the agent registry.`}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void catalog.refetch()}>
            {t`Retry`}
          </Button>
        </div>
      ) : (catalogAgents?.length ?? 0) === 0 ? (
        <p className="px-3 py-6 text-center text-muted-foreground text-sm">
          {t`No agents available.`}
        </p>
      ) : (
        <>
          {inAppShown.map((agent: CatalogAgent) => {
            // `inAppChecked` folds in registration + present-harness detection,
            // matching the launcher menus so this toggle and the menus agree.
            const checked = inAppChecked(agent);
            // Muted subtitle: the platform gate wins (disabled rows say why),
            // otherwise the catalog's own blurb (e.g. "ACP wrapper for Cursor").
            // Deliberately NOT `license` (an SPDX string like "Apache-2.0") and
            // NOT the harness probe (a flaky server-side PATH check) — only the
            // human description belongs here.
            const hint = !agent.supported ? t`Not available on this platform` : agent.description;
            return (
              <AgentRow
                key={`${agent.source}:${agent.id}`}
                icon={
                  <RegisteredAgentIcon
                    agentId={agent.id}
                    iconUrl={agent.iconUrl}
                    className="size-4"
                  />
                }
                name={agent.name}
                hint={hint}
                checked={checked}
                disabled={!agent.supported}
                ariaLabel={t`Enable ${agent.name}`}
                testId={`configure-agents-in-app-${agent.source}:${agent.id}`}
                onToggle={(next) => {
                  if (next) {
                    // Enabling registers the agent for visibility only (caches
                    // name/icon so the menus can render it) and records an
                    // explicit override. `makeDefault: false` keeps the launch
                    // default put — enabling here is a visibility action, not a
                    // pick; only choosing an agent in a launcher sets the default.
                    registerAgent(
                      {
                        source: agent.source,
                        id: agent.id,
                        name: agent.name,
                        supported: agent.supported,
                        featured: agent.featured,
                        ...(agent.iconUrl !== undefined ? { iconUrl: agent.iconUrl } : {}),
                      },
                      { makeDefault: false },
                    );
                    setAgentEnabled(inAppEnabledKey(agent.source, agent.id), true);
                  } else {
                    setAgentEnabled(inAppEnabledKey(agent.source, agent.id), false);
                    // If this agent was the launch default, move the default to
                    // the next still-enabled agent (or clear it) so the composer
                    // stops showing a just-disabled agent as selected. The
                    // disabled agent is excluded by key, so the pre-toggle
                    // `overrides` snapshot is accurate for the remaining agents.
                    reassignDefaultIfDisabled(`${agent.source}:${agent.id}`, (a) =>
                      isInAppAgentEnabled(overrides, a.source, a.id, true, a.supported),
                    );
                  }
                }}
              />
            );
          })}
          {inAppHiddenCount > 0 ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setShowInAppOverflow((v) => !v)}
              className="w-full justify-center rounded-none font-normal text-1sm text-muted-foreground"
              data-testid="configure-agents-in-app-show-more"
            >
              {showInAppOverflow ? t`Show less` : showMoreLabel(inAppHiddenCount)}
            </Button>
          ) : null}
        </>
      )}
    </AgentGroup>
  ) : null;

  // Terminal — docked-terminal CLI launchers. Desktop-only (no web shell).
  const terminalGroup = showTerminal ? (
    <AgentGroup key="terminal" label={t`Terminal`} labelId="settings-configure-agents-terminal">
      {terminalShown.map((cli: TerminalCli) => {
        const { displayName } = TERMINAL_CLIS[cli];
        const notInstalled = installedClis[cli] === false;
        return (
          <AgentRow
            key={cli}
            icon={<TargetIcon id={cliIconTargetId(cli)} className="size-4" aria-hidden="true" />}
            name={t`${displayName} CLI`}
            hint={notInstalled ? t`Not installed` : undefined}
            checked={isTerminalCliEnabled(overrides, cli, installedClis)}
            ariaLabel={t`Enable ${displayName} CLI`}
            testId={`configure-agents-terminal-${cli}`}
            onToggle={(next) => setAgentEnabled(terminalEnabledKey(cli), next)}
          />
        );
      })}
      {terminalHiddenCount > 0 ? (
        <Button
          type="button"
          variant="ghost"
          onClick={() => setShowTerminalOverflow((v) => !v)}
          className="w-full justify-center rounded-none font-normal text-1sm text-muted-foreground"
          data-testid="configure-agents-terminal-show-more"
        >
          {showTerminalOverflow ? t`Show less` : showMoreLabel(terminalHiddenCount)}
        </Button>
      ) : null}
    </AgentGroup>
  ) : null;

  // External apps — detected desktop apps reached by deep-link handoff. Every
  // installed one is on by default; the toggle is how a user hides one, or shows
  // one they haven't installed yet (it routes to the installer).
  const desktopGroup = showDesktop ? (
    <AgentGroup
      key="desktop"
      label={t`External apps`}
      labelId="settings-configure-agents-desktop"
      labelIcon={<ArrowUpRight aria-hidden="true" className="size-3" />}
    >
      {desktopTargets.map((target) => {
        const installed = states[target.id]?.installed ?? null;
        const { displayName } = target;
        return (
          <AgentRow
            key={target.id}
            icon={<TargetIcon id={target.id} className="size-4" aria-hidden="true" />}
            name={t`${displayName} Desktop`}
            // Only show the hint once the probe positively reports absent;
            // `null` is detection-pending, not "not installed".
            hint={installed === false ? t`Not installed` : undefined}
            checked={isDesktopTargetEnabled(overrides, target.id, installed)}
            ariaLabel={t`Enable ${displayName} Desktop`}
            testId={`configure-agents-desktop-${target.id}`}
            onToggle={(next) => setAgentEnabled(desktopEnabledKey(target.id), next)}
          />
        );
      })}
    </AgentGroup>
  ) : null;

  // Present-bearing groups first; ties keep the declared order (In app,
  // Terminal, Desktop) so the layout only moves when the machine says it should.
  // Each group carries its own `key`, so React reconciles them across a reorder
  // instead of remounting whichever section happens to land in a given slot.
  const groups = [
    { node: inAppGroup, hasPresent: inAppHasDetected },
    { node: terminalGroup, hasPresent: terminalHasPresent },
    { node: desktopGroup, hasPresent: desktopHasPresent },
  ]
    .sort((a, b) => Number(b.hasPresent) - Number(a.hasPresent))
    .map((g) => g.node);

  const titleId = 'settings-configure-agents-title';

  return (
    <section
      aria-labelledby={titleId}
      className="space-y-6"
      data-testid="settings-configure-agents"
    >
      <SettingsSectionHeader titleId={titleId} title={t`Configure agents`} scope="user">
        {t`Choose which agents appear in agent menus across the app, such as Ask AI, Open with AI, and the ＋ new chat button. Turn an agent off to hide it from all of them.`}
      </SettingsSectionHeader>

      <div className="relative">
        <Search
          className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t`Search agents`}
          aria-label={t`Search agents`}
          className="pl-8"
          data-testid="configure-agents-search"
        />
      </div>

      {noMatches ? (
        <p
          className="py-6 text-center text-muted-foreground text-sm"
          data-testid="configure-agents-no-results"
        >
          {t`No agents match your search.`}
        </p>
      ) : null}

      {groups}
    </section>
  );
}
