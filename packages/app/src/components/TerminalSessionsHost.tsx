import type { TerminalCli } from '@inkeep/open-knowledge-core';
import type { ThreadInfo, ThreadStatus } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { useLingui } from '@lingui/react/macro';
import { Loader2, SquareTerminalIcon } from 'lucide-react';
import {
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { RegisteredAgentIcon } from '@/components/acp/RegisteredAgentIcon';
import { ArchivedThreadChooser, ThreadHistoryMenu } from '@/components/acp/ThreadHistoryMenu';
import { TabsContent } from '@/components/ui/tabs';
import { isInAppAgentEnabled } from '@/lib/acp/agent-visibility';
import { useEnabledOverrides } from '@/lib/acp/enabled-agents';
import { launchAgentThread } from '@/lib/acp/launch-agent-thread';
import { enabledTerminalClis, resolveLauncherSelection } from '@/lib/acp/launcher-selection';
import {
  getDefaultRegisteredAgent,
  pickEffectiveDefaultAgent,
  type RegisteredAgent,
  registerAgent,
  useDefaultRegisteredAgent,
  useRegisteredAgents,
} from '@/lib/acp/registered-agents';
import {
  getAgentThreadClient,
  useAgentThreadConnection,
  useArchivedAgentThreads,
  useOpenAgentThreadTabs,
} from '@/lib/acp/thread-client';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import {
  type DockSessionOrder,
  readDockSessionOrder,
  readWebDockSessionOrder,
  writeDockSessionOrder,
} from '@/lib/dock-session-persistence';
import { subscribeLocalMenuAction } from '@/lib/local-menu-action-bus';
import type { NewSessionChoice } from '@/lib/new-session-choice';
import type { TerminalDockPosition } from '@/lib/terminal-dock-store';
import {
  getInitialPreferBareTerminal,
  writePreferBareTerminal,
} from '@/lib/terminal-new-tab-store';
import {
  loadStickyAgent,
  saveStickyAgent,
  terminalCliId,
  threadAgentId,
} from '@/lib/unified-agent-store';
import { openAgentSettings } from '@/lib/use-settings-route';
import { cn } from '@/lib/utils';
import { setViewMenuState } from '@/lib/view-menu-state-store';
import type { TerminalLaunchIntent, ThreadLaunchIntent } from './EditorPane';

// Lazy-loaded: ThreadView pulls the heavy agent-transcript + editor-navigation
// chain, which terminal-only sessions (and the standalone terminal window) never
// need. Deferring it keeps the host lightweight and its import graph clean — the
// same lazy-panel pattern the editor uses for ActivityModeContent + TerminalPanel.
const ThreadView = lazy(() =>
  import('@/components/acp/ThreadView').then((mod) => ({ default: mod.ThreadView })),
);

import { subscribeToActiveTerminalInput } from './handoff/terminal-input-events';
import { requestTerminalLaunch } from './handoff/terminal-launch-events';
import { TerminalGate } from './TerminalGate';
import { TerminalNewChatButton } from './TerminalNewChatButton';
import { type TerminalTabDescriptor, TerminalTabStrip } from './TerminalTabStrip';

/** A session the host keeps as a tab. Two kinds share one ordered list + one
 *  active id (the unified sessions dock). Terminal fields carry PTY state; the
 *  thread variant carries only its server-owned `threadId` (its live title +
 *  status come from the thread store). `ordinal` is a shared monotonic number the
 *  panel render sorts by (so a tab reorder never moves a panel's DOM node); the
 *  terminal positional label ("Terminal N") also reads it. `id` is a stable
 *  client identity: `terminal-session-<n>` for a terminal, the threadId itself
 *  for a thread. */
interface BaseSessionDescriptor {
  readonly id: string;
  readonly ordinal: number;
}
interface TerminalSessionDescriptor extends BaseSessionDescriptor {
  readonly kind: 'terminal';
  /** One-shot launch intent the session writes once it is live; null for a bare tab. */
  readonly launch: TerminalLaunchIntent | null;
  /** Latest OSC 0/2 title the running program set (null → positional default). */
  readonly title: string | null;
  /** User-set tab name that pins over `title`; null until renamed. */
  readonly customLabel: string | null;
  /** Surviving ptyId adopted after a renderer reload (live shell + replay); null for new tabs. */
  readonly adoptPtyId: string | null;
}
interface ThreadSessionDescriptor extends BaseSessionDescriptor {
  readonly kind: 'thread';
  /** Server-owned thread id — the reload-stable key AND the store lookup key. */
  readonly threadId: string;
}
type SessionDescriptor = TerminalSessionDescriptor | ThreadSessionDescriptor;

function makeSessionId(counter: number): string {
  return `terminal-session-${counter}`;
}

/** Attribute-escape a session id for a `querySelector` (jsdom's preload lacks `CSS.escape`). */
function escapeSelector(id: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
}

/** Move focus into a terminal session's xterm (routes keystrokes through its
 *  helper textarea). No-ops until the textarea has mounted (xterm mounts async). */
function focusTerminalSession(id: string) {
  if (id === '') return;
  document
    .querySelector<HTMLElement>(
      `[data-terminal-session="${escapeSelector(id)}"] .xterm-helper-textarea`,
    )
    ?.focus();
}

/** Move focus into a thread session's composer so the user can type immediately. */
function focusThreadSession(id: string) {
  if (id === '') return;
  document
    .querySelector<HTMLElement>(
      `[data-session-id="${escapeSelector(id)}"] [data-testid="agent-thread-composer"]`,
    )
    ?.focus();
}

function focusSession(session: SessionDescriptor) {
  if (session.kind === 'terminal') focusTerminalSession(session.id);
  else focusThreadSession(session.id);
}

/** True when keyboard focus currently sits inside the stable host div. */
function focusInsideHost(hostEl: HTMLElement | null): boolean {
  return hostEl?.contains(document.activeElement) ?? false;
}

/** Focus-gate for the host's capture-phase chords (⌘1–9, ⌘⇧←/→): always in the
 *  window variant (the whole window IS the terminal), in the dock only while
 *  focus sits inside the host. */
function chordTargetsHost(hostEl: HTMLElement | null, variant: 'dock' | 'window'): boolean {
  return variant === 'window' || focusInsideHost(hostEl);
}

/** Colour of a thread tab's status dot, by lifecycle. Transitional states pulse;
 *  solid amber means "blocked on you" (sign-in or a permission prompt). */
function threadStatusDotClass(status: ThreadStatus): string {
  switch (status) {
    case 'running':
      return 'bg-amber-500 animate-pulse';
    case 'installing':
    case 'spawning':
      return 'bg-sky-500 animate-pulse';
    case 'auth_required':
    case 'awaiting_permission':
      return 'bg-amber-500';
    case 'ready':
      return 'bg-emerald-500';
    case 'error':
      return 'bg-red-500';
    default:
      return 'bg-muted-foreground';
  }
}

/** The kind glyph the strip shows before a terminal tab's label. */
function terminalTabIcon(): ReactNode {
  return (
    <SquareTerminalIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
  );
}

/** The agent avatar + live status dot the strip shows before a thread tab's label. */
function threadTabIcon(info: ThreadInfo | undefined): ReactNode {
  return (
    <span className="relative inline-flex shrink-0">
      <RegisteredAgentIcon
        agentId={info?.agent.id ?? ''}
        iconUrl={info?.agent.iconUrl}
        className="size-3.5"
      />
      {info != null ? (
        <span
          className={cn(
            '-right-0.5 -bottom-0.5 absolute size-1.5 rounded-full ring-1 ring-background',
            threadStatusDotClass(info.status),
          )}
          aria-hidden="true"
        />
      ) : null}
    </span>
  );
}

interface TerminalSessionsHostProps {
  /**
   * Desktop bridge, or `null` on the web host. The host mounts unconditionally
   * now — a shell and an agent are just tabs of a different kind in one dock, and
   * agents are server-hosted, so the dock is host-agnostic. Terminal-*kind*
   * affordances (creation, PTY bodies, reload adopt) gate on the bridge exposing a
   * `terminal` surface; thread tabs work with no bridge at all.
   */
  readonly bridge: OkDesktopBridge | null;
  /**
   * Which surface hosts the sessions. `'dock'` (default) is the editor's sessions
   * dock: terminals AND agent threads, visibility-driven seeding, dock-toggle +
   * collapse controls, ⌘1–9 scoped to focus inside the host. `'window'` is the
   * standalone terminal window: terminals ONLY (no agent threads), always visible,
   * seeds its first tab on mount, the tab row doubles as the macOS title bar, no
   * dock/collapse controls, and ⌘1–9 is scope-free.
   */
  readonly variant?: 'dock' | 'window';
  /** Controlled visibility. The host reflects it and reports close-last back
   *  through {@link onVisibleChange}; it never owns it. */
  readonly visible: boolean;
  readonly onVisibleChange: (visible: boolean) => void;
  /** "Open in terminal" launch intent — each new intent opens its own terminal tab. */
  readonly launch?: TerminalLaunchIntent | null;
  /** "Start an agent" launch intent — each new intent opens its own thread tab (or
   *  the agent catalog when no concrete agent is resolvable). Dock variant only. */
  readonly threadLaunch?: ThreadLaunchIntent | null;
  /** Which CLIs are on PATH (desktop probe). The New split-button resolves its
   *  default CLI from this + the sticky pick. */
  readonly installedClis?: Partial<Record<TerminalCli, boolean>>;
  /** The DOM container the live session subtree portals into right now (bottom
   *  dock mount or right region tenant). Null only transiently before a container
   *  attaches. */
  readonly container: HTMLElement | null;
  /** Whether the dock is actually on screen — drives focus in/out. */
  readonly isShowing: boolean;
  /** Return focus to the editor when the dock hides or the last tab closes. */
  readonly onRequestEditorFocus: () => void;
  /** Current dock position — passed to the strip's dock-toggle + collapse controls. */
  readonly dockPosition?: TerminalDockPosition;
  /** Flip the dock between bottom and right. Dock variant only. */
  readonly onToggleDock?: () => void;
  /** Reports whether ANY session (terminal or thread) is open, so the placement
   *  owner (EditorArea via EditorPane) can render the dock column/shell. */
  readonly onHasSessionsChange?: (hasSessions: boolean) => void;
  /** Reports whether the ACTIVE tab is an AI-CLI session (was launched with a
   *  `cli`, e.g. a "New chat" / "Open with AI" tab) rather than a bare shell.
   *  The ⌘J selection-send reads this to decide inject-into-running-CLI vs
   *  launch-a-new-CLI (a raw prompt typed into a bare shell mangles). Proxy: the
   *  session's launch descriptor — a bare shell the user manually `claude`'d into
   *  reads as non-CLI, which is fine (it just starts a fresh CLI tab). */
  readonly onActiveSessionCliChange?: (isCli: boolean) => void;
}

/**
 * Owns the unified session collection (terminals + agent threads) and the single
 * stable host div. Mounted ONCE at a stable position ABOVE the editor's resizable
 * panel group so a dock change cannot remount it — live shells, scrollback,
 * transcripts, and tabs survive the move. The sessions render into the host div
 * via a portal whose target never changes; the host div is appended into whichever
 * {@link container} is active (bottom dock ↔ right region).
 *
 * The tab strip + panels dispatch by `kind`: reorder / activate / rename / close
 * are strip-uniform, their behavior kind-specific. Terminals are host-owned (PTY
 * lifecycle); threads mirror the server-authoritative thread store (the host owns
 * only the dock/tab model — order, active, visibility — never thread lifecycle).
 */
export function TerminalSessionsHost({
  bridge,
  variant = 'dock',
  visible,
  onVisibleChange,
  launch = null,
  threadLaunch = null,
  installedClis,
  container,
  isShowing,
  onRequestEditorFocus,
  dockPosition,
  onToggleDock,
  onHasSessionsChange,
  onActiveSessionCliChange,
}: TerminalSessionsHostProps) {
  const { t } = useLingui();

  // Terminal affordances need a bridge that actually exposes the `terminal`
  // surface (a session-only bridge, some E2E hosts, has none). Thread hosting is
  // the dock variant only (the standalone terminal window is shells-only).
  const terminalAvailable = bridge?.terminal != null;
  const hostThreads = variant === 'dock';

  // The single stable host div for the session subtree. Created once via a
  // useState lazy initializer (never a render-time ref write — React Compiler
  // forbids touching refs during render) and never recreated.
  const [hostEl] = useState<HTMLDivElement | null>(() => {
    if (typeof document === 'undefined') return null;
    const el = document.createElement('div');
    el.className = 'flex min-h-0 flex-1 flex-col overflow-hidden';
    return el;
  });

  // Append the stable host div into the active container. A constant portal target
  // plus DOM relocation means no remount on a dock move. useLayoutEffect runs
  // before the focus passive effects below, so the host is attached before a
  // focus-on-reveal.
  useLayoutEffect(() => {
    if (hostEl == null || container == null) return;
    if (hostEl.parentElement !== container) container.appendChild(hostEl);
  }, [hostEl, container]);

  // A capable desktop bridge can report the PTY sessions that survived a renderer
  // reload, so the host rehydrates them on mount instead of starting fresh. When
  // it can, the synchronous terminal seed below stands down. Web + session-only
  // bridges keep the synchronous cold-start (no terminals to rehydrate).
  const canRehydrate = typeof bridge?.terminal?.list === 'function';

  // Seed the first terminal synchronously only on a terminal surface with no
  // rehydrate capability — web + session-only bridges never seed a terminal.
  const coldSeedTerminal = !canRehydrate && terminalAvailable && visible;

  // Persisted reload order (unified keys: ptyIds + threadIds) + active key. Web
  // reads it synchronously from localStorage here; desktop reads it async from
  // main in the rehydration effect (which sets the refs before seeding). Restored
  // sessions are placed by this order; sessions created after mount append. Skipped
  // for a cold-seeded surface (a fresh terminal-only start with no rehydrate) — it
  // has no reload to restore, and its terminal persist goes through the bridge, not
  // localStorage — so a stale localStorage arrangement never yanks a fresh seed.
  const [webReloadOrder] = useState<DockSessionOrder | null>(() => {
    if (canRehydrate || !hostThreads || coldSeedTerminal) return null;
    // Only the web dock persists to localStorage; skip for the window variant.
    return typeof bridge?.terminal?.getDockState === 'function' ? null : readWebDockSessionOrder();
  });
  const reloadOrderRef = useRef<readonly string[]>(webReloadOrder?.order ?? []);
  // Active key still awaiting a matching session (reload restore). Cleared once
  // matched, when the user takes over the active tab, or when the reload settles —
  // so it never blocks nor steals live activation.
  const pendingActiveKeyRef = useRef<string | null>(webReloadOrder?.activeKey ?? null);
  const [sessions, setSessions] = useState<readonly SessionDescriptor[]>(() =>
    coldSeedTerminal
      ? [
          {
            kind: 'terminal',
            id: makeSessionId(1),
            launch,
            title: null,
            customLabel: null,
            ordinal: 1,
            adoptPtyId: null,
          },
        ]
      : [],
  );
  const [activeSessionId, setActiveSessionId] = useState(() =>
    coldSeedTerminal ? makeSessionId(1) : '',
  );
  const [rehydrationSettled, setRehydrationSettled] = useState(!canRehydrate);
  const rehydratedRef = useRef(false);
  const activeSessionIdRef = useRef(activeSessionId);
  const sessionsRef = useRef(sessions);
  // Monotonic, never reused — shared by both kinds so a closed tab's id/ordinal
  // can't collide with a later one.
  const sessionCounterRef = useRef(coldSeedTerminal ? 1 : 0);
  const lastHandledLaunchNonceRef = useRef<number | null>(
    coldSeedTerminal && launch ? launch.nonce : null,
  );
  const lastHandledThreadNonceRef = useRef<number | null>(null);
  const prevVisibleRef = useRef(variant === 'window' ? false : visible);
  const ptyIdBySessionRef = useRef(new Map<string, string>());
  const stripLaunchNonceRef = useRef(0);

  // Live agent-thread tabs (server-authoritative). Always subscribed (the hook is
  // cheap + the store is empty until a URL is bound), reconciled into thread
  // descriptors only in the dock variant.
  const openThreadTabs = useOpenAgentThreadTabs();
  const archivedThreads = useArchivedAgentThreads();
  // WS status for the agent-thread channel — drives a "reconnecting" banner shown
  // only above an active thread's transcript (never while a terminal is focused).
  const threadConnection = useAgentThreadConnection();
  const threadConnectionDown = threadConnection === 'connecting' || threadConnection === 'closed';
  const registeredAgents = useRegisteredAgents();
  const enabledOverrides = useEnabledOverrides();
  // Only the in-app agents the user enabled in Configure agents appear in the
  // New-chat picker (registered agents default to enabled).
  const enabledRegisteredAgents = registeredAgents.filter((agent) =>
    isInAppAgentEnabled(enabledOverrides, agent.source, agent.id, true, agent.supported),
  );
  const defaultRegisteredAgent = useDefaultRegisteredAgent();
  // The primary "+" launch must honor Configure agents too: resolve it against
  // the enabled agents only, and lead with the effective default (the registered
  // default when still enabled, else the first enabled one). Otherwise disabling
  // the sticky/default agent would hide it from the picker yet still launch it.
  const effectiveDefaultAgent = pickEffectiveDefaultAgent(
    enabledRegisteredAgents,
    defaultRegisteredAgent,
  );
  const liveThreadCount = openThreadTabs.filter((info) => info.archived !== true).length;
  const threadInfoById = new Map(openThreadTabs.map((info) => [info.threadId, info]));

  // Reopen an archived conversation as a tab (history menu / empty-dock chooser).
  // The store adds it to the open set; the reconcile + activation effects bring it
  // in as the active tab.
  function openArchivedThread(threadId: string) {
    getAgentThreadClient().openArchivedThread(threadId);
  }

  /** Persist the current unified dock order + active key (reload-durable). Reads
   *  the post-commit refs so it is correct when called from a ptyId callback. */
  function persistDockOrderNow() {
    if (!hostThreads) return; // the window variant IS the surface — nothing to restore into
    const ptyMap = ptyIdBySessionRef.current;
    const order = sessionsRef.current
      .map((session) => computePersistKey(session, ptyMap))
      .filter((key): key is string => key != null);
    const active = sessionsRef.current.find((s) => s.id === activeSessionIdRef.current);
    writeDockSessionOrder(bridge, {
      order,
      activeKey: active != null ? computePersistKey(active, ptyMap) : null,
    });
  }

  function setSessionPtyId(id: string, ptyId: string | null) {
    if (ptyId === null) {
      ptyIdBySessionRef.current.delete(id);
      return;
    }
    ptyIdBySessionRef.current.set(id, ptyId);
    const session = sessionsRef.current.find((s) => s.id === id);
    if (session != null && session.kind === 'terminal') {
      bridge?.terminal?.setMeta?.(ptyId, {
        ordinal: session.ordinal,
        customLabel: session.customLabel,
      });
    }
    // A terminal's persist key only exists once its PTY does — refresh the
    // persisted order so a reload can restore this tab in place.
    persistDockOrderNow();
  }

  function openSession(launchForSession: TerminalLaunchIntent | null) {
    // Opening a tab is the user taking over the active slot — a lingering reload
    // restore must not later yank the active tab back.
    pendingActiveKeyRef.current = null;
    sessionCounterRef.current += 1;
    const id = makeSessionId(sessionCounterRef.current);
    setSessions((prev) => [
      ...prev,
      {
        kind: 'terminal',
        id,
        launch: launchForSession,
        title: null,
        customLabel: null,
        ordinal: sessionCounterRef.current,
        adoptPtyId: null,
      },
    ]);
    setActiveSessionId(id);
  }

  // Sticky pick mirror (raw id from the shared Ask-AI store) so the New split
  // button's primary reflects the last pick across agents/CLIs/bare and updates
  // reactively when the user switches it from the dropdown.
  const [stickyAgentId, setStickyAgentId] = useState<string | null>(() => loadStickyAgent());
  const [preferBareTerminal, setPreferBareTerminal] = useState(() =>
    getInitialPreferBareTerminal(),
  );

  // The shared, enablement-aware selection — the SAME `resolveLauncherSelection`
  // the Ask + Create composers use, so a disabled agent / CLI is never what the
  // dock primary launches (the old `resolveNewSessionChoice` forced a Claude CLI
  // fallback that ignored the toggles). The dock offers no Desktop rows and falls
  // back to a bare terminal, so it only ever yields agent / cli / terminal.
  const selection = resolveLauncherSelection({
    sticky: stickyAgentId,
    effectiveThreadAgent: effectiveDefaultAgent,
    enabledClis: enabledTerminalClis(enabledOverrides, installedClis ?? {}),
    enabledDesktopTargets: [],
    installedClis: installedClis ?? {},
    terminalAvailable,
    threadsAvailable: hostThreads,
    desktopSelectable: false,
    preferBareTerminal,
    bareTerminalFallback: true,
  });
  const newSessionChoice: NewSessionChoice =
    selection.kind === 'thread'
      ? { kind: 'agent', agent: selection.agent }
      : selection.kind === 'cli'
        ? { kind: 'cli', cli: selection.cli }
        : selection.kind === 'terminal'
          ? { kind: 'terminal' }
          : // 'none' (thread-only surface, nothing enabled) → primary opens Settings.
            { kind: 'agent', agent: null };

  // Tab-strip New-chat primary: open a promptless terminal session running `cli`.
  function openNewChatSession(cli: TerminalCli) {
    stripLaunchNonceRef.current += 1;
    openSession({ prompt: null, cli, nonce: stripLaunchNonceRef.current });
  }

  // Primary click: launch the current sticky pick across all three families.
  function launchSelectedNewTab() {
    if (newSessionChoice.kind === 'terminal') openSession(null);
    else if (newSessionChoice.kind === 'cli') openNewChatSession(newSessionChoice.cli);
    else if (newSessionChoice.kind === 'agent' && newSessionChoice.agent != null)
      launchAgentThread(
        { source: newSessionChoice.agent.source, id: newSessionChoice.agent.id },
        null,
        null,
        null,
      );
    else openAgentSettings();
  }

  // Seed the dock when it opens empty (⌘J / edge reveal with nothing latched) by
  // repeating the choice shown on the New-session primary button — EXCEPT the
  // neutral `choose` (no default agent). A passive reveal must NOT auto-open the
  // agent catalog: revealing an empty dock just shows it empty; starting an
  // in-app agent stays an explicit New-button click.
  function seedOnReveal() {
    if (newSessionChoice.kind === 'terminal') openSession(null);
    else if (newSessionChoice.kind === 'cli') openNewChatSession(newSessionChoice.cli);
    else if (newSessionChoice.kind === 'agent' && newSessionChoice.agent != null)
      launchAgentThread(
        { source: newSessionChoice.agent.source, id: newSessionChoice.agent.id },
        null,
        null,
        null,
      );
    // `choose` → reveal the empty dock without auto-opening the catalog.
  }

  // Dropdown CLI pick: clear the bare-terminal preference, persist `cli`, open it.
  function pickNewChatCli(cli: TerminalCli) {
    setPreferBareTerminal(false);
    writePreferBareTerminal(false);
    const id = terminalCliId(cli);
    setStickyAgentId(id);
    saveStickyAgent(id);
    openNewChatSession(cli);
  }

  // Dropdown "Terminal" pick: persist the bare-shell preference, open a bare shell.
  function pickNewChatTerminal() {
    setPreferBareTerminal(true);
    writePreferBareTerminal(true);
    openSession(null);
  }

  // Dropdown agent pick: register it (making it the default), persist it as the
  // sticky pick so the primary repeats it, clear the bare-terminal flag, and start
  // a thread. Mirrors the catalog pick's "the agent you chose last is your agent".
  function pickNewChatAgent(agent: RegisteredAgent) {
    registerAgent(agent);
    setPreferBareTerminal(false);
    writePreferBareTerminal(false);
    const id = threadAgentId(agent);
    setStickyAgentId(id);
    saveStickyAgent(id);
    launchAgentThread({ source: agent.source, id: agent.id }, null, null, null);
  }

  // Record a terminal session's OSC 0/2 title. Same same-reference bailout as the
  // rename below so an unchanged value causes no re-render.
  function setSessionTitle(id: string, title: string) {
    const next = title.trim() === '' ? null : title.trim();
    setSessions((prev) => {
      if (
        !prev.some(
          (session) => session.id === id && session.kind === 'terminal' && session.title !== next,
        )
      )
        return prev;
      return prev.map((session) =>
        session.id === id && session.kind === 'terminal' ? { ...session, title: next } : session,
      );
    });
  }

  // Commit a manual tab rename — kind-dispatched. A terminal stores a custom label
  // (empty clears it back to the OSC / positional default) that persists to main; a
  // thread routes the rename to the server (blank is a no-op there).
  function renameSession(id: string, label: string) {
    const session = sessionsRef.current.find((s) => s.id === id);
    if (session == null) return;
    if (session.kind === 'thread') {
      getAgentThreadClient().renameThread(session.threadId, label);
      return;
    }
    const next = label.trim() === '' ? null : label.trim();
    setSessions((prev) => {
      if (!prev.some((s) => s.id === id && s.kind === 'terminal' && s.customLabel !== next))
        return prev;
      return prev.map((s) =>
        s.id === id && s.kind === 'terminal' ? { ...s, customLabel: next } : s,
      );
    });
    const ptyId = ptyIdBySessionRef.current.get(id);
    if (ptyId != null) bridge?.terminal?.setMeta?.(ptyId, { customLabel: next });
  }

  // Display label precedence, shared by the tab list and the reorder announcer.
  function sessionLabel(session: SessionDescriptor): string {
    if (session.kind === 'terminal') {
      return session.customLabel ?? session.title ?? t`Terminal ${session.ordinal}`;
    }
    return threadInfoById.get(session.threadId)?.title ?? t`Agent`;
  }

  const dragActiveRef = useRef(false);
  const announcerRef = useRef<HTMLSpanElement>(null);
  const announceTimerRef = useRef<number | null>(null);

  // Apply a reorder from a desired visual order of session ids — the single spine
  // for both the pointer drag and the keyboard path. A length or unknown-id
  // mismatch refuses the whole reorder; an unchanged order keeps the same array
  // reference (render bailout).
  function reorderSessions(newOrderIds: readonly string[]) {
    setSessions((prev) => {
      if (newOrderIds.length !== prev.length) return prev;
      const byId = new Map(prev.map((session) => [session.id, session]));
      const next: SessionDescriptor[] = [];
      for (const id of newOrderIds) {
        const session = byId.get(id);
        if (session == null) return prev;
        next.push(session);
      }
      if (next.every((session, index) => session === prev[index])) return prev;
      return next;
    });
    // Persist the terminal-only display order to main (ptyIds in visual order) so a
    // reorder survives a renderer reload — keeps `list()` self-consistent — and the
    // unified cross-kind order for the mixed strip.
    const orderedPtyIds = newOrderIds
      .map((id) => ptyIdBySessionRef.current.get(id))
      .filter((ptyId): ptyId is string => ptyId != null);
    if (orderedPtyIds.length > 0) bridge?.terminal?.setOrder?.(orderedPtyIds);
  }

  function moveActiveSession(
    direction: -1 | 1,
  ): { label: string; position: number; total: number } | null {
    const current = sessionsRef.current;
    const from = current.findIndex((session) => session.id === activeSessionIdRef.current);
    if (from < 0) return null;
    const to = from + direction;
    if (to < 0 || to >= current.length) return null;
    const ids = current.map((session) => session.id);
    const [movedId] = ids.splice(from, 1);
    ids.splice(to, 0, movedId);
    reorderSessions(ids);
    return { label: sessionLabel(current[from]), position: to + 1, total: current.length };
  }
  const moveActiveSessionRef = useRef(moveActiveSession);
  const openSessionRef = useRef(openSession);
  const seedOnRevealRef = useRef(seedOnReveal);

  // Close a tab — kind-dispatched. A terminal is removed from the list (its panel
  // unmounts, killing the PTY); a thread is archived server-side (discarded if it
  // never received a message), and the reconcile effect drops its descriptor when
  // the store does. The active-neighbor activation + close-last hide are uniform.
  function closeSession(id: string) {
    const current = sessionsRef.current;
    const index = current.findIndex((session) => session.id === id);
    if (index === -1) return;
    const session = current[index];
    const isLast = current.length === 1;
    // The user is driving the active tab — stop any lingering reload restore.
    pendingActiveKeyRef.current = null;
    if (id === activeSessionIdRef.current) {
      const neighbor = current[index - 1] ?? current[index + 1];
      const neighborId = neighbor?.id ?? '';
      setActiveSessionId(neighborId);
      if (neighbor != null) queueMicrotask(() => focusSession(neighbor));
    }
    if (session.kind === 'thread') {
      getAgentThreadClient().closeThread(session.threadId);
    } else {
      setSessions(current.filter((s) => s.id !== id));
    }
    if (isLast) {
      onVisibleChange(false);
      onRequestEditorFocus();
    }
  }
  const closeActiveRef = useRef(() => {});

  useEffect(() => {
    openSessionRef.current = openSession;
    seedOnRevealRef.current = seedOnReveal;
    moveActiveSessionRef.current = moveActiveSession;
    activeSessionIdRef.current = activeSessionId;
    sessionsRef.current = sessions;
    // The Terminal menu's "Kill Terminal" acts on a terminal: close the active tab
    // when it is a terminal, else the newest terminal (so it stays meaningful while
    // an agent tab is focused).
    closeActiveRef.current = () => {
      const active = sessionsRef.current.find((s) => s.id === activeSessionIdRef.current);
      if (active?.kind === 'terminal') {
        closeSession(active.id);
        return;
      }
      const lastTerminal = [...sessionsRef.current].reverse().find((s) => s.kind === 'terminal');
      if (lastTerminal != null) closeSession(lastTerminal.id);
    };
  });

  // Persist the unified dock order + active whenever the tab set or active tab
  // changes (reorder, add, remove, activate). Reads the ptyId map by ref; the
  // computation uses only listed deps + the module-pure `computePersistKey`.
  useEffect(() => {
    if (!hostThreads) return;
    const ptyMap = ptyIdBySessionRef.current;
    const order = sessions
      .map((session) => computePersistKey(session, ptyMap))
      .filter((key): key is string => key != null);
    const active = sessions.find((s) => s.id === activeSessionId);
    writeDockSessionOrder(bridge, {
      order,
      activeKey: active != null ? computePersistKey(active, ptyMap) : null,
    });
  }, [sessions, activeSessionId, hostThreads, bridge]);

  // ── Thread reconciliation (dock variant) ────────────────────────────────
  // Mirror the server-authoritative open-thread list into thread descriptors: add
  // one per newly-open thread, drop one when its thread leaves the open set. The
  // host owns only order/active; the thread store owns thread lifecycle. Restored
  // threads land in the persisted reload order; live-created ones append.
  useEffect(() => {
    if (!hostThreads) return;
    const openIds = new Set(openThreadTabs.map((info) => info.threadId));
    const current = sessionsRef.current;
    const knownThreadIds = new Set(
      current
        .filter((s): s is ThreadSessionDescriptor => s.kind === 'thread')
        .map((s) => s.threadId),
    );
    // Compute additions (with fresh ordinals) OUTSIDE setState — ref writes are
    // forbidden inside a (possibly re-invoked) updater.
    const additions: ThreadSessionDescriptor[] = [];
    for (const info of openThreadTabs) {
      if (knownThreadIds.has(info.threadId)) continue;
      sessionCounterRef.current += 1;
      additions.push({
        kind: 'thread',
        id: info.threadId,
        threadId: info.threadId,
        ordinal: sessionCounterRef.current,
      });
    }
    const removedAny = current.some((s) => s.kind === 'thread' && !openIds.has(s.threadId));
    if (additions.length === 0 && !removedAny) return;
    setSessions((prev) => {
      const kept = prev.filter((s) => s.kind !== 'thread' || openIds.has(s.threadId));
      // Dedup additions against the committed list too, so a StrictMode double-run
      // never inserts the same thread twice.
      const keptThreadIds = new Set(
        kept
          .filter((s): s is ThreadSessionDescriptor => s.kind === 'thread')
          .map((s) => s.threadId),
      );
      const fresh = additions.filter((a) => !keptThreadIds.has(a.threadId));
      const ptyMap = ptyIdBySessionRef.current;
      const next =
        fresh.length > 0
          ? placeSessionAdditions(kept, fresh, reloadOrderRef.current, (s) =>
              computePersistKey(s, ptyMap),
            )
          : kept;
      if (next.length === prev.length && next.every((s, i) => s === prev[i])) return prev;
      return next;
    });
  }, [openThreadTabs, hostThreads]);

  // Bring a newly-created thread to the front (createThread → active), and focus
  // its composer. Skipped while a reload-active restore is still pending so the
  // initial batch of restored threads does not steal the restored active tab.
  const prevOpenThreadIdsRef = useRef<readonly string[]>([]);
  useEffect(() => {
    if (!hostThreads) return;
    const ids = openThreadTabs.map((info) => info.threadId);
    const previous = prevOpenThreadIdsRef.current;
    prevOpenThreadIdsRef.current = ids;
    if (pendingActiveKeyRef.current != null) return;
    const added = ids.filter((id) => !previous.includes(id));
    const newest = added[added.length - 1];
    if (newest != null) {
      setActiveSessionId(newest);
      queueMicrotask(() => focusThreadSession(newest));
    }
  }, [openThreadTabs, hostThreads]);

  // A newly created LIVE thread reveals the dock (auto-reveal). Gated on the live
  // count INCREASING so hiding the dock is never instantly undone, and a boot-time
  // backlog of archived history never pops it.
  const prevLiveThreadCountRef = useRef(liveThreadCount);
  useEffect(() => {
    if (!hostThreads) return;
    const previous = prevLiveThreadCountRef.current;
    prevLiveThreadCountRef.current = liveThreadCount;
    if (liveThreadCount > previous && !visible) onVisibleChange(true);
  }, [liveThreadCount, visible, hostThreads, onVisibleChange]);

  // Reload-active restore + active-validity guard. Restores the persisted active
  // tab once its session exists, then keeps `activeSessionId` valid: when the
  // active session leaves (a thread archived elsewhere, a terminal closed), fall
  // back to the newest remaining tab.
  useEffect(() => {
    const pending = pendingActiveKeyRef.current;
    if (pending != null) {
      const ptyMap = ptyIdBySessionRef.current;
      const match = sessions.find((s) => computePersistKey(s, ptyMap) === pending);
      if (match != null) {
        pendingActiveKeyRef.current = null;
        setActiveSessionId(match.id);
        return;
      }
      // Still waiting for the restored active session to arrive — don't override.
      if (sessions.some((s) => s.id === activeSessionId)) return;
    }
    if (activeSessionId !== '' && sessions.some((s) => s.id === activeSessionId)) return;
    if (sessions.length === 0) {
      if (activeSessionId !== '') setActiveSessionId('');
      return;
    }
    setActiveSessionId(sessions[sessions.length - 1].id);
  }, [sessions, activeSessionId]);

  // Open/launch lifecycle: a fresh terminal launch intent opens its own tab;
  // otherwise an open-from-hidden transition seeds the dock — UNLESS a fresh thread
  // launch is being handled this cycle (the thread launch effect owns the seed
  // then, so we don't open a bare terminal alongside the agent). Defined before the
  // thread launch effect so `threadLaunchPending` reads the not-yet-handled nonce.
  useEffect(() => {
    if (!rehydrationSettled) return;
    const wasVisible = prevVisibleRef.current;
    prevVisibleRef.current = visible;

    if (launch != null && launch.nonce !== lastHandledLaunchNonceRef.current) {
      lastHandledLaunchNonceRef.current = launch.nonce;
      openSessionRef.current(launch);
      return;
    }
    const threadLaunchPending =
      hostThreads &&
      threadLaunch != null &&
      threadLaunch.nonce !== lastHandledThreadNonceRef.current;
    if (visible && !wasVisible && sessions.length === 0 && !threadLaunchPending) {
      seedOnRevealRef.current();
    }
  }, [visible, launch, threadLaunch, sessions.length, rehydrationSettled, hostThreads]);

  // "Start an agent" launch intent (dock variant): resolve the agent (concrete /
  // default-registered) and start a thread. Each new nonce opens its own thread
  // tab; the store reconcile + auto-reveal bring it to front + reveal. When no
  // agent resolves (nothing enabled yet), open Configure agents so the user can
  // enable one — the retired agent catalog's replacement.
  useEffect(() => {
    if (!hostThreads) return;
    if (threadLaunch == null || threadLaunch.nonce === lastHandledThreadNonceRef.current) return;
    lastHandledThreadNonceRef.current = threadLaunch.nonce;
    let agent: { source: 'registry' | 'custom'; id: string } | null =
      threadLaunch.agentId === ''
        ? null
        : { source: threadLaunch.agentSource, id: threadLaunch.agentId };
    if (agent === null) {
      const fallback = getDefaultRegisteredAgent();
      if (fallback !== null) agent = { source: fallback.source, id: fallback.id };
    }
    if (agent === null) {
      openAgentSettings();
      return;
    }
    launchAgentThread(agent, threadLaunch.prompt, threadLaunch.docName, threadLaunch.titleHint);
  }, [threadLaunch, hostThreads]);

  // Reload rehydration (capable bridge only): rebuild one terminal tab per PTY
  // survivor and read the persisted unified order + active key, so restored tabs
  // land in place and the active tab is restored across kinds.
  useEffect(() => {
    if (typeof bridge?.terminal?.list !== 'function') return;
    if (rehydratedRef.current) return;
    rehydratedRef.current = true;
    let cancelled = false;
    void (async () => {
      // Read the persisted unified order first so terminal survivors are placed by
      // it (and threads, arriving async, land at their persisted slots too).
      const persisted = await readDockSessionOrder(bridge).catch(() => null);
      if (!cancelled && persisted != null) {
        reloadOrderRef.current = persisted.order;
        pendingActiveKeyRef.current = persisted.activeKey;
      }
      let survivors: readonly {
        ptyId: string;
        customLabel: string | null;
        ordinal: number | null;
      }[] = [];
      try {
        survivors = (await bridge.terminal.list()) ?? [];
      } catch (err) {
        console.error('[terminal] reload session list() failed; cold-starting:', err);
        survivors = [];
      }
      if (cancelled) return;
      if (survivors.length > 0) {
        const order = reloadOrderRef.current;
        const rankOf = (ptyId: string) => {
          const i = order.indexOf(ptyId);
          return i === -1 ? Number.POSITIVE_INFINITY : i;
        };
        const recovered: TerminalSessionDescriptor[] = survivors
          .map((entry, index) => ({
            kind: 'terminal' as const,
            id: makeSessionId(index + 1),
            launch: null,
            title: null,
            customLabel: entry.customLabel ?? null,
            ordinal: entry.ordinal ?? index + 1,
            adoptPtyId: entry.ptyId,
          }))
          // Restore the persisted cross-kind order for terminals; survivors absent
          // from it (created in the reload gap, or when no unified order was
          // persisted) keep their `list()` order — which already reflects the
          // terminal-only reorder — via the stable sort's 0 tie-break.
          .sort((a, b) => {
            const ra = rankOf(a.adoptPtyId);
            const rb = rankOf(b.adoptPtyId);
            return ra === rb ? 0 : ra - rb;
          });
        sessionCounterRef.current = Math.max(recovered.length, ...recovered.map((r) => r.ordinal));
        setSessions(recovered);
      }
      setRehydrationSettled(true);
      // Bound the reload-active wait: if the restored active tab never materializes
      // (its session died), stop blocking live activation so the guard picks a
      // fallback. Threads have had CHANNEL_WAIT to arrive by now.
      window.setTimeout(() => {
        if (!cancelled) pendingActiveKeyRef.current = null;
      }, 9_000);
    })();
    return () => {
      cancelled = true;
      // Reset the run-once guard so React StrictMode's dev double-mount re-runs
      // rehydration on the second mount (see the original terminal host rationale).
      rehydratedRef.current = false;
    };
  }, [bridge]);

  // Web reload: no bridge to rehydrate, but a persisted active key may still be
  // pending — bound its wait the same way so a stale key never blocks activation.
  useEffect(() => {
    if (canRehydrate) return;
    if (pendingActiveKeyRef.current == null) return;
    const timer = window.setTimeout(() => {
      pendingActiveKeyRef.current = null;
    }, 9_000);
    return () => window.clearTimeout(timer);
  }, [canRehydrate]);

  // The editor's "Ask AI" selection affordance routes here. Live PTY → write the
  // composed prompt into the active shell (e.g. a running claude TUI); no trailing
  // newline so the user reviews/sends. No live PTY → launch a fresh Claude tab
  // pre-loaded with the same prompt (mirrors the "Open in terminal" path).
  useEffect(() => {
    if (!terminalAvailable || bridge?.terminal == null) return;
    const terminal = bridge.terminal;
    return subscribeToActiveTerminalInput((text) => {
      const activeId = activeSessionIdRef.current;
      const active = sessionsRef.current.find((s) => s.id === activeId);
      const livePtyId =
        active?.kind === 'terminal' ? ptyIdBySessionRef.current.get(active.id) : undefined;
      if (livePtyId != null) {
        terminal.input(livePtyId, text);
        queueMicrotask(() => focusTerminalSession(activeId));
      } else {
        requestTerminalLaunch(text, 'claude');
      }
    });
  }, [bridge, terminalAvailable]);

  // Terminal application-menu actions act on the tab collection.
  useEffect(() => {
    return subscribeLocalMenuAction((action) => {
      if (action === 'new-terminal') {
        if (terminalAvailable) openSessionRef.current(null);
      } else if (action === 'kill-terminal') closeActiveRef.current();
      else if (action === 'close-active-tab-or-window' && variant === 'window')
        closeActiveRef.current();
    });
  }, [variant, terminalAvailable]);

  // ⌘1–⌘9 jump straight to the Nth tab (capture phase, focus-scoped in the dock).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (!/^[1-9]$/.test(event.key)) return;
      if (!chordTargetsHost(hostEl, variant)) return;
      const target = sessionsRef.current[Number(event.key) - 1];
      if (target == null) return;
      event.preventDefault();
      event.stopPropagation();
      setActiveSessionId(target.id);
      queueMicrotask(() => focusSession(target));
    }
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [hostEl, variant]);

  // ⌘⇧← / ⌘⇧→ move the ACTIVE tab one slot (capture phase + focus-gate).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.metaKey || !event.shiftKey || event.ctrlKey || event.altKey) return;
      const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
      if (direction === 0) return;
      if (!chordTargetsHost(hostEl, variant)) return;
      if (dragActiveRef.current) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.isContentEditable) return;
      const moved = moveActiveSessionRef.current(direction);
      if (moved == null) return;
      event.preventDefault();
      event.stopPropagation();
      const activeId = activeSessionIdRef.current;
      const active = sessionsRef.current.find((s) => s.id === activeId);
      if (active != null) queueMicrotask(() => focusSession(active));
      const message = t`Moved ${moved.label} to position ${moved.position} of ${moved.total}`;
      if (announceTimerRef.current != null) window.clearTimeout(announceTimerRef.current);
      announceTimerRef.current = window.setTimeout(() => {
        announceTimerRef.current = null;
        if (announcerRef.current != null) announcerRef.current.textContent = message;
      }, 60);
    }
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      if (announceTimerRef.current != null) {
        window.clearTimeout(announceTimerRef.current);
        announceTimerRef.current = null;
      }
    };
  }, [hostEl, variant, t]);

  // Reflect terminal liveness to main so the Terminal menu's "Kill Terminal"
  // enables only while at least one TERMINAL session is live.
  useEffect(() => {
    const terminalLive = sessions.some((s) => s.kind === 'terminal');
    // Mirror into the renderer store so the Cmd+K palette can gate "Kill
    // terminal" on a live session (the bridge push below is main-only).
    setViewMenuState({ terminalLive });
    bridge?.editor.notifyViewMenuStateChanged({ terminalLive });
  }, [bridge, sessions]);

  useEffect(() => {
    onHasSessionsChange?.(sessions.length > 0);
  }, [onHasSessionsChange, sessions.length]);

  // Report whether the active tab is a CLI session (see the prop doc). Derived in
  // render so the effect fires only on actual transitions, not on every session-
  // list mutation. EditorPane's ⌘J read decides inject-vs-launch off this.
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeSessionIsCli =
    activeSession?.kind === 'terminal' && activeSession.launch?.cli != null;
  useEffect(() => {
    onActiveSessionCliChange?.(activeSessionIsCli);
  }, [onActiveSessionCliChange, activeSessionIsCli]);

  // Return focus out of the hidden dock so a keyboard user is never stranded.
  // Only acts when focus is actually inside the dock.
  //
  // Gate on `visible`, not just `isShowing`: a dock move (bottom ↔ right) keeps the
  // dock `visible` but transiently drops `isShowing` to false for one commit
  // while the destination container's callback ref attaches (`activeTerminalContainer`
  // is null until then). Without the `visible` guard, clicking the dock-toggle —
  // which lives inside this portaled host, so focus is inside it — would satisfy the
  // focus-inside check and yank focus to the editor mid-move. A genuine hide (⌘J,
  // collapse, close-last) always sets `visible` false, so focus-return still fires.
  useLayoutEffect(() => {
    if (isShowing || visible) return;
    if (!focusInsideHost(hostEl)) return;
    onRequestEditorFocus();
  }, [isShowing, visible, hostEl, onRequestEditorFocus]);

  // Focus the active session when the dock is revealed (kind-aware).
  useEffect(() => {
    if (!isShowing) return;
    const active = sessionsRef.current.find((s) => s.id === activeSessionIdRef.current);
    if (active != null) focusSession(active);
  }, [isShowing]);

  const tabDescriptors: TerminalTabDescriptor[] = sessions.map((session) => ({
    id: session.id,
    label: sessionLabel(session),
    icon:
      session.kind === 'terminal'
        ? terminalTabIcon()
        : threadTabIcon(threadInfoById.get(session.threadId)),
  }));

  // Panels render in STABLE order (by immutable ordinal), decoupled from tab order:
  // a reorder must not move a panel's DOM node (moving an xterm container fires
  // SIGWINCH; a thread panel would lose its transcript scroll).
  const panelSessions = [...sessions].sort((a, b) => a.ordinal - b.ordinal);

  const newButton = (
    <TerminalNewChatButton
      selected={newSessionChoice}
      onLaunchSelected={launchSelectedNewTab}
      showAgents={hostThreads}
      registeredAgents={enabledRegisteredAgents}
      onPickAgent={pickNewChatAgent}
      onOpenSettings={openAgentSettings}
      liveThreadCount={liveThreadCount}
      showClis={terminalAvailable}
      onPickCli={pickNewChatCli}
      onPickTerminal={pickNewChatTerminal}
      // The CLI rows are the ENABLED CLIs (the same set the selection resolver
      // reads); the selected CLI is always enabled, so no keep-guard is needed.
      visibleClis={enabledTerminalClis(enabledOverrides, installedClis ?? {})}
    />
  );

  // The conversation-history menu rides in the strip's trailing controls, just
  // left of the dock-toggle/collapse buttons — shown only with archived history to
  // return to.
  const trailingControls =
    hostThreads && archivedThreads.length > 0 ? (
      <ThreadHistoryMenu archived={archivedThreads} onOpenThread={openArchivedThread} />
    ) : null;

  // Render the strip (with the ＋ split button + a starting/empty body) whenever
  // there are sessions, or the dock is visible in the dock variant — so a visible
  // dock always shows immediate feedback while a session spins up, and an entry
  // point when idle-empty. The standalone terminal window seeds on mount, so it
  // shows the strip only once it has a tab (no empty flash).
  const showStrip = sessions.length > 0 || (visible && hostThreads);

  const sessionViews = showStrip ? (
    <TerminalTabStrip
      sessions={tabDescriptors}
      activeSessionId={activeSessionId}
      onSelect={(id) => {
        // A deliberate tab selection is the user taking over the active slot.
        pendingActiveKeyRef.current = null;
        setActiveSessionId(id);
      }}
      onTabActivate={(id) => {
        const session = sessionsRef.current.find((s) => s.id === id);
        if (session != null) queueMicrotask(() => focusSession(session));
      }}
      newButton={newButton}
      trailingControls={trailingControls}
      onClose={closeSession}
      onRename={renameSession}
      onReorder={reorderSessions}
      onDragActiveChange={(active) => {
        dragActiveRef.current = active;
      }}
      dockPosition={dockPosition}
      onToggleDock={onToggleDock}
      onCollapse={variant === 'window' ? undefined : () => onVisibleChange(false)}
      draggable={variant === 'window'}
      className="h-full"
    >
      {sessions.length === 0 ? (
        // A terminal surface auto-seeds on reveal, so an empty dock is only ever a
        // sub-frame transient there — render nothing (the ＋ button suffices) so no
        // "no sessions" text flashes. On a thread-only surface an empty dock is a
        // real resting state: offer the reopen-a-past-conversation chooser when
        // there is history, else the entry-point guidance.
        terminalAvailable ? null : hostThreads && archivedThreads.length > 0 ? (
          <ArchivedThreadChooser archived={archivedThreads} onOpen={openArchivedThread} />
        ) : (
          <EmptySessionsState />
        )
      ) : (
        panelSessions.map((session) => (
          <TabsContent
            key={session.id}
            value={session.id}
            forceMount
            data-session-id={session.id}
            {...(session.kind === 'terminal' ? { 'data-terminal-session': session.id } : {})}
            className={cn(
              'm-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden',
              variant === 'window' && 'px-[22px] pb-[22px]',
            )}
          >
            {session.kind === 'terminal' ? (
              bridge != null && terminalAvailable ? (
                <TerminalGate
                  bridge={bridge}
                  launch={session.launch}
                  adoptPtyId={session.adoptPtyId}
                  onPtyId={(ptyId) => setSessionPtyId(session.id, ptyId)}
                  onTitleChange={(title) => setSessionTitle(session.id, title)}
                  onClose={() => closeSession(session.id)}
                />
              ) : null
            ) : (
              <ThreadPanel
                threadId={session.threadId}
                info={threadInfoById.get(session.threadId)}
                // The reconnecting banner rides above the ACTIVE thread's
                // transcript only — never while a terminal (or another thread) is
                // focused, and never when the channel is healthy.
                showConnectionBanner={threadConnectionDown && session.id === activeSessionId}
              />
            )}
          </TabsContent>
        ))
      )}
    </TerminalTabStrip>
  ) : null;

  return (
    <>
      {hostEl != null
        ? createPortal(
            <>
              {sessionViews}
              <span
                ref={announcerRef}
                aria-live="polite"
                aria-atomic="true"
                className="sr-only"
                data-testid="terminal-reorder-announcer"
              />
            </>,
            hostEl,
          )
        : null}
    </>
  );
}

