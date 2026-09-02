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
        {}
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
  label: string;
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
  const showMoreLabel = (hiddenCount: number): string => t`Show ${hiddenCount} more`;
  const overrides = useEnabledOverrides();
  const registered = useRegisteredAgents();
  const { states, refresh } = useInstalledAgents();
  const terminalLaunch = useTerminalLaunch();
  const [query, setQuery] = useState('');
  const [showInAppOverflow, setShowInAppOverflow] = useState(false);
  const [showTerminalOverflow, setShowTerminalOverflow] = useState(false);

  const catalog = useQuery({
    queryKey: ['acp-catalog'],
    queryFn: ({ signal }) => fetchAgentCatalog(signal),
    staleTime: 5 * 60 * 1000,
  });

  const refreshOnMount = useEffectEvent(() => {
    void refresh();
  });
  useEffect(() => {
    refreshOnMount();
  }, []);

  const catalogAgents = catalog.data?.agents;
  const registeredKeys = new Set(registered.map((a) => `${a.source}:${a.id}`));
  const installedClis = terminalLaunch?.installedClis ?? {};

  const q = query.trim().toLowerCase();
  const matches = (text: string): boolean => q === '' || text.toLowerCase().includes(q);

  const inAppAgents = (catalogAgents ?? []).filter((agent) => matches(agent.name));
  const cliPresent = (cli: TerminalCli): boolean => installedClis[cli] !== false;
  const terminalClis =
    terminalLaunch !== null
      ? TERMINAL_CLI_IDS.filter((cli) => matches(TERMINAL_CLIS[cli].displayName)).sort(
          (a, b) =>
            Number(cliPresent(b)) - Number(cliPresent(a)) ||
            TERMINAL_CLIS[a].displayName.localeCompare(TERMINAL_CLIS[b].displayName),
        )
      : [];
  const desktopTargets = VISIBLE_TARGETS.filter((target) => {
    const { displayName } = target;
    return matches(t`${displayName} Desktop`) || matches(target.id);
  }).sort(
    (a, b) => Number(states[a.id]?.installed === false) - Number(states[b.id]?.installed === false),
  );

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
  const isPrimaryAgent = (a: CatalogAgent): boolean =>
    (a.harness !== undefined && harnessPresenceRank(a) === 0) || inAppChecked(a);
  const inAppPrimary = inAppAgents.filter(isPrimaryAgent);
  const inAppShown = [...(searching || showInAppOverflow ? inAppAgents : inAppPrimary)].sort(
    (a, b) => Number(isPrimaryAgent(b)) - Number(isPrimaryAgent(a)) || a.name.localeCompare(b.name),
  );
  const inAppHiddenCount = searching ? 0 : inAppAgents.length - inAppPrimary.length;

  const terminalPrimary = terminalClis.filter(cliPresent);
  const terminalFoldable =
    terminalPrimary.length > 0 && terminalPrimary.length < terminalClis.length;
  const terminalShown =
    !terminalFoldable || searching || showTerminalOverflow ? terminalClis : terminalPrimary;
  const terminalHiddenCount =
    terminalFoldable && !searching ? terminalClis.length - terminalPrimary.length : 0;

  const inAppHasDetected = !catalogReady || inAppAgents.some(isHarnessDetected);
  const terminalHasPresent = terminalClis.some(cliPresent);
  const desktopHasPresent = desktopTargets.some((tg) => states[tg.id]?.installed === true);

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
            const checked = inAppChecked(agent);
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
