import {
  AGENT_REGISTRY,
  type AgentId,
  type AgentMode,
  type ApplyIntent,
  agentIdForHandoffTarget,
  agentIdForTerminalCli,
  CONNECTION_ROW_AGENT_IDS,
  type HostSnapshot,
  TERMINAL_CLI_IDS,
  TERMINAL_CLIS,
  type TerminalCli,
} from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Check, Search, TriangleAlert, WifiOff } from 'lucide-react';
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from 'react';
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
  isTerminalCliRowEnabled,
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
import {
  type ApplyAgentConnectionsResult,
  applyAgentConnectionIntents,
} from '@/lib/agent-connections';
import { followupHintText } from '@/lib/agent-followup-hint';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';
import {
  type ApplyConnections,
  allAvailableCellsChecked,
  ConfigureConnectionDialog,
  ConnectionAgentIcon,
  connectionLabel,
  connectionsFromSnapshot,
  hasConfigurableCell,
  installedCount,
  intentsForParts,
  partsForConnection,
  RemoveConnectionDialog,
  removalIntents,
} from './AgentConnectionDialogs';
import {
  deriveRowConnectionStatus,
  deriveRowFollowup,
  followupRowFamily,
  type RowConnectionStatus,
  type RowPresence,
  resolvePresence,
} from './agent-connection-status';
import { type RowAction, rowActionFor } from './agent-row-action';
import { SettingsSectionHeader } from './SettingsSectionHeader';

function AgentRow({
  icon,
  name,
  hint,
  status,
  action,
  checked,
  disabled,
  ariaLabel,
  testId,
  rowTestId,
  statusId,
  onToggle,
}: {
  icon: ReactNode;
  name: ReactNode;
  hint?: ReactNode;
  status?: ReactNode;
  action?: ReactNode;
  checked?: boolean;
  disabled?: boolean;
  ariaLabel: string;
  testId: string;
  rowTestId: string;
  statusId?: string;
  onToggle?: (next: boolean) => void;
}): ReactNode {
  const hintId = hint ? `${rowTestId}-hint` : undefined;
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5" data-testid={rowTestId}>
      <div className="flex min-w-0 items-start gap-2.5">
        {}
        <span className="flex h-5 shrink-0 items-center">{icon}</span>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm leading-5">{name}</span>
          {hint ? (
            <span id={hintId} className="truncate text-muted-foreground text-1sm">
              {hint}
            </span>
          ) : null}
          {status ? <span id={statusId}>{status}</span> : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {action}
        {onToggle === undefined ? null : (
          <Switch
            checked={checked ?? false}
            disabled={disabled}
            onCheckedChange={onToggle}
            aria-label={ariaLabel}
            aria-describedby={[hintId, statusId].filter(Boolean).join(' ') || undefined}
            data-testid={testId}
          />
        )}
      </div>
    </div>
  );
}

function isToggleLocked(presence: RowPresence, enabled: boolean): boolean {
  return presence === 'absent' && !enabled;
}

function AgentGroup({
  label,
  labelIcon,
  subtitle,
  children,
  labelId,
}: {
  label: string;
  labelIcon?: ReactNode;
  subtitle?: ReactNode;
  labelId: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section aria-labelledby={labelId}>
      <div className="mb-2">
        <h4
          id={labelId}
          className="flex items-center gap-1.5 font-mono text-muted-foreground text-xs uppercase tracking-wide"
        >
          {label}
          {labelIcon}
        </h4>
        {subtitle ? <p className="mt-1 text-muted-foreground text-xs">{subtitle}</p> : null}
      </div>
      <div className="divide-y overflow-hidden rounded-md border">{children}</div>
    </section>
  );
}

function ConnectionStatusLine({
  status,
  enabled,
}: {
  status: RowConnectionStatus;
  enabled: boolean;
}): ReactNode {
  const { t } = useLingui();
  if (status === 'connected') {
    return (
      <span className="mt-0.5 inline-flex items-center gap-1 text-muted-foreground text-xs">
        <Check aria-hidden className="size-3.5" />
        {t`Connected`}
      </span>
    );
  }
  if (status === 'not-connected' && enabled) {
    return (
      <span className="mt-0.5 inline-flex items-center gap-1 text-amber-700 text-xs dark:text-amber-400">
        <TriangleAlert aria-hidden className="size-3.5" />
        {t`Not connected`}
      </span>
    );
  }
  return null;
}

