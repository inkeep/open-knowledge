// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — file uses raw <button>/<input>/<textarea> awaiting shadcn migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit
import {
  type AgentPresenceEntry,
  computeInitials,
  deriveIconColor,
  isPresenceSentinelDocName,
} from '@inkeep/open-knowledge-core';
import { plural, t } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Bird,
  Cat,
  Dog,
  Fish,
  type LucideProps,
  Rabbit,
  Rat,
  Shrimp,
  Snail,
  Squirrel,
  Turtle,
} from 'lucide-react';
import { type FC, useEffect, useRef, useState } from 'react';
import { AgentIcon } from '@/components/icons/AgentIcon';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDocumentContext } from '@/editor/DocumentContext';
import type { AwarenessUser } from './identity.ts';
import {
  type AgentParticipant,
  type HumanParticipant,
  type Participant,
  usePresence,
} from './use-presence';
import { useSyncStatus } from './use-sync-status';
import { useSyncToasts } from './use-sync-toasts';

const M_CURRENT_PRIMARY = 4;
const K_CROSSDOC_PRIMARY = 3;

const ANIMAL_ICON_MAP: Record<string, FC<LucideProps>> = {
  Bird,
  Cat,
  Dog,
  Fish,
  Mouse: Rat,
  Rabbit,
  Shrimp,
  Snail,
  Squirrel,
  Turtle,
};

export const ANIMAL_ICON_NAMES = Object.freeze(Object.keys(ANIMAL_ICON_MAP));

type HumanAvatarKind = { kind: 'initials' } | { kind: 'animal'; animal: string };

export function pickHumanAvatarKind(
  user: Pick<AwarenessUser, 'name' | 'principalId'>,
): HumanAvatarKind {
  const hasPrincipalId = typeof user.principalId === 'string' && user.principalId.length > 0;
  if (hasPrincipalId) return { kind: 'initials' };
  const animal = user.name.split(' ')[1];
  if (animal && Object.hasOwn(ANIMAL_ICON_MAP, animal)) {
    return { kind: 'animal', animal };
  }
  return { kind: 'initials' };
}

const AGENT_DISPLAY_NAME: Record<string, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  openai: 'Codex',
  github: 'Copilot',
  cline: 'Cline',
  bot: 'Agent',
};

function HumanAvatar({
  user,
  mode,
  tabCount,
}: {
  user: AwarenessUser;
  mode: HumanParticipant['mode'];
  tabCount: number;
}) {
  const { t } = useLingui();
  const avatarKind = pickHumanAvatarKind(user);
  const AnimalIcon = avatarKind.kind === 'animal' ? ANIMAL_ICON_MAP[avatarKind.animal] : undefined;
  const initials = computeInitials(user.name);
  const iconColor = deriveIconColor(user.color);
  const userName = user.name;
  const tooltipText =
    tabCount > 1
      ? t`${userName} · ${plural(tabCount, { one: '# tab', other: '# tabs' })}`
      : userName;
  const ariaLabel =
    tabCount > 1
      ? t`${userName}, ${plural(tabCount, { one: '# concurrent tab', other: '# concurrent tabs' })}`
      : userName;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          data-presence-badge="human"
          data-presence-mode={mode}
          role="img"
          aria-label={ariaLabel}
          className="inline-flex size-7 shrink-0 cursor-default items-center justify-center rounded-full ring-2 ring-background"
          style={{ backgroundColor: user.color }}
        >
          {AnimalIcon ? (
            <AnimalIcon size={18} color={iconColor} strokeWidth={1.5} />
          ) : (
            <span
              className="font-mono text-2xs font-semibold leading-none"
              style={{ color: iconColor }}
            >
              {initials}
            </span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent>{tooltipText}</TooltipContent>
    </Tooltip>
  );
}

function agentTooltipName(presence: AgentParticipant['presence']): string {
  const iconName = AGENT_DISPLAY_NAME[presence.icon];
  return presence.displayName || iconName || t`Agent`;
}

export const WRITING_PULSE_MIN_MS = 600;

function useWritingPulse(mode: AgentPresenceEntry['mode']): boolean {
  const [held, setHeld] = useState(mode === 'writing');
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (mode === 'writing') {
      if (clearTimerRef.current !== null) {
        clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }
      setHeld(true);
      return;
    }
    if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current);
    clearTimerRef.current = setTimeout(() => {
      clearTimerRef.current = null;
      setHeld(false);
    }, WRITING_PULSE_MIN_MS);
    return () => {
      if (clearTimerRef.current !== null) {
        clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }
    };
  }, [mode]);

  return held;
}

