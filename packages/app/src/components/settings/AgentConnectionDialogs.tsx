import {
  type AgentId,
  type ApplyIntent,
  type BlockedReason,
  buildConnectionsView,
  CONNECTION_ROW_AGENT_IDS,
  type ConnectionCell,
  EDITOR_LABELS,
  type HostSnapshot,
  type PlanConflict,
  type ConnectionRow as RegistryConnectionRow,
  requiresExplicitConsent,
  type SatisfierId,
  type SurfaceState,
} from '@inkeep/open-knowledge-core';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { Folder, Info, Monitor, Sparkles, TriangleAlert, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { AgentBrandIcon } from '@/components/AgentIconCluster';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldContent, FieldLegend, FieldSet, FieldTitle } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { connectionPathDisplay, sharedPathDisplays } from '@/lib/agent-connection-paths';
import type { ApplyAgentConnectionsResult } from '@/lib/agent-connections';
import { guidanceText, troubleshootingText } from '@/lib/agent-guidance-copy';
import { formatToolList } from '@/lib/tool-list-format';

type ConnectionPart = 'projectMcp' | 'projectSkill' | 'globalMcp' | 'discoverySkill';

interface ConnectionParts {
  projectMcp: boolean;
  projectSkill: boolean;
  globalMcp: boolean;
  discoverySkill: boolean;
}

const EMPTY_PARTS: ConnectionParts = {
  projectMcp: false,
  projectSkill: false,
  globalMcp: false,
  discoverySkill: false,
};

const CONNECTION_PARTS: readonly ConnectionPart[] = [
  'projectMcp',
  'projectSkill',
  'globalMcp',
  'discoverySkill',
];

const PART_GROUP: Readonly<Record<ConnectionPart, 'project' | 'machine'>> = {
  projectMcp: 'project',
  projectSkill: 'project',
  globalMcp: 'machine',
  discoverySkill: 'machine',
};

function presentParts(
  connection: AgentConnection,
  group: 'project' | 'machine',
): readonly (readonly [ConnectionPart, ConnectionCell])[] {
  return CONNECTION_PARTS.flatMap((part) => {
    if (PART_GROUP[part] !== group) return [];
    const cell = connection.cells[part];
    return cell === undefined ? [] : [[part, cell] as const];
  });
}

type VisibleAgentId = (typeof CONNECTION_ROW_AGENT_IDS)[number];

export interface AgentConnection {
  id: VisibleAgentId;
  label: string;
  row: RegistryConnectionRow;
  cells: Partial<Record<ConnectionPart, ConnectionCell>>;
}

export type ApplyConnections = (
  intents: readonly ApplyIntent[],
) => Promise<ApplyAgentConnectionsResult>;

function partForCell(cell: ConnectionCell): ConnectionPart | null {
  if (cell.scope === 'project' && cell.piece === 'mcp') return 'projectMcp';
  if (cell.scope === 'project' && cell.piece === 'skill') return 'projectSkill';
  if (cell.scope === 'user' && cell.piece === 'mcp') return 'globalMcp';
  if (cell.scope === 'user' && cell.piece === 'skill') return 'discoverySkill';
  return null;
}

function connectionFromRow(row: RegistryConnectionRow): AgentConnection | null {
  if (!CONNECTION_ROW_AGENT_IDS.includes(row.agentId as VisibleAgentId)) return null;
  const id = row.agentId as VisibleAgentId;
  const cells: Partial<Record<ConnectionPart, ConnectionCell>> = {};
  for (const group of row.scopes) {
    for (const cell of group.cells) {
      const part = partForCell(cell);
      if (part !== null) cells[part] = cell;
    }
  }
  return { id, label: connectionLabel(id), row, cells };
}

export function connectionLabel(id: VisibleAgentId): string {
  return EDITOR_LABELS[id];
}

export function ConnectionAgentIcon({
  agentId,
  className,
}: {
  agentId: VisibleAgentId;
  className: string;
}) {
  if (agentId === 'lm-studio') {
    return <Sparkles aria-hidden className={className} strokeWidth={1.5} />;
  }
  return <AgentBrandIcon host={agentId} aria-hidden className={className} />;
}

export function connectionsFromSnapshot(snapshot: HostSnapshot): AgentConnection[] {
  return buildConnectionsView({
    agentIds: CONNECTION_ROW_AGENT_IDS,
    probes: snapshot.probes,
    detection: snapshot.detection,
  }).rows.flatMap((row) => {
    const connection = connectionFromRow(row);
    return connection === null ? [] : [connection];
  });
}

