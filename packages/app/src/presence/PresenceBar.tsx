// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — file uses raw <button>/<input>/<textarea> awaiting shadcn migration; tracked at https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-raw-html-interactive-elementgrit
import {
  type AgentPresenceEntry,
  computeInitials,
  deriveIconColor,
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

/**
 * Primary-avatar limits. M = current-doc, K = cross-doc; each section
 * applies overflow independently so a large cross-doc cohort doesn't
 * push the current-doc primaries into the overflow popover.
 */
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

/**
 * The set of animal-name strings that map to a Lucide icon in the avatar.
 * Exported so unit tests can enumerate the gating contract without depending
 * on the icon component identities themselves.
 */
export const ANIMAL_ICON_NAMES = Object.freeze(Object.keys(ANIMAL_ICON_MAP));

/**
 * Decide whether the avatar should render an animal icon or initials.
 *
 * Two-step rule:
 *   1. If `principalId` is a non-empty string, the user has a server-resolved
 *      git-config principal — render `initials`. The principalId presence is
 *      the discriminator that prevents a real user named "John Bird" from
 *      rendering a Bird icon.
 *   2. Otherwise (synthesized user or pre-resolved boot fallback), look up
 *      the second word of the random `Adjective Animal` fallback name — if
 *      it matches an animal-icon key, render that icon; otherwise fall back
 *      to initials.
 *
 * Cross-file contract: step 1 holds only because the awareness publish site
 * in `TiptapEditor.tsx` omits `principalId` for synthesized users. If that
 * contract changes, gate on `user.source` instead of `user.principalId`.
 *
 * Pure function — exported for unit testing.
 */
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
  // The Tooltip is wired via Radix's `aria-describedby`, which only fires on
  // hover/focus — a screen-reader user navigating linearly past the avatar
  // would otherwise never hear the tab count, missing the central UX signal
  // of multi-tab dedupe. Promote the count into the avatar's accessible name
  // so it's announced unconditionally when N > 1.
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

/**
 * Friendly display name for an agent. Prefers the explicit displayName
 * (typically the MCP `clientInfo.name`) falling back to the icon-derived
 * name for well-known brands, finally to displayName.
 */
function agentTooltipName(presence: AgentParticipant['presence']): string {
  const iconName = AGENT_DISPLAY_NAME[presence.icon];
  return presence.displayName || iconName || t`Agent`;
}

/**
 * Minimum visible duration of the `writing` pulse in ms. The server flips
 * `setPresence(mode:'writing')` → `touchMode('idle')` around each HTTP write,
 * and `applyAgentMarkdownWrite` typically completes in 20-50ms for small
 * edits. Without a floor, the `animate-pulse` CSS class is removed before
 * its 2s keyframe even starts — the ring change is subperceptual.
 *
 * 600ms gives the pulse at least one visible cycle on the 2s animation
 * without feeling laggy. Successive writes re-trigger and extend the
 * window (via the effect's freshness tracking), so under sustained write
 * activity the ring stays lit continuously.
 */
export const WRITING_PULSE_MIN_MS = 600;

/**
 * Hold the writing-pulse visual for at least `WRITING_PULSE_MIN_MS` after
 * the server reports `mode === 'writing'`, even if it flips back to `'idle'`
 * sooner. Does NOT extend past the base `mode === 'writing'` duration — a
 * genuinely long write keeps pulsing as long as the server says so.
 *
 * Returns `true` iff the avatar should render with the pulse treatment.
 *
 * Testing note: the setTimeout + ref pattern is the idiomatic "minimum
 * display duration".
 */
function useWritingPulse(mode: AgentPresenceEntry['mode']): boolean {
  const [held, setHeld] = useState(mode === 'writing');
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (mode === 'writing') {
      // Cancel any pending "turn off" timer and lock held=true. This is
      // the "every writing tick re-arms the floor" behavior that lets
      // bursts of rapid writes keep the pulse on continuously.
      if (clearTimerRef.current !== null) {
        clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }
      setHeld(true);
      return;
    }
    // mode === 'idle' — schedule the pulse to turn off WRITING_PULSE_MIN_MS
    // from now. If a new writing arrives before the timer fires, the `if`
    // branch above cancels and re-arms. If the component unmounts, the
    // cleanup clears the timer.
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
  /** `true` when the DocPanel is currently showing this agent's Activity view. */
  scoped: boolean;
  /**
   * Handler invoked when the avatar is clicked. Receives the agent's
   * connectionId (the presence map key — the `agent-<raw>` form).
   *
   * Every agent avatar is a click target that opens the Activity Panel
   * keyed to this agent. The panel's filename-click affordance is the
   * cross-doc nav-on-avatar-click UX (one more click than a direct nav,
   * but much richer info).
   *
   * Second arg is the agent's sentinel-filtered `currentDoc` — consumed
   * only when no doc is selected, to navigate-then-open (the panel can't
   * mount without an active doc). Null for sentinel-only agents.
   */
  onClickAgent: (connectionId: string, targetDoc: string | null) => void;
}) {
  const { t } = useLingui();
  const { activeDocName } = useDocumentContext();
  const { presence, agentId } = participant;
  const tooltipName = agentTooltipName(presence);
  const heldWriting = useWritingPulse(presence.mode);
  // Writing pulse only for current-doc agents — a pulsing avatar in the
  // cross-doc bucket would signal "writing here" when the agent is
  // actually writing elsewhere. Precedent #20 also bans pulsing on
  // touch targets.
  const writing = !crossDoc && heldWriting;

  // Sentinel currentDoc values (e.g. `(connected)` from the keepalive WS
  // bootstrap in `mcp-mount.ts`) are non-null so the entry survives the
  // client-side filter, but they don't represent a real document.
  // Match the sentinel set exactly — `isSafeDocName` (api-extension.ts)
  // permits `(` in real docNames (e.g. `(WIP) draft`, `(2026-05-13) standup`),
  // so a leading-`(` heuristic would over-suppress the "editing X" copy
  // for legitimate parenthesised filenames.
  const realCurrentDoc =
    presence.currentDoc && presence.currentDoc !== '(connected)' ? presence.currentDoc : null;

  // The click opens the Activity Panel in the current doc's panel, or — when
  // no doc is selected — navigates to the agent's doc first (the panel can't
  // mount without an active doc). A sentinel-only agent (no real doc) in the
  // no-doc state has neither target, so the click would be a silent no-op:
  // render it inert (dimmed, non-button) rather than offer a dead affordance.
  const interactive = activeDocName !== null || realCurrentDoc !== null;

  // Scoped ring communicates "this avatar's Activity view is currently open."
  // Takes precedence over the writing-pulse ring so the signal is stable
  // even while the agent is actively writing.
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
      {/* Decorative: the wrapper's aria-label names the agent. The brand SVGs
          carry their own role="img" + <title>, so leaving the icon exposed
          double-announces ("Claude, Claude icon"). */}
      <AgentIcon icon={presence.icon} width={16} height={16} className="text-white" aria-hidden />
    </button>
  ) : (
    // Inert: connected-but-idle agent with no doc to navigate to. Non-button
    // so there's no false click target; the tooltip still names the agent.
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
          // Descriptive text only — click affordance is on the avatar itself.
          // Keeping the wiki-link-shaped label so mouse users still see the
          // familiar visual cue, but note it is no longer a nav target.
          // Suppressed when currentDoc is a sentinel (e.g. `(connected)` from
          // the keepalive bootstrap) — the agent isn't editing anything yet.
          <span className="text-xs text-muted-foreground">
            <Trans>editing [[{realCurrentDoc}]]</Trans>
          </span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * +N overflow chip backed by a shadcn Popover. Renders the remainder avatars
 * (compact inline) when opened. Keyboard navigation inherited from radix.
 */
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

  // Skip the wrapper entirely — its padding + the header's gap would
  // otherwise leave dead space when there are no participants.
  if (current.length === 0 && crossDoc.length === 0) return null;

  const currentPrimary = current.slice(0, M_CURRENT_PRIMARY);
  const currentRemainder = current.slice(M_CURRENT_PRIMARY);
  const crossDocPrimary = crossDoc.slice(0, K_CROSSDOC_PRIMARY);
  const crossDocRemainder = crossDoc.slice(K_CROSSDOC_PRIMARY);

  // Every agent avatar opens the Activity Panel keyed to that agent's
  // connectionId. Avatars of the currently-scoped agent get a ring
  // highlight so the user sees which session the DocPanel is showing.
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