/** One thread session's body — the lazy {@link ThreadView}, kept mounted so its
 *  transcript + scroll survive tab switches, with an optional reconnecting banner
 *  above it. Renders nothing until the store first reports its info (a one-render
 *  race on create). */
function ThreadPanel({
  threadId,
  info,
  showConnectionBanner,
}: {
  threadId: string;
  info: ThreadInfo | undefined;
  showConnectionBanner: boolean;
}) {
  if (info === undefined) return null;
  return (
    <>
      {showConnectionBanner ? <ThreadConnectionBanner /> : null}
      <Suspense
        fallback={
          <div
            role="status"
            aria-busy="true"
            className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground"
          >
            <Loader2 className="size-5 animate-spin" aria-hidden="true" />
          </div>
        }
      >
        <ThreadView key={threadId} info={info} />
      </Suspense>
    </>
  );
}

/** Thin banner above an active thread's transcript while the agent-thread WS is
 *  reconnecting — the channel recovers + replays automatically (the client owns
 *  that), so this is feedback only. */
function ThreadConnectionBanner() {
  const { t } = useLingui();
  return (
    <div
      className="shrink-0 border-amber-500/30 border-b bg-amber-500/5 px-3 py-1 text-amber-700 text-xs dark:text-amber-400"
      data-testid="agent-thread-reconnecting"
    >
      {t`Reconnecting to the agent service…`}
    </div>
  );
}