export function partsForConnection(connection: AgentConnection): ConnectionParts {
  return {
    projectMcp: connection.cells.projectMcp?.checked === true,
    projectSkill: connection.cells.projectSkill?.checked === true,
    globalMcp: connection.cells.globalMcp?.checked === true,
    discoverySkill: connection.cells.discoverySkill?.checked === true,
  };
}

function defaultPartsForConnection(connection: AgentConnection): ConnectionParts {
  const current = partsForConnection(connection);
  if (installedCount(current) > 0) return current;
  return Object.fromEntries(
    CONNECTION_PARTS.map((part) => {
      const cell = connection.cells[part];
      return [
        part,
        cell !== undefined && cell.disabledReason === null && !requiresExplicitConsent(cell.state),
      ];
    }),
  ) as unknown as ConnectionParts;
}

export function installedCount(parts: ConnectionParts): number {
  return Object.values(parts).filter(Boolean).length;
}

export function hasConfigurableCell(connection: AgentConnection): boolean {
  return Object.values(connection.cells).some((cell) => cell.disabledReason === null);
}

export function allAvailableCellsChecked(connection: AgentConnection): boolean {
  const cells = Object.values(connection.cells);
  return cells.length > 0 && cells.every((cell) => cell.checked);
}

function PartInfo({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t`More information`}>
          <Info aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{children}</TooltipContent>
    </Tooltip>
  );
}