function AgentAvatar({
  participant,
  crossDoc,
  scoped,
  onClickAgent,
}: {
  participant: AgentParticipant;
  crossDoc: boolean;
  scoped: boolean;
  onClickAgent: (connectionId: string, targetDoc: string | null) => void;
}) {
  const { t } = useLingui();
  const { activeDocName } = useDocumentContext();
  const { presence, agentId } = participant;
  const tooltipName = agentTooltipName(presence);
  const heldWriting = useWritingPulse(presence.mode);
  const writing = !crossDoc && heldWriting;

  const realCurrentDoc =
    presence.currentDoc && !isPresenceSentinelDocName(presence.currentDoc)
      ? presence.currentDoc
      : null;

  const interactive = activeDocName !== null || realCurrentDoc !== null;

  const sharedClasses = [
    'inline-flex size-7 shrink-0 items-center justify-center rounded-full ring-2',
    interactive ? 'cursor-pointer' : 'cursor-default opacity-50',
    scoped ? 'ring-primary ring-offset-2 ring-offset-background' : 'ring-background',
    writing && !scoped ? 'ring-primary/40 animate-pulse' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const dataAttrs = {
    'data-presence-badge': 'agent',
    'data-presence-mode': presence.mode,
    'data-presence-crossdoc': crossDoc ? 'true' : undefined,
    'data-presence-scoped': scoped ? 'true' : undefined,
    'data-presence-inert': interactive ? undefined : 'true',
  };

  const ariaLabel =
    crossDoc && realCurrentDoc
      ? t`Open activity panel for ${tooltipName}, editing ${realCurrentDoc}`
      : t`Open activity panel for ${tooltipName}`;

  const avatar = interactive ? (
    <button
      type="button"
      {...dataAttrs}
      aria-label={ariaLabel}
      className={sharedClasses}
      style={{ backgroundColor: presence.color }}
      onClick={() => onClickAgent(agentId, realCurrentDoc)}
    >
      {}
      <AgentIcon icon={presence.icon} width={16} height={16} className="text-white" aria-hidden />
    </button>
  ) : (
    <div
      {...dataAttrs}
      role="img"
      aria-label={tooltipName}
      className={sharedClasses}
      style={{ backgroundColor: presence.color }}
    >
      <AgentIcon icon={presence.icon} width={16} height={16} className="text-white" aria-hidden />
    </div>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{avatar}</TooltipTrigger>
      <TooltipContent className="flex flex-col gap-0.5">
        <span className="font-medium">{tooltipName}</span>
        {crossDoc && realCurrentDoc ? (
          <span className="text-xs text-muted-foreground">
            <Trans>editing [[{realCurrentDoc}]]</Trans>
          </span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

function OverflowChip({
  count,
  remainder,
  crossDoc,
  scopedAgentId,
  onClickAgent,
}: {
  count: number;
  remainder: Participant[];
  crossDoc: boolean;
  scopedAgentId: string | null;
  onClickAgent: (connectionId: string, targetDoc: string | null) => void;
}) {
  const overflowLabel = crossDoc
    ? plural(count, {
        one: '# more cross-doc participant',
        other: '# more cross-doc participants',
      })
    : plural(count, { one: '# more participant', other: '# more participants' });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="presence-overflow"
          data-presence-crossdoc={crossDoc ? 'true' : undefined}
          className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-muted font-medium text-muted-foreground text-xs ring-2 ring-background hover:bg-muted/80"
          aria-label={overflowLabel}
        >
          +{count}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto max-w-xs p-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {remainder.map((p) => {
            if (p.kind === 'human') {
              return (
                <HumanAvatar key={p.clientId} user={p.user} mode={p.mode} tabCount={p.tabCount} />
              );
            }
            return (
              <AgentAvatar
                key={p.agentId}
                participant={p}
                crossDoc={crossDoc}
                scoped={scopedAgentId === p.agentId}
                onClickAgent={onClickAgent}
              />
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function renderParticipant(
  p: Participant,
  onClickAgent: (connectionId: string, targetDoc: string | null) => void,
  crossDoc: boolean,
  scopedAgentId: string | null,
) {
  if (p.kind === 'human') {
    return <HumanAvatar key={p.clientId} user={p.user} mode={p.mode} tabCount={p.tabCount} />;
  }
  return (
    <AgentAvatar
      key={p.agentId}
      participant={p}
      crossDoc={crossDoc}
      scoped={scopedAgentId === p.agentId}
      onClickAgent={onClickAgent}
    />
  );
}

export function PresenceBar() {
  const {
    activeProvider,
    activeDocName,
    systemProvider,
    openActivityPanel,
    docPanelMode,
    docPanelAgentId,
  } = useDocumentContext();
  const { current, crossDoc } = usePresence(activeProvider, systemProvider, activeDocName);
  const syncStatus = useSyncStatus(activeProvider);
  useSyncToasts(syncStatus, activeDocName);

  if (current.length === 0 && crossDoc.length === 0) return null;

  const currentPrimary = current.slice(0, M_CURRENT_PRIMARY);
  const currentRemainder = current.slice(M_CURRENT_PRIMARY);
  const crossDocPrimary = crossDoc.slice(0, K_CROSSDOC_PRIMARY);
  const crossDocRemainder = crossDoc.slice(K_CROSSDOC_PRIMARY);

  const onClickAgent = openActivityPanel;
  const scopedAgentId = docPanelMode === 'agent' ? docPanelAgentId : null;

  return (
    <div data-slot="presence-bar" className="flex items-center px-1 py-1.5">
      <div className="flex items-center gap-1.5" data-presence-section="current">
        {currentPrimary.map((p) => renderParticipant(p, onClickAgent, false, scopedAgentId))}
        {currentRemainder.length > 0 ? (
          <OverflowChip
            count={currentRemainder.length}
            remainder={currentRemainder}
            crossDoc={false}
            scopedAgentId={scopedAgentId}
            onClickAgent={onClickAgent}
          />
        ) : null}
      </div>

      {crossDoc.length > 0 ? (
        <div className="ml-1.5 flex items-center gap-1.5" data-presence-section="crossdoc">
          {crossDocPrimary.map((p) => renderParticipant(p, onClickAgent, true, scopedAgentId))}
          {crossDocRemainder.length > 0 ? (
            <OverflowChip
              count={crossDocRemainder.length}
              remainder={crossDocRemainder}
              crossDoc={true}
              scopedAgentId={scopedAgentId}
              onClickAgent={onClickAgent}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