/** Shown when the dock is open with no sessions — while a launched session spins
 *  up, or when the dock is idle-empty. Phrased as an invitation (not a status) so
 *  it reads fine in both cases; the ＋ split button in the strip is the way in. */
function EmptySessionsState() {
  const { t } = useLingui();
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-muted-foreground text-sm"
      data-testid="sessions-dock-empty"
    >
      {t`Start a session with the ＋ button, or launch an agent from a page.`}
    </div>
  );
}

/**
 * The reload-stable key a session persists under (a terminal's ptyId, a thread's
 * threadId), or null when a fresh terminal has no live PTY yet. Module-pure (takes
 * the ptyId map explicitly) so effects that consult it keep clean, stable deps.
 */
function computePersistKey(
  session: SessionDescriptor,
  ptyMap: ReadonlyMap<string, string>,
): string | null {
  if (session.kind === 'thread') return session.threadId;
  return session.adoptPtyId ?? ptyMap.get(session.id) ?? null;
}

/**
 * Place freshly-added sessions into `kept`: a session whose reload-stable key is in
 * the persisted `order` inserts at its ranked slot (restoring the cross-kind reload
 * arrangement as threads trickle in async); one that is not (live-created after
 * mount) appends. Existing sessions are never re-sorted, so a user reorder is never
 * disturbed.
 */
function placeSessionAdditions<T extends { readonly id: string }>(
  kept: readonly T[],
  additions: readonly T[],
  order: readonly string[],
  keyOf: (session: T) => string | null,
): T[] {
  const rankOf = (session: T): number => {
    const key = keyOf(session);
    if (key == null) return Number.POSITIVE_INFINITY;
    const i = order.indexOf(key);
    return i === -1 ? Number.POSITIVE_INFINITY : i;
  };
  const result = [...kept];
  for (const addition of additions) {
    const addRank = rankOf(addition);
    if (addRank === Number.POSITIVE_INFINITY) {
      result.push(addition);
      continue;
    }
    let insertAt = result.length;
    for (let i = 0; i < result.length; i++) {
      if (rankOf(result[i]) > addRank) {
        insertAt = i;
        break;
      }
    }
    result.splice(insertAt, 0, addition);
  }
  return result;
}