function PartExceptionChip({
  message,
  path,
  info,
}: {
  message: string;
  path: string | null;
  info: ReactNode;
}) {
  const { t } = useLingui();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-amber-700 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-400"
          aria-label={t`Why this needs attention`}
        >
          <TriangleAlert aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        <span className="flex flex-col gap-1.5">
          <span className="font-medium">{message}</span>
          {info}
          {path === null ? null : (
            <code className="wrap-break-word font-mono opacity-80">{path}</code>
          )}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

function PartCheckbox({
  id,
  checked,
  disabled,
  exception,
  state,
  title,
  description,
  info,
  path,
  sharedPaths,
  alsoAffects,
  note,
  onCheckedChange,
}: {
  id: string;
  checked: boolean;
  disabled: boolean;
  exception: ConnectionCell['exception'];
  state: SurfaceState;
  title: ReactNode;
  description: ReactNode;
  note: string | null;
  info: ReactNode;
  path: string | null;
  sharedPaths: readonly string[];
  alsoAffects: string | null;
  onCheckedChange: (checked: boolean) => void;
}) {
  const { t } = useLingui();
  const isWarning = exception === 'warning' || exception === 'error';
  const warning = !isWarning
    ? null
    : state === 'foreign'
      ? t`OpenKnowledge does not recognize this entry, and cannot safely replace it in this file's format.`
      : state === 'foreign-replaceable'
        ? t`OpenKnowledge does not recognize this entry. Turning it on replaces it.`
        : t`This entry changed after OpenKnowledge wrote it. Turning it on replaces it.`;
  const warningId = warning === null ? undefined : `${id}-warning`;
  const sharedId = alsoAffects === null ? undefined : `${id}-shared`;
  const describedBy = [warningId, sharedId].filter(Boolean).join(' ') || undefined;
  return (
    <Field
      orientation="horizontal"
      className="items-start gap-3"
      data-disabled={disabled || undefined}
    >
      {}
      <div className="flex h-7 items-center">
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          aria-describedby={describedBy}
          onCheckedChange={(value) => onCheckedChange(value === true)}
        />
      </div>
      <FieldContent>
        <div className="flex items-center gap-1">
          <Label htmlFor={id} className="cursor-pointer">
            <FieldTitle>{title}</FieldTitle>
          </Label>
          {}
          {warning !== null ? (
            <PartExceptionChip message={warning} path={path} info={disabled ? null : info} />
          ) : (
            <PartInfo>
              {}
              <span className="flex flex-col gap-1.5">
                {info}
                {path === null ? null : (
                  <code className="wrap-break-word font-mono opacity-80">{path}</code>
                )}
                {sharedPaths.map((shared) => (
                  <code key={shared} className="wrap-break-word font-mono opacity-80">
                    {shared}
                  </code>
                ))}
              </span>
            </PartInfo>
          )}
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
        {note === null ? null : (
          <p
            className="text-sm leading-relaxed text-muted-foreground"
            data-testid={`${id}-troubleshooting`}
          >
            {note}
          </p>
        )}
        {}
        {alsoAffects === null ? null : (
          <p id={sharedId} className="text-sm leading-relaxed text-amber-700 dark:text-amber-400">
            {t`This folder is also ${alsoAffects}'s.`}
          </p>
        )}
        {warningId === undefined ? null : (
          <span id={warningId} className="sr-only">
            {warning}
          </span>
        )}
      </FieldContent>
    </Field>
  );
}

function canChangePart(connection: AgentConnection, part: ConnectionPart): boolean {
  const cell = connection.cells[part];
  if (cell === undefined) return false;
  return cell.disabledReason === null;
}

function PartControl({
  part,
  cell,
  draft,
  setPart,
}: {
  part: ConnectionPart;
  cell: ConnectionCell;
  draft: ConnectionParts;
  setPart: (part: ConnectionPart, checked: boolean) => void;
}) {
  const { i18n, t } = useLingui();
  const disabled = cell.disabledReason !== null;
  const titles: Record<ConnectionPart, string> = {
    projectMcp: t`Project MCP server`,
    projectSkill: t`Project skill`,
    globalMcp: t`Global MCP server`,
    discoverySkill: t`OpenKnowledge discovery skill`,
  };

  const blockedReasons: Record<BlockedReason, string> = {
    foreign: t`OpenKnowledge does not recognize this entry, and cannot safely replace it in this file's format.`,
    'structural-na': t`This agent has no file of this kind on this machine yet. Open the agent once, then check again.`,
    'not-installable': t`This agent gives OpenKnowledge no way to set this up for you. Its setup guide has the manual steps.`,
    'agent-undetected': t`OpenKnowledge could not find this agent on this machine.`,
  };
  function blockedReason(): string {
    const reason = cell.disabledReason;
    return reason == null
      ? t`This option cannot be changed automatically.`
      : blockedReasons[reason];
  }

  const foreignInfo =
    cell.state === 'foreign-replaceable'
      ? t`Replaces the existing "open-knowledge" entry in this file. Other servers in the file are left alone.`
      : null;

  const alsoAffects =
    cell.piece === 'skill' && cell.sharedFolderWith.length > 0
      ? formatToolList(cell.sharedFolderWith.map(agentLabel), i18n.locale)
      : null;
  const exception = cell.exception;
  const isWarning = exception === 'warning' || exception === 'error';
  const sharedPaths = sharedPathDisplays(cell.pathId, cell.sharedFolderWith);
  const guidance = guidanceText(cell.guidance);
  const common = {
    id: `${cell.agentId}-${part}`,
    checked: draft[part],
    disabled,
    exception,
    state: cell.state,
    note: cell.checked && !disabled ? troubleshootingText(cell.troubleshooting) : null,
    path: disabled && !isWarning ? null : (cell.resolvedPath ?? connectionPathDisplay(cell.pathId)),
    sharedPaths: disabled && !isWarning ? [] : sharedPaths,
    alsoAffects: disabled ? null : alsoAffects,
    onCheckedChange: (checked: boolean) => setPart(part, checked),
  };

  switch (part) {
    case 'projectMcp':
      return (
        <PartCheckbox
          {...common}
          title={titles[part]}
          description={
            guidance ?? (
              <Trans>
                Connects the agent to this project so it can read, search, and edit your documents.
              </Trans>
            )
          }
          info={
            disabled
              ? blockedReason()
              : (foreignInfo ?? (
                  <Trans>Adds an OpenKnowledge MCP entry to this project's agent config.</Trans>
                ))
          }
        />
      );
    case 'projectSkill':
      return (
        <PartCheckbox
          {...common}
          title={titles[part]}
          description={
            guidance ?? (
              <Trans>
                Gives the agent instructions for working with your documents and keeps its edits
                attributed.
              </Trans>
            )
          }
          info={
            disabled ? (
              blockedReason()
            ) : (
              <Trans>Installs the OpenKnowledge project skill for this agent.</Trans>
            )
          }
        />
      );
    case 'globalMcp':
      return (
        <PartCheckbox
          {...common}
          title={titles[part]}
          description={
            guidance ?? (
              <Trans>Connects the agent to OpenKnowledge in every project on this machine.</Trans>
            )
          }
          info={
            disabled
              ? blockedReason()
              : (foreignInfo ?? (
                  <Trans>Adds a global OpenKnowledge MCP entry for this agent.</Trans>
                ))
          }
        />
      );
    case 'discoverySkill':
      return (
        <PartCheckbox
          {...common}
          title={titles[part]}
          description={
            guidance ?? (
              <Trans>Help your agents discover and use OpenKnowledge in any project.</Trans>
            )
          }
          info={
            disabled ? (
              blockedReason()
            ) : (
              <Trans>Installs the OpenKnowledge discovery skill for this agent.</Trans>
            )
          }
        />
      );
  }
}

type ReportedAction = ApplyAgentConnectionsResult['report']['actions'][number];

function failedPartTitle(failed: ReportedAction): ReactNode | null {
  if (failed.piece === 'mcp' && failed.scope === 'project') {
    return <Trans>Project MCP server</Trans>;
  }
  if (failed.piece === 'skill' && failed.scope === 'project') {
    return <Trans>Project skill</Trans>;
  }
  if (failed.piece === 'mcp' && failed.scope === 'user') {
    return <Trans>Global MCP server</Trans>;
  }
  if (failed.piece === 'skill' && failed.scope === 'user') {
    return <Trans>OpenKnowledge discovery skill</Trans>;
  }
  return null;
}

function prerequisitePair(
  result: ApplyAgentConnectionsResult,
  connection: AgentConnection,
  titles: Record<ConnectionPart, string>,
  kind: 'prerequisite-unavailable' | 'prerequisite-removed',
): {
  dependent: string;
  prerequisite: string;
  blockedReason: PlanConflict['blockedReason'];
} | null {
  const conflict = result.report.conflicts.find((entry) => entry.kind === kind);
  if (conflict === undefined) return null;
  const partOf = (id: SatisfierId): ConnectionPart | undefined =>
    CONNECTION_PARTS.find((part) => connection.cells[part]?.satisfierId === id);
  const [prerequisiteId, dependentId] = conflict.satisfierIds;
  const prerequisite = prerequisiteId === undefined ? undefined : partOf(prerequisiteId);
  const dependent = dependentId === undefined ? undefined : partOf(dependentId);
  if (prerequisite === undefined || dependent === undefined) return null;
  return {
    dependent: titles[dependent],
    prerequisite: titles[prerequisite],
    blockedReason: conflict.blockedReason,
  };
}

function ApplyFailureAlert({
  result,
  connection,
}: {
  result: ApplyAgentConnectionsResult;
  connection: AgentConnection;
}) {
  const { t } = useLingui();
  const titles: Record<ConnectionPart, string> = {
    projectMcp: t`Project MCP server`,
    projectSkill: t`Project skill`,
    globalMcp: t`Global MCP server`,
    discoverySkill: t`OpenKnowledge discovery skill`,
  };
  const remedy = prerequisitePair(result, connection, titles, 'prerequisite-unavailable');
  if (remedy !== null) {
    const { dependent, prerequisite } = remedy;
    const remedyText = (): string => {
      switch (remedy.blockedReason) {
        case 'foreign':
          return t`${dependent} needs ${prerequisite}, and OpenKnowledge cannot safely replace that entry in this file's format.`;
        case 'structural-na':
          return t`${dependent} needs ${prerequisite}, and this agent has no file of that kind on this machine yet. Open the agent once, then try again.`;
        case 'not-installable':
          return t`${dependent} needs ${prerequisite}, which OpenKnowledge cannot set up for you. Its setup guide has the manual steps.`;
        case 'agent-undetected':
          return t`${dependent} needs ${prerequisite}, and OpenKnowledge could not find this agent on this machine.`;
        default:
          return t`${dependent} needs ${prerequisite}, and OpenKnowledge does not recognize that entry. Tick ${prerequisite} to replace it, then save again.`;
      }
    };
    return (
      <p role="alert" className="text-sm text-destructive">
        {remedyText()}
      </p>
    );
  }
  const removed = prerequisitePair(result, connection, titles, 'prerequisite-removed');
  if (removed !== null) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t`${removed.dependent} needs ${removed.prerequisite}. Turn both off, or keep both on.`}
      </p>
    );
  }
  if (result.unavailable === true) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t`Managing agent connections is unavailable in this build.`}
      </p>
    );
  }

  const detailFor = (failed: ReportedAction): string | null => {
    switch (failed.errorId) {
      case 'surface-missing':
        return t`This agent has no file of this kind on this machine yet. Open the agent once, then check again.`;
      case 'foreign-artifact':
        return t`OpenKnowledge does not recognize this entry, and cannot safely replace it in this file's format.`;
      case 'no-writer':
      case 'not-installable':
        return t`This agent gives OpenKnowledge no way to set this up for you. Its setup guide has the manual steps.`;
      case 'dependency-failed':
        return t`This could not be set up because the MCP server entry it needs was not written.`;
      case 'write-declined':
        return t`OpenKnowledge left this file alone because it could not parse it safely. Fix the file by hand, then try again.`;
      case 'write-failed':
      case 'executor-threw':
      case 'unrecognized-outcome':
        return t`Writing this file failed. Check the OpenKnowledge log for the reason.`;
      default:
        return null;
    }
  };
  const rows = result.report.actions
    .filter((action) => action.errorId !== undefined)
    .map((failed) => ({
      key: failed.satisfierId,
      title: failedPartTitle(failed),
      managedInSkillsStudio:
        failed.errorId === 'no-writer' && failed.piece === 'skill' && failed.scope === 'user',
      detail: detailFor(failed),
    }))
    .filter((row) => row.managedInSkillsStudio || row.detail !== null);

  if (rows.length === 0) {
    return (
      <div role="alert" className="space-y-1 text-sm text-destructive">
        <p>
          <Trans>Something went wrong. Please try again.</Trans>
        </p>
        {result.error === undefined ? null : (
          <code className="block wrap-break-word font-mono text-xs opacity-80">{result.error}</code>
        )}
      </div>
    );
  }

  return (
    <div role="alert" className="space-y-2 text-sm text-destructive">
      {rows.map((row) => (
        <div key={row.key} className="space-y-1">
          {row.title === null ? null : <p className="font-medium">{row.title}</p>}
          <p>
            {row.managedInSkillsStudio ? (
              <Trans>
                Discovery skills are managed for all AI tools together. Install this one from
                Settings → Skills Studio.
              </Trans>
            ) : (
              row.detail
            )}
          </p>
        </div>
      ))}
    </div>
  );
}

