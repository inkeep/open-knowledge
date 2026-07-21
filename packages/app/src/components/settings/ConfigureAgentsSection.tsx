/**
 * Settings → User → Configure agents.
 *
 * The single user-owned surface controlling which agents appear in the agent
 * launcher menus (footer "Ask", empty-state "Create with", header "Open with
 * AI", the file-tree right-click submenus, and the dock New-chat picker). Lists
 * every agent in three groups — In app / Terminal / Desktop — each with a
 * toggle. The toggle is the source of truth: enabling shows the agent in every
 * menu, disabling hides it.
 *
 * Enablement persists to localStorage via `enabled-agents.ts`; effective state
 * is `override ?? categoryDefault` resolved through `agent-visibility.ts` so
 * this list and the menus always agree. Only a platform-unsupported in-app agent
 * is disabled; every other agent stays toggleable, with the catalog description
 * as its muted subtitle.
 */

import { TERMINAL_CLI_IDS, TERMINAL_CLIS, type TerminalCli } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Search, WifiOff } from 'lucide-react';
import { type ReactNode, useEffect, useEffectEvent, useState } from 'react';
import { AgentBetaBadge } from '@/components/acp/AgentBetaBadge';
import { RegisteredAgentIcon } from '@/components/acp/RegisteredAgentIcon';
import { TargetIcon } from '@/components/handoff/OpenInAgentMenuItem';
import { useTerminalLaunch } from '@/components/handoff/TerminalLaunchContext';
import { cliIconTargetId } from '@/components/handoff/terminal-cli-display';
import { useInstalledAgents } from '@/components/handoff/useInstalledAgents';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  isDesktopTargetEnabled,
  isInAppAgentEnabled,
  isTerminalCliEnabled,
} from '@/lib/acp/agent-visibility';
import { type CatalogAgent, fetchAgentCatalog } from '@/lib/acp/catalog';
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
  children,
  labelId,
}: {
  label: ReactNode;
  labelId: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section aria-labelledby={labelId}>
      <h4
        id={labelId}
        className="mb-2 font-mono text-muted-foreground text-xs uppercase tracking-wide"
      >
        {label}
      </h4>
      <div className="divide-y overflow-hidden rounded-md border">{children}</div>
    </section>
  );
}

export function ConfigureAgentsSection(): ReactNode {
  const { t } = useLingui();
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
  const terminalClis =
    terminalLaunch !== null
      ? TERMINAL_CLI_IDS.filter((cli) => matches(TERMINAL_CLIS[cli].displayName))
      : [];
  const desktopTargets = VISIBLE_TARGETS.filter((target) => matches(target.displayName));

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
    const isDetected = agent.supported === true && agent.harness?.availability === 'present';
    return isInAppAgentEnabled(
      overrides,
      agent.source,
      agent.id,
      isRegistered || isDetected,
      agent.supported,
    );
  };
  // Default view = the harness-mapped agents (the server attaches `harness`
  // exactly for the `ACP_AGENT_HARNESS_CLIS` set, i.e. the ones that also appear
  // in the Terminal section), plus any agent the user has turned on so an
  // enabled agent never hides behind "Show more". Searching or expanding shows
  // the full list.
  const inAppPrimary = inAppAgents.filter((a) => a.harness !== undefined || inAppChecked(a));
  const inAppShown = searching || showInAppOverflow ? inAppAgents : inAppPrimary;
  const inAppHiddenCount = searching ? 0 : inAppAgents.length - inAppPrimary.length;

  const titleId = 'settings-configure-agents-title';

  return (
    <section
      aria-labelledby={titleId}
      className="space-y-6"
      data-testid="settings-configure-agents"
    >
      <div className="space-y-1">
        <h3 id={titleId} className="font-semibold text-base">
          {t`Configure agents`}
        </h3>
        <p className="text-muted-foreground text-sm">
          {t`Choose which agents appear in the agent selector. Turn one off to hide it everywhere.`}
        </p>
      </div>

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

      {/* In app — server-hosted agents from the registry catalog. */}
      {showInApp ? (
        <AgentGroup
          label={
            <span className="inline-flex items-center gap-1.5">
              {t`In app`}
              <AgentBetaBadge />
            </span>
          }
          labelId="settings-configure-agents-in-app"
        >
          {catalog.isLoading ? (
            <div className="flex items-center justify-center gap-2 px-3 py-6 text-muted-foreground text-sm">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {t`Loading agents…`}
            </div>
          ) : catalog.isError ? (
            <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-muted-foreground text-sm">
              <WifiOff className="size-5" aria-hidden="true" />
              <span>{t`Couldn't reach the agent registry.`}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void catalog.refetch()}
              >
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
                const hint = !agent.supported
                  ? t`Not available on this platform`
                  : agent.description;
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
                  {showInAppOverflow ? t`Show less` : t`Show ${inAppHiddenCount} more`}
                </Button>
              ) : null}
            </>
          )}
        </AgentGroup>
      ) : null}

      {/* Terminal — docked-terminal CLI launchers. Desktop-only (no web shell). */}
      {showTerminal ? (
        <AgentGroup label={t`Terminal`} labelId="settings-configure-agents-terminal">
          {terminalClis.map((cli: TerminalCli) => {
            const { displayName } = TERMINAL_CLIS[cli];
            const notInstalled = installedClis[cli] === false;
            return (
              <AgentRow
                key={cli}
                icon={
                  <TargetIcon id={cliIconTargetId(cli)} className="size-4" aria-hidden="true" />
                }
                name={t`${displayName} CLI`}
                hint={notInstalled ? t`Not installed` : undefined}
                checked={isTerminalCliEnabled(overrides, cli, installedClis)}
                ariaLabel={t`Enable ${displayName} CLI`}
                testId={`configure-agents-terminal-${cli}`}
                onToggle={(next) => setAgentEnabled(terminalEnabledKey(cli), next)}
              />
            );
          })}
        </AgentGroup>
      ) : null}

      {/* Desktop — installed app launchers (deep-link handoff). */}
      {showDesktop ? (
        <AgentGroup label={t`Desktop`} labelId="settings-configure-agents-desktop">
          {desktopTargets.map((target) => {
            const installed = states[target.id]?.installed ?? null;
            return (
              <AgentRow
                key={target.id}
                icon={<TargetIcon id={target.id} className="size-4" aria-hidden="true" />}
                name={target.displayName}
                // Only show the hint once the probe positively reports absent;
                // `null` is detection-pending, not "not installed".
                hint={installed === false ? t`Not installed` : undefined}
                checked={isDesktopTargetEnabled(overrides, target.id)}
                ariaLabel={t`Enable ${target.displayName}`}
                testId={`configure-agents-desktop-${target.id}`}
                onToggle={(next) => setAgentEnabled(desktopEnabledKey(target.id), next)}
              />
            );
          })}
        </AgentGroup>
      ) : null}
    </section>
  );
}