function RowActionButton({
  action,
  rowLabel,
  describedById,
  onConfigure,
  onRemove,
}: {
  action: RowAction;
  describedById?: string;
  rowLabel: string;
  onConfigure: () => void;
  onRemove: () => void;
}): ReactNode {
  const { t } = useLingui();
  switch (action.kind) {
    case 'none':
      return null;
    case 'install':
      return (
        <Button
          variant="link"
          size="sm"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          asChild
        >
          <a
            href={action.url}
            target="_blank"
            rel="noreferrer"
            aria-label={t`Install ${rowLabel}`}
            aria-describedby={describedById}
          >
            {t`Install`}
            <ArrowUpRight aria-hidden />
          </a>
        </Button>
      );
    case 'setup-doc':
      return (
        <Button
          variant="link"
          size="sm"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          asChild
        >
          <a
            href={`https://openknowledge.ai/docs/integrations/${action.slug}`}
            target="_blank"
            rel="noreferrer"
            aria-label={t`How to set up ${rowLabel}`}
            aria-describedby={describedById}
          >
            {t`How to set up`}
            <ArrowUpRight aria-hidden />
          </a>
        </Button>
      );
    case 'connect':
      return (
        <Button
          size="sm"
          className="shrink-0 font-mono uppercase"
          onClick={onConfigure}
          aria-label={t`Add MCP & skill for ${rowLabel}`}
          aria-describedby={describedById}
        >
          {t`Add MCP & skill`}
        </Button>
      );
    case 'manage':
      return (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 font-mono uppercase"
          onClick={onConfigure}
          aria-label={t`Manage ${rowLabel}`}
          aria-describedby={describedById}
        >
          {t`Manage`}
        </Button>
      );
    case 'remove':
      return (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 font-mono uppercase"
          onClick={onRemove}
          aria-label={t`Remove ${rowLabel}`}
          aria-describedby={describedById}
        >
          {t`Remove`}
        </Button>
      );
  }
}

function registryInstallUrl(agentId: AgentId | undefined): string | null {
  if (agentId === undefined) return null;
  return AGENT_REGISTRY[agentId].external?.installUrl ?? null;
}

function readProducedFacts(snapshot: HostSnapshot | null): boolean {
  return (
    snapshot !== null &&
    Object.values(snapshot.probes.satisfiers).some(
      (probe) => probe !== undefined && probe.state !== 'unprobed',
    )
  );
}