function SkillSuggestion() {
  return (
    <p className="text-xs text-muted-foreground">
      <Trans>
        Without the skill the agent still works, but it loses edit attribution and the live preview.
      </Trans>
    </p>
  );
}

function PairedRowsNote({ label }: { label: string }) {
  const { t } = useLingui();
  return (
    <p className="text-sm text-muted-foreground">
      {t`The terminal and desktop rows for ${label} share one setup, so changes here apply to both.`}
    </p>
  );
}

function PairedRemovalNote({ label }: { label: string }) {
  const { t } = useLingui();
  return (
    <p className="text-sm text-muted-foreground">
      {t`The terminal and desktop rows for ${label} share one setup, so removing it disconnects both.`}
    </p>
  );
}

export function ConfigureConnectionDialog({
  connection,
  open,
  onOpenChange,
  onSave,
  paired = false,
}: {
  connection: AgentConnection | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (
    parts: ConnectionParts,
    alsoRemove?: readonly SatisfierId[],
  ) => Promise<ApplyAgentConnectionsResult>;
  paired?: boolean;
}) {
  const { i18n, t } = useLingui();
  const [draft, setDraft] = useState<ConnectionParts>(() =>
    connection === null ? EMPTY_PARTS : defaultPartsForConnection(connection),
  );
  const [saving, setSaving] = useState(false);
  const [saveFailure, setSaveFailure] = useState<ApplyAgentConnectionsResult | null>(null);
  const [sharedChoice, setSharedChoice] = useState<SharedRemovalChoice | null>(null);
  const overwriting =
    connection !== null &&
    CONNECTION_PARTS.some((part) => {
      const cell = connection.cells[part];
      return draft[part] && cell !== undefined && requiresExplicitConsent(cell.state);
    });

  function setPart(part: ConnectionPart, checked: boolean) {
    setDraft((current) => ({ ...current, [part]: checked }));
    setSharedChoice(null);
  }

  const suggestSkill =
    connection !== null && !draft.projectSkill && canChangePart(connection, 'projectSkill');
  const projectParts = connection === null ? [] : presentParts(connection, 'project');
  const machineParts = connection === null ? [] : presentParts(connection, 'machine');
  const removingCount = CONNECTION_PARTS.filter(
    (part) => connection?.cells[part]?.checked === true && !draft[part],
  ).length;
  const addingCount = CONNECTION_PARTS.filter(
    (part) =>
      connection?.cells[part] !== undefined && draft[part] && !connection.cells[part]?.checked,
  ).length;
  const tally =
    addingCount > 0 && removingCount > 0
      ? t`${plural(addingCount, { one: '# added', other: '# added' })} · ${plural(removingCount, { one: '# removed', other: '# removed' })}`
      : addingCount > 0
        ? plural(addingCount, { one: '# added', other: '# added' })
        : removingCount > 0
          ? plural(removingCount, { one: '# removed', other: '# removed' })
          : null;
  const removingOnly = removingCount > 0 && addingCount === 0;
  const disconnecting = removingOnly && CONNECTION_PARTS.every((part) => !draft[part]);
  const widenable = sharedChoice !== null && sharedChoice.peerSatisfierIds.length > 0;
  const footerNote =
    connection === null
      ? null
      : sharedChoice !== null
        ? widenable
          ? addingCount > 0
            ? t`Removes it for ${connection.label} and ${sharedChoice.peers}. ${plural(addingCount, { one: '# added', other: '# added' })} · ${plural(removingCount, { one: '# removed', other: '# removed' })}`
            : t`Removes it for ${connection.label} and ${sharedChoice.peers}. ${plural(removingCount, { one: '# removed', other: '# removed' })}`
          : tally
        : disconnecting
          ? t`This disconnects ${connection.label} from OpenKnowledge.`
          : tally;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !saving && onOpenChange(nextOpen)}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader className="gap-2">
          <DialogTitle className="flex items-center gap-2 text-lg">
            {connection ? (
              <ConnectionAgentIcon
                agentId={connection.id}
                className="size-5 text-muted-foreground"
              />
            ) : null}
            {connection?.label}
          </DialogTitle>
          <DialogDescription>
            {connection
              ? t`Choose what OpenKnowledge sets up for ${connection.label}.`
              : t`Choose what OpenKnowledge sets up.`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-6">
          {paired && connection ? <PairedRowsNote label={connection.label} /> : null}
          {projectParts.length > 0 ? (
            <FieldSet className="gap-5">
              <FieldLegend className="flex items-center gap-2 font-mono data-[variant=legend]:text-xs uppercase tracking-wide text-muted-foreground">
                <Folder aria-hidden className="size-3.5" />
                <Trans>This project</Trans>
                <Badge variant="secondary" className="font-mono text-[10px] uppercase">
                  <Trans>Recommended</Trans>
                </Badge>
              </FieldLegend>
              {projectParts.map(([part, cell]) => (
                <PartControl key={part} part={part} cell={cell} draft={draft} setPart={setPart} />
              ))}
              {suggestSkill ? <SkillSuggestion /> : null}
            </FieldSet>
          ) : null}
          {machineParts.length > 0 ? (
            <FieldSet className="gap-5">
              <FieldLegend className="flex items-center gap-2 font-mono data-[variant=legend]:text-xs uppercase tracking-wide text-muted-foreground">
                <Monitor aria-hidden className="size-3.5" />
                <Trans>This machine</Trans>
              </FieldLegend>
              {machineParts.map(([part, cell]) => (
                <PartControl key={part} part={part} cell={cell} draft={draft} setPart={setPart} />
              ))}
            </FieldSet>
          ) : null}
          {sharedChoice !== null ? (
            <SharedRemovalNote choice={sharedChoice} />
          ) : saveFailure !== null && connection !== null ? (
            <ApplyFailureAlert result={saveFailure} connection={connection} />
          ) : null}
        </DialogBody>
        <DialogFooter className="items-center">
          <p
            role="status"
            className="me-auto text-xs text-muted-foreground"
            aria-live="polite"
            aria-atomic="true"
          >
            {footerNote}
          </p>
          <Button
            variant="outline"
            className="font-mono uppercase"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button
            variant={overwriting || removingCount > 0 ? 'destructive' : 'default'}
            className="font-mono uppercase"
            disabled={
              saving || (sharedChoice === null ? addingCount + removingCount === 0 : !widenable)
            }
            onClick={() => {
              setSaving(true);
              setSaveFailure(null);
              const widen = sharedChoice?.peerSatisfierIds;
              setSharedChoice(null);
              void onSave(draft, widen)
                .then((result) => {
                  if (result.ok) {
                    onOpenChange(false);
                    return;
                  }
                  const choice =
                    connection === null
                      ? null
                      : sharedRemovalChoice(result, connection, i18n.locale);
                  if (choice === null) setSaveFailure(result);
                  else setSharedChoice(choice);
                })
                .catch(() =>
                  setSaveFailure({
                    ok: false,
                    report: { actions: [], conflicts: [], withheld: [] },
                    snapshot: null,
                  }),
                )
                .finally(() => setSaving(false));
            }}
          >
            {saving ? (
              <Trans>Saving</Trans>
            ) : widenable ? (
              <Trans>Remove for both</Trans>
            ) : overwriting ? (
              <Trans>Replace and save</Trans>
            ) : removingOnly ? (
              <Trans>Remove</Trans>
            ) : (
              <Trans>Save changes</Trans>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RemovalRow {
  cell: ConnectionCell;
  part: ConnectionPart;
  label: ReactNode;
  path: string | null;
  scope: 'project' | 'machine';
  alsoAffects: string | null;
}

function labelForPart(part: ConnectionPart): ReactNode {
  switch (part) {
    case 'projectMcp':
      return <Trans>Project MCP server</Trans>;
    case 'projectSkill':
      return <Trans>Project skill</Trans>;
    case 'globalMcp':
      return <Trans>Global MCP server</Trans>;
    case 'discoverySkill':
      return <Trans>OpenKnowledge discovery skill</Trans>;
  }
}

function removalRows(connection: AgentConnection, locale: string): RemovalRow[] {
  return CONNECTION_PARTS.flatMap((part) => {
    const cell = connection.cells[part];
    if (cell?.checked !== true) return [];
    return [
      {
        cell,
        part,
        label: labelForPart(part),
        path: cell.resolvedPath ?? connectionPathDisplay(cell.pathId),
        scope: cell.scope === 'project' ? 'project' : 'machine',
        alsoAffects:
          cell.piece === 'skill' && cell.sharedFolderWith.length > 0
            ? formatToolList(cell.sharedFolderWith.map(agentLabel), locale)
            : null,
      } satisfies RemovalRow,
    ];
  });
}

function RemovalGroup({ scope, rows }: { scope: 'project' | 'machine'; rows: RemovalRow[] }) {
  const { t } = useLingui();
  if (rows.length === 0) return null;
  return (
    <div>
      <div className="flex items-center gap-2 border-b bg-muted/60 px-3 py-2 font-mono text-xs uppercase tracking-wide text-muted-foreground">
        {scope === 'project' ? (
          <Folder aria-hidden className="size-3.5" />
        ) : (
          <Monitor aria-hidden className="size-3.5" />
        )}
        {scope === 'project' ? <Trans>This project</Trans> : <Trans>This machine</Trans>}
      </div>
      <ul className="divide-y divide-border">
        {rows.map((row) => {
          const alsoAffects = row.alsoAffects;
          return (
            <li key={row.cell.satisfierId} className="flex items-start gap-3 px-3 py-3">
              <X aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div className="min-w-0">
                <p className="text-sm font-medium">{row.label}</p>
                {row.path === null ? null : (
                  <code className="block truncate text-xs text-muted-foreground">{row.path}</code>
                )}
                {alsoAffects === null ? null : (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    {t`This folder is also ${alsoAffects}'s.`}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function agentLabel(agentId: AgentId): string {
  const labels: Partial<Record<AgentId, string>> = EDITOR_LABELS;
  return labels[agentId] ?? agentId;
}

interface SharedRemovalChoice {
  readonly peers: string;
  readonly path: string | null;
  readonly peerSatisfierIds: readonly SatisfierId[];
}

function sharedRemovalChoice(
  result: ApplyAgentConnectionsResult,
  connection: AgentConnection,
  locale: string,
): SharedRemovalChoice | null {
  const shared = result.report.conflicts.filter(
    (conflict): conflict is PlanConflict => conflict.kind === 'unresolved-shared-copy',
  );
  const own = new Set(Object.values(connection.cells).map((cell) => cell.satisfierId));
  const peerSatisfierIds = [...new Set(shared.flatMap((conflict) => conflict.satisfierIds))].filter(
    (id) => !own.has(id),
  );
  const peerAgentIds = [...new Set(shared.flatMap((conflict) => conflict.agentIds))].filter(
    (id) => id !== connection.id,
  );
  if (peerSatisfierIds.length === 0 && peerAgentIds.length === 0) return null;
  const paths = [
    ...new Set(
      shared
        .map((conflict) => connectionPathDisplay(conflict.pathId))
        .filter((path): path is string => path !== null),
    ),
  ];
  return {
    peers: formatToolList(peerAgentIds.map(agentLabel), locale),
    path: paths.length === 1 ? paths[0] : null,
    peerSatisfierIds,
  };
}

function SharedRemovalNote({ choice }: { choice: SharedRemovalChoice }) {
  const { peers, path } = choice;
  if (choice.peerSatisfierIds.length === 0) {
    return (
      <div role="status" className="rounded-md border bg-muted/50 p-3 text-sm">
        <Trans>
          This setup is shared with {peers}, and OpenKnowledge cannot change it from here. Unlink
          the folder in Skills Studio first.
        </Trans>
      </div>
    );
  }
  return (
    <div role="status" className="rounded-md border bg-muted/50 p-3 text-sm">
      {path === null ? (
        <Trans>
          This setup is shared with {peers}. Removing it here removes it for {peers} too.
        </Trans>
      ) : (
        <Trans>
          This setup is shared with {peers} through <code className="font-mono">{path}</code>.
          Removing it here removes it for {peers} too.
        </Trans>
      )}
    </div>
  );
}

export function RemoveConnectionDialog({
  connection,
  open,
  onOpenChange,
  onRemove,
  paired = false,
}: {
  connection: AgentConnection | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemove: (alsoRemove?: readonly SatisfierId[]) => Promise<ApplyAgentConnectionsResult>;
  paired?: boolean;
}) {
  const { i18n, t } = useLingui();
  const [removing, setRemoving] = useState(false);
  const [removeFailure, setRemoveFailure] = useState<ApplyAgentConnectionsResult | null>(null);
  const [sharedChoice, setSharedChoice] = useState<SharedRemovalChoice | null>(null);
  const rows = connection ? removalRows(connection, i18n.locale) : [];

  function submit(alsoRemove?: readonly SatisfierId[]) {
    if (connection === null) return;
    setRemoving(true);
    setRemoveFailure(null);
    setSharedChoice(null);
    void onRemove(alsoRemove)
      .then((result) => {
        if (result.ok) {
          onOpenChange(false);
          return;
        }
        const choice = sharedRemovalChoice(result, connection, i18n.locale);
        if (choice === null) setRemoveFailure(result);
        else setSharedChoice(choice);
      })
      .catch((err: unknown) =>
        setRemoveFailure({
          ok: false,
          report: { actions: [], conflicts: [], withheld: [] },
          snapshot: null,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      .finally(() => setRemoving(false));
  }
  return (
    <AlertDialog open={open} onOpenChange={(nextOpen) => !removing && onOpenChange(nextOpen)}>
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader className="gap-2">
          <AlertDialogTitle className="flex items-center gap-2 text-lg">
            {connection ? (
              <ConnectionAgentIcon
                agentId={connection.id}
                className="size-5 text-muted-foreground"
              />
            ) : null}
            {connection
              ? t`Remove OpenKnowledge from ${connection.label}?`
              : t`Remove OpenKnowledge?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            <Trans>
              This deletes the MCP server entries and skill files listed below. The agent will lose
              access to your documents until you add it again.
            </Trans>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogBody className="flex flex-col gap-4">
          <div className="overflow-hidden rounded-lg border">
            <RemovalGroup scope="project" rows={rows.filter((row) => row.scope === 'project')} />
            <RemovalGroup scope="machine" rows={rows.filter((row) => row.scope === 'machine')} />
          </div>
          {paired && connection ? <PairedRemovalNote label={connection.label} /> : null}
          <p className="text-sm text-muted-foreground">
            <Trans>Your documents are not touched.</Trans>
          </p>
          {sharedChoice !== null ? (
            <SharedRemovalNote choice={sharedChoice} />
          ) : removeFailure !== null && connection !== null ? (
            <ApplyFailureAlert result={removeFailure} connection={connection} />
          ) : null}
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={removing}>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className="font-mono uppercase"
            disabled={
              removing ||
              rows.length === 0 ||
              (sharedChoice !== null && sharedChoice.peerSatisfierIds.length === 0)
            }
            onClick={(event) => {
              event.preventDefault();
              submit(sharedChoice?.peerSatisfierIds);
            }}
          >
            {removing ? (
              <Trans>Saving</Trans>
            ) : sharedChoice !== null && sharedChoice.peerSatisfierIds.length > 0 ? (
              <Trans>Remove for both</Trans>
            ) : (
              <Trans>Remove</Trans>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function intentsForParts(
  connection: AgentConnection,
  parts: ConnectionParts,
  alsoRemove: readonly SatisfierId[] = [],
): ApplyIntent[] {
  const baseline = partsForConnection(connection);
  const peerIntents = alsoRemove.map(
    (id) => ({ satisfierId: id, desired: 'absent' }) satisfies ApplyIntent,
  );
  return [
    ...peerIntents,
    ...CONNECTION_PARTS.flatMap((part) => {
      const cell = connection.cells[part];
      if (cell === undefined || parts[part] === baseline[part]) return [];
      return [
        {
          satisfierId: cell.satisfierId,
          desired: parts[part] ? 'present' : 'absent',
        } satisfies ApplyIntent,
      ];
    }),
  ];
}

export function removalIntents(
  connection: AgentConnection,
  alsoRemove: readonly SatisfierId[] = [],
): ApplyIntent[] {
  const parts = partsForConnection(connection);
  const desired = Object.fromEntries(
    CONNECTION_PARTS.map((part) => [part, connection.cells[part] ? false : parts[part]]),
  ) as unknown as ConnectionParts;
  const peerIntents = alsoRemove.map(
    (id) => ({ satisfierId: id, desired: 'absent' }) satisfies ApplyIntent,
  );
  return [...intentsForParts(connection, desired), ...peerIntents];
}