export function AgentConnectionsSection({
  applyConnections = applyAgentConnectionIntents,
}: {
  applyConnections?: ApplyConnections;
} = {}): ReactNode {
  const { t } = useLingui();
  const showMoreLabel = (hiddenCount: number): string => t`Show ${hiddenCount} more`;
  const overrides = useEnabledOverrides();
  const registered = useRegisteredAgents();
  const { states, refresh } = useInstalledAgents();
  const terminalLaunch = useTerminalLaunch();
  const [query, setQuery] = useState('');
  const [showInAppOverflow, setShowInAppOverflow] = useState(false);
  const [showTerminalOverflow, setShowTerminalOverflow] = useState(false);
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [reloadInstallState, setReloadInstallState] = useState(0);
  const [configureId, setConfigureId] = useState<AgentId | null>(null);
  const [removeId, setRemoveId] = useState<AgentId | null>(null);
  const switchRevertKey = useRef<string | null>(null);

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: the retry counter re-fires the same read
  useEffect(() => {
    let active = true;
    void applyConnections([])
      .then((result) => {
        if (!active) return;
        if (result.snapshot !== null) setSnapshot(result.snapshot);
        setReadFailed(!readProducedFacts(result.snapshot));
        setReadOnly(result.unavailable === true);
      })
      .catch(() => {
        if (active) setReadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [applyConnections, reloadInstallState]);

  const catalogAgents = catalog.data?.agents;
  const registeredKeys = new Set(registered.map((a) => `${a.source}:${a.id}`));
  const installedClis = terminalLaunch?.installedClis ?? {};

  const connections = snapshot === null ? [] : connectionsFromSnapshot(snapshot);
  const configureConnection = connections.find((c) => c.id === configureId) ?? null;
  const removeConnection = connections.find((c) => c.id === removeId) ?? null;

  async function applyAndRefresh(
    intents: readonly ApplyIntent[],
  ): Promise<ApplyAgentConnectionsResult> {
    const result = await applyConnections(intents);
    if (result.snapshot !== null) setSnapshot(result.snapshot);
    setReadFailed(!readProducedFacts(result.snapshot));
    if (result.unavailable === true) setReadOnly(true);
    return result;
  }

  function rowPresence(agentId: AgentId | undefined, detected: boolean | null): RowPresence {
    if (detected === false) return 'absent';
    if (detected === true) return 'present';
    return agentId === undefined ? 'unknown' : resolvePresence(agentId, snapshot, detected);
  }

  const terminalRowAgentIds = new Set<AgentId>(
    TERMINAL_CLI_IDS.map(agentIdForTerminalCli).filter((id): id is AgentId => id !== undefined),
  );
  const externalRowAgentIds = new Set<AgentId>(
    VISIBLE_TARGETS.map((target) => agentIdForHandoffTarget(target.id)).filter(
      (id): id is AgentId => id !== undefined,
    ),
  );
  const pairedAgentIds = new Set<AgentId>(
    [...terminalRowAgentIds].filter((id) => externalRowAgentIds.has(id)),
  );

  function connectionSlots(
    agentId: AgentId | undefined,
    rowLabel: string,
    rowTestId: string,
    mode: AgentMode,
    enabled: boolean,
    detected: boolean | null,
    presence: RowPresence,
    installUrl?: string | null,
  ): { status: ReactNode; action: ReactNode; statusId?: string } {
    const connection =
      agentId === undefined ? undefined : connections.find((c) => c.id === agentId);
    if (
      connection === undefined ||
      agentId === undefined ||
      snapshot === null ||
      !readProducedFacts(snapshot)
    ) {
      return { status: undefined, action: undefined, statusId: undefined };
    }
    const action = rowActionFor({
      enabled,
      installedCount: installedCount(partsForConnection(connection)),
      presence,
      configurable: hasConfigurableCell(connection),
      setupDocSlug: connection.row.setupDocSlug,
      installUrl:
        installUrl === undefined
          ? (AGENT_REGISTRY[agentId].external?.installUrl ?? null)
          : installUrl,
    });
    const rowStatus = deriveRowConnectionStatus({ agentId, mode, snapshot, detected });
    const speaks = rowStatus === 'connected' || (rowStatus === 'not-connected' && enabled);
    const statusId = speaks ? `${rowTestId}-status` : undefined;
    const actionable = !readOnly || action.kind === 'install' || action.kind === 'setup-doc';
    const projectMcp = connection.cells.projectMcp;
    const ownsFollowup =
      projectMcp === undefined ||
      !pairedAgentIds.has(agentId) ||
      followupRowFamily(projectMcp.consentClass) === mode;
    const followup = ownsFollowup
      ? followupHintText(deriveRowFollowup({ agentId, mode, snapshot, detected, projectMcp }))
      : null;
    return {
      status: speaks ? (
        <>
          <ConnectionStatusLine status={rowStatus} enabled={enabled} />
          {followup === null ? null : (
            <span
              role="status"
              className="mt-0.5 block text-amber-700 text-xs dark:text-amber-400"
              data-testid={`${rowTestId}-followup`}
            >
              {followup}
            </span>
          )}
        </>
      ) : undefined,
      action: actionable ? (
        <RowActionButton
          action={action}
          rowLabel={rowLabel}
          describedById={statusId}
          onConfigure={() => setConfigureId(agentId)}
          onRemove={() => setRemoveId(agentId)}
        />
      ) : undefined,
      statusId,
    };
  }

  function toggleConnectable(
    key: string,
    agentId: AgentId | undefined,
    mode: AgentMode,
    next: boolean,
    detected?: boolean | null,
  ): void {
    setAgentEnabled(key, next);
    if (!next || readOnly || agentId === undefined || snapshot === null) return;
    const connection = connections.find((c) => c.id === agentId);
    if (connection === undefined || !hasConfigurableCell(connection)) return;
    if (deriveRowConnectionStatus({ agentId, mode, snapshot, detected }) !== 'not-connected') {
      return;
    }
    switchRevertKey.current = key;
    setConfigureId(agentId);
  }

  const q = query.trim().toLowerCase();
  const matches = (text: string): boolean => q === '' || text.toLowerCase().includes(q);

  const inAppAgents = (catalogAgents ?? []).filter((agent) => matches(agent.name));
  const cliPresent = (cli: TerminalCli): boolean => installedClis[cli] !== false;
  const terminalClis = TERMINAL_CLI_IDS.filter((cli) => {
    const { displayName } = TERMINAL_CLIS[cli];
    return matches(displayName) || matches(t`${displayName} CLI`) || matches(cli);
  }).sort(
    (a, b) =>
      Number(cliPresent(b)) - Number(cliPresent(a)) ||
      TERMINAL_CLIS[a].displayName.localeCompare(TERMINAL_CLIS[b].displayName),
  );
  const desktopTargets = VISIBLE_TARGETS.filter((target) => {
    const { displayName } = target;
    return matches(t`${displayName} Desktop`) || matches(target.id);
  }).sort(
    (a, b) => Number(states[a.id]?.installed === false) - Number(states[b.id]?.installed === false),
  );

  const canLaunchTerminal = terminalLaunch !== null;

  const rowedElsewhere = new Set<AgentId>([...terminalRowAgentIds, ...externalRowAgentIds]);
  const unlaunchableIds = CONNECTION_ROW_AGENT_IDS.filter(
    (id) => !rowedElsewhere.has(id) && matches(connectionLabel(id)),
  );

  const searching = q !== '';
  const catalogReady = !catalog.isLoading && !catalog.isError;
  const noMatches =
    searching &&
    catalogReady &&
    inAppAgents.length === 0 &&
    terminalClis.length === 0 &&
    desktopTargets.length === 0 &&
    unlaunchableIds.length === 0;
  const showInApp = !searching || catalog.isLoading || catalog.isError || inAppAgents.length > 0;
  const showTerminal = !searching || terminalClis.length > 0;
  const showDesktop = !searching || desktopTargets.length > 0 || unlaunchableIds.length > 0;

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
  const terminalHasPresent = canLaunchTerminal && terminalClis.some(cliPresent);
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
                rowTestId={`configure-agents-in-app-row-${agent.source}:${agent.id}`}
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
        const detected = installedClis[cli] ?? null;
        const presence = rowPresence(agentIdForTerminalCli(cli), detected);
        const enabled = isTerminalCliRowEnabled(overrides, cli, presence === 'absent');
        const rowTestId = `configure-agents-terminal-row-${cli}`;
        const { status, action, statusId } = connectionSlots(
          agentIdForTerminalCli(cli),
          t`${displayName} CLI`,
          rowTestId,
          'terminal',
          enabled,
          detected,
          presence,
          registryInstallUrl(agentIdForTerminalCli(cli)) ?? TERMINAL_CLIS[cli].docsUrl,
        );
        return (
          <AgentRow
            key={cli}
            icon={<TargetIcon id={cliIconTargetId(cli)} className="size-4" aria-hidden="true" />}
            name={t`${displayName} CLI`}
            hint={presence === 'absent' ? t`Not installed` : undefined}
            status={status}
            action={action}
            checked={enabled}
            disabled={isToggleLocked(presence, enabled)}
            ariaLabel={t`Enable ${displayName} CLI`}
            testId={`configure-agents-terminal-${cli}`}
            rowTestId={rowTestId}
            statusId={statusId}
            onToggle={
              canLaunchTerminal
                ? (next) =>
                    toggleConnectable(
                      terminalEnabledKey(cli),
                      agentIdForTerminalCli(cli),
                      'terminal',
                      next,
                      installedClis[cli] ?? null,
                    )
                : undefined
            }
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
        const enabled = isDesktopTargetEnabled(overrides, target.id, installed);
        const presence = rowPresence(agentIdForHandoffTarget(target.id), installed);
        const rowTestId = `configure-agents-desktop-row-${target.id}`;
        const { status, action, statusId } = connectionSlots(
          agentIdForHandoffTarget(target.id),
          t`${displayName} Desktop`,
          rowTestId,
          'external',
          enabled,
          installed,
          presence,
        );
        return (
          <AgentRow
            key={target.id}
            icon={<TargetIcon id={target.id} className="size-4" aria-hidden="true" />}
            name={t`${displayName} Desktop`}
            hint={presence === 'absent' ? t`Not installed` : undefined}
            status={status}
            action={action}
            checked={enabled}
            disabled={isToggleLocked(presence, enabled)}
            ariaLabel={t`Enable ${displayName} Desktop`}
            testId={`configure-agents-desktop-${target.id}`}
            rowTestId={rowTestId}
            statusId={statusId}
            onToggle={(next) =>
              toggleConnectable(
                desktopEnabledKey(target.id),
                agentIdForHandoffTarget(target.id),
                'external',
                next,
                installed,
              )
            }
          />
        );
      })}
      {unlaunchableIds.map((agentId) => {
        const connection = connections.find((c) => c.id === agentId) ?? null;
        const detected = connection?.row.detected ?? null;
        const label = connectionLabel(agentId);
        const rowTestId = `agent-connection-${agentId}`;
        const slots = connectionSlots(
          agentId,
          label,
          rowTestId,
          'external',
          connection === null || !allAvailableCellsChecked(connection),
          detected,
          rowPresence(agentId, detected),
        );
        return (
          <AgentRow
            key={agentId}
            icon={
              <ConnectionAgentIcon agentId={agentId} className="size-4 text-muted-foreground" />
            }
            name={label}
            hint={
              rowPresence(agentId, detected) === 'absent'
                ? t`Not detected on this machine`
                : undefined
            }
            status={slots.status}
            action={slots.action}
            ariaLabel={label}
            testId={`configure-agents-unlaunchable-${agentId}`}
            rowTestId={rowTestId}
            statusId={slots.statusId}
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
      data-field="section:agent-connections"
      data-testid="settings-configure-agents"
    >
      <SettingsSectionHeader titleId={titleId} title={t`Agent connections`}>
        {t`Choose which agents appear in agent menus across the app, and set them up to read and update your documents.`}
      </SettingsSectionHeader>

      <div className="relative">
        <Search
          className="-translate-y-1/2 absolute top-1/2 start-2.5 size-4 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t`Search agents`}
          aria-label={t`Search agents`}
          className="ps-8"
          data-testid="configure-agents-search"
        />
      </div>

      {readOnly ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-md border px-3 py-2.5 text-muted-foreground text-sm"
          data-testid="configure-agents-read-only"
        >
          <TriangleAlert aria-hidden className="size-4 shrink-0" />
          <span>{t`Managing agent connections is unavailable in this build.`}</span>
        </div>
      ) : null}

      {readFailed ? (
        <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-muted-foreground text-sm">
          <span className="flex min-w-0 items-center gap-2">
            <WifiOff aria-hidden className="size-4 shrink-0" />
            <span role="status">{t`Couldn't check which tools are connected.`}</span>
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => setReloadInstallState((value) => value + 1)}
          >
            {t`Retry`}
          </Button>
        </div>
      ) : null}

      {noMatches ? (
        <p
          className="py-6 text-center text-muted-foreground text-sm"
          data-testid="configure-agents-no-results"
        >
          {t`No agents match your search.`}
        </p>
      ) : null}

      {groups}

      <ConfigureConnectionDialog
        key={`configure:${configureId ?? 'closed'}`}
        connection={configureConnection}
        paired={configureId !== null && pairedAgentIds.has(configureId)}
        open={configureConnection !== null}
        onOpenChange={(open) => {
          if (open) return;
          if (switchRevertKey.current !== null) {
            setAgentEnabled(switchRevertKey.current, false);
            switchRevertKey.current = null;
          }
          setConfigureId(null);
        }}
        onSave={(parts, alsoRemove) =>
          configureConnection === null
            ? Promise.resolve({
                ok: false,
                report: { actions: [], conflicts: [], withheld: [] },
                snapshot: null,
              })
            : applyAndRefresh(intentsForParts(configureConnection, parts, alsoRemove)).then(
                (result) => {
                  if (result.ok) switchRevertKey.current = null;
                  return result;
                },
              )
        }
      />
      <RemoveConnectionDialog
        key={`remove:${removeId ?? 'closed'}`}
        connection={removeConnection}
        paired={removeId !== null && pairedAgentIds.has(removeId)}
        open={removeConnection !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveId(null);
        }}
        onRemove={(alsoRemove = []) =>
          removeConnection === null
            ? Promise.resolve({
                ok: false,
                report: { actions: [], conflicts: [], withheld: [] },
                snapshot: null,
              })
            : applyAndRefresh(removalIntents(removeConnection, alsoRemove))
        }
      />
    </section>
  );
}
