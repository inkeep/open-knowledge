import type { TerminalCli } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TabsContent } from '@/components/ui/tabs';
import { resolveDefaultCli } from '@/lib/default-cli-resolver';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import type { TerminalDockPosition } from '@/lib/terminal-dock-store';
import {
  getInitialPreferBareTerminal,
  writePreferBareTerminal,
} from '@/lib/terminal-new-tab-store';
import { loadStickyAgent, saveStickyAgent, terminalCliId } from '@/lib/unified-agent-store';
import { cn } from '@/lib/utils';
import { emitOpenAskAiComposer } from './ask-ai-composer-events';
import type { TerminalLaunchIntent } from './EditorPane';
import { subscribeToActiveTerminalInput } from './handoff/terminal-input-events';
import { TerminalGate } from './TerminalGate';
import type { TerminalNewTabChoice } from './TerminalNewChatButton';
import { TerminalTabStrip } from './TerminalTabStrip';

/** A concurrent terminal session the host keeps as a tab. `id` is a stable
 *  client-side identity (not the async PTY id — the session resolves its own PTY
 *  on mount). `launch` is the one-shot intent the session writes once it is live;
 *  sessions opened from the tab strip carry none. `title` is the latest OSC 0/2
 *  title the running program set (null → the tab shows its positional default).
 *  `adoptPtyId` is the surviving ptyId after a renderer reload — the session
 *  adopts that live shell instead of spawning a fresh one; null for new tabs. */
interface TerminalSessionDescriptor {
  readonly id: string;
  readonly launch: TerminalLaunchIntent | null;
  readonly title: string | null;
  readonly adoptPtyId: string | null;
}

function makeSessionId(counter: number): string {
  return `terminal-session-${counter}`;
}

/** Move focus into a session's terminal. xterm routes keystrokes through its
 *  helper textarea, so focusing it is equivalent to term.focus(). No-ops when
 *  the textarea has not mounted yet (xterm mounts asynchronously). */
function focusTerminalSession(id: string) {
  if (id === '') return;
  document
    .querySelector<HTMLElement>(`[data-terminal-session="${id}"] .xterm-helper-textarea`)
    ?.focus();
}

interface TerminalSessionsHostProps {
  /** Desktop bridge — the host renders only on the Electron surface. */
  readonly bridge: OkDesktopBridge;
  /**
   * Which surface hosts the sessions. `'dock'` (default) is the editor's
   * docked terminal: visibility-driven seeding, dock-toggle + collapse controls,
   * ⌘1–9 scoped to focus inside the host. `'window'` is the standalone terminal
   * window: always visible, seeds its first tab on mount, the tab row doubles as
   * the macOS title bar, no dock/collapse controls (window management is the
   * OS's), and ⌘1–9 is scope-free (the whole window is the terminal). Everything
   * else — the new-chat split button, OSC tab titles, menu actions, liveness,
   * reload rehydration — is identical by construction: one session model, two
   * placements.
   */
  readonly variant?: 'dock' | 'window';
  /** Controlled visibility. The host reflects this and reports close-last back
   *  through {@link onVisibleChange}; it never owns it. The window variant pins
   *  it `true` and maps the close-last report to `window.close()`. */
  readonly visible: boolean;
  readonly onVisibleChange: (visible: boolean) => void;
  /** "Open in terminal" launch intent — each new intent opens its own tab. */
  readonly launch?: TerminalLaunchIntent | null;
  /** Which CLIs are on PATH (desktop probe). The tab strip's "New chat" resolves
   *  its default CLI from this + the sticky pick. */
  readonly installedClis?: Partial<Record<TerminalCli, boolean>>;
  /**
   * The DOM container the live terminal portals into right now — the bottom dock's
   * mount or the right region's terminal tenant. The single stable host div is
   * physically appended here; relocating the DOM (rather than swapping the portal
   * target, or remounting the host) is what keeps a dock move from re-spawning the
   * PTY. This component is mounted ONCE, above the editor's resizable panel group,
   * so it never remounts on a dock change. Null only transiently before a
   * container attaches.
   */
  readonly container: HTMLElement | null;
  /** Whether the terminal is actually on screen — drives focus in/out. */
  readonly isShowing: boolean;
  /** Return focus to the editor when the terminal hides or the last tab closes. */
  readonly onRequestEditorFocus: () => void;
  /** Current dock position — passed to the tab strip's dock-toggle + collapse
   *  controls so their icons/labels reflect where the terminal lives. Dock
   *  variant only. */
  readonly dockPosition?: TerminalDockPosition;
  /** Flip the dock between bottom and right (the tab strip's dock-toggle button).
   *  Dock variant only — the strip renders no toggle without it. */
  readonly onToggleDock?: () => void;
  /** Reports whether any PTY session is currently open. The header's New chat
   *  button reads this to decide between spawning a first chat and merely
   *  revealing the existing dock. */
  readonly onHasSessionsChange?: (hasSessions: boolean) => void;
}

/**
 * Owns the terminal session collection and the single stable host div. Mounted
 * ONCE at a stable position ABOVE the editor's resizable panel group (in
 * EditorArea) so a dock change cannot remount it — the live shell, scrollback, and
 * tabs survive the move. The sessions render into the host div via a portal whose
 * target never changes; the host div is appended into whichever {@link container}
 * is active (bottom dock ↔ right region).
 */
export function TerminalSessionsHost({
  bridge,
  variant = 'dock',
  visible,
  onVisibleChange,
  launch = null,
  installedClis,
  container,
  isShowing,
  onRequestEditorFocus,
  dockPosition,
  onToggleDock,
  onHasSessionsChange,
}: TerminalSessionsHostProps) {
  const { t } = useLingui();

  // The single stable host div for the terminal session subtree. Created once via
  // a useState lazy initializer (never a render-time ref write — the React
  // Compiler forbids touching refs during render) and never recreated.
  const [hostEl] = useState<HTMLDivElement | null>(() => {
    if (typeof document === 'undefined') return null;
    const el = document.createElement('div');
    el.className = 'flex min-h-0 flex-1 flex-col overflow-hidden';
    return el;
  });

  // Append the stable host div into the active container. A constant portal target
  // plus DOM relocation means no remount on a dock move. useLayoutEffect runs
  // before the focus passive effects below, so the host is attached before a
  // focus-on-reveal (focusing an element outside the document is a no-op).
  useLayoutEffect(() => {
    if (hostEl == null || container == null) return;
    if (hostEl.parentElement !== container) container.appendChild(hostEl);
  }, [hostEl, container]);

  // A capable desktop bridge can report the PTY sessions that survived a renderer
  // reload in the main process, so the host rehydrates them on mount instead of
  // starting fresh. When it can, the synchronous seed below stands down and the
  // async mount effect becomes the single source of truth for the initial sessions
  // (adopt survivors, or settle to let the seed path run). A session-only bridge
  // with no `terminal` surface keeps the synchronous cold-start.
  const canRehydrate = typeof bridge.terminal?.list === 'function';

  // The session collection is the mount latch generalized to N tabs: a session
  // stays in the list across hide/show (hide is not kill) so a long-running shell
  // survives a collapse. Before the first open the list is empty — no PTY until
  // the user opens the terminal. Opening with the terminal already visible seeds
  // the first session (with any launch intent) so it never flashes empty. When the
  // bridge can rehydrate, start empty and let the mount effect populate it so a
  // survived reload never spawns a fresh shell only to replace it with the adopted
  // set.
  const [sessions, setSessions] = useState<readonly TerminalSessionDescriptor[]>(() =>
    !canRehydrate && visible
      ? [{ id: makeSessionId(1), launch, title: null, adoptPtyId: null }]
      : [],
  );
  const [activeSessionId, setActiveSessionId] = useState(() =>
    !canRehydrate && visible ? makeSessionId(1) : '',
  );
  // False until the async rehydrate settles (capable bridge only); gates the
  // open/launch effect's seed so a transient visibility flip during the in-flight
  // inventory query can't spawn a shell the adopted set would then replace.
  const [rehydrationSettled, setRehydrationSettled] = useState(!canRehydrate);
  const rehydratedRef = useRef(false);
  // Mirror so the reveal-focus effect can target the active session without
  // re-running on every tab switch (which would steal focus during arrow-key nav).
  const activeSessionIdRef = useRef(activeSessionId);
  // Live tab order, mirrored so the ⌘-number key handler reads it without
  // re-subscribing its window listener on every session change.
  const sessionsRef = useRef(sessions);
  // Monotonic, never reused, so a closed tab's id can't collide with a later one.
  const sessionCounterRef = useRef(!canRehydrate && visible ? 1 : 0);
  // Highest launch nonce already turned into a tab — guards exactly-one-tab-per
  // intent across re-renders.
  const lastHandledLaunchNonceRef = useRef<number | null>(visible && launch ? launch.nonce : null);
  // Tracks the prior `visible` so the open-from-hidden transition (false→true) is
  // distinguishable from "still visible". The window variant mounts already
  // visible, so its mount IS the open transition — starting the ref false routes
  // the first-tab seed through the same open path the dock uses (after any
  // rehydration settles, so adopted reload survivors still win over a fresh seed).
  const prevVisibleRef = useRef(variant === 'window' ? false : visible);
  // Live PTY id per session, reported up from each panel (null on teardown). Lets
  // the selection-bubble "Ask AI" input (requestActiveTerminalInput) write into an
  // already-open terminal's live shell (reuse) instead of the caret going to the
  // composer. A session absent from the map has no live PTY yet (still starting,
  // or torn down).
  const ptyIdBySessionRef = useRef(new Map<string, string>());
  function setSessionPtyId(id: string, ptyId: string | null) {
    if (ptyId === null) ptyIdBySessionRef.current.delete(id);
    else ptyIdBySessionRef.current.set(id, ptyId);
  }
  // Monotonic nonce for tab-strip "New chat" launches. TerminalLaunchIntent
  // requires a nonce, but it is only load-bearing for the EditorPane→prop
  // launch-channel dedup; a direct openSession writes its launch once on mount,
  // so this just keeps each strip launch a distinct, never-reused intent.
  const stripLaunchNonceRef = useRef(0);

  function openSession(launchForSession: TerminalLaunchIntent | null) {
    sessionCounterRef.current += 1;
    const id = makeSessionId(sessionCounterRef.current);
    setSessions((prev) => [
      ...prev,
      { id, launch: launchForSession, title: null, adoptPtyId: null },
    ]);
    setActiveSessionId(id);
  }

  // Sticky CLI mirror, mount-read from the shared Ask-AI store, so the New-chat
  // split button's default reflects the user's last pick and updates its primary
  // icon reactively when they switch CLI from the dropdown. `resolveDefaultCli`
  // also honors the live `installedClis` when there is no sticky pick.
  const [stickyCliId, setStickyCliId] = useState<string | null>(() => loadStickyAgent());
  // Terminal-only "last New-tab pick was a bare shell" flag. The shared store has
  // no terminal concept, so a "Terminal" pick sticks here instead; when set it
  // overrides the CLI default. Cleared on any CLI pick (CLI behavior is unchanged).
  const [preferBareTerminal, setPreferBareTerminal] = useState(() =>
    getInitialPreferBareTerminal(),
  );
  const newChatDefaultCli = resolveDefaultCli(stickyCliId, installedClis ?? {});
  const newChatSelected: TerminalNewTabChoice = preferBareTerminal ? 'terminal' : newChatDefaultCli;

  // Tab-strip New-chat primary: open a promptless session running `cli`.
  function openNewChatSession(cli: TerminalCli) {
    stripLaunchNonceRef.current += 1;
    openSession({ prompt: null, cli, nonce: stripLaunchNonceRef.current });
  }

  // Primary click: launch the current pick — a bare shell when Terminal is the
  // default, else a promptless session in the default CLI.
  function launchSelectedNewTab() {
    if (preferBareTerminal) openSession(null);
    else openNewChatSession(newChatDefaultCli);
  }

  // Dropdown CLI pick: clear the bare-terminal preference, persist `cli` to the
  // shared Ask-AI store (so every entry point agrees), and open a session in it.
  function pickNewChatCli(cli: TerminalCli) {
    setPreferBareTerminal(false);
    writePreferBareTerminal(false);
    const id = terminalCliId(cli);
    setStickyCliId(id);
    saveStickyAgent(id);
    openNewChatSession(cli);
  }

  // Dropdown "Terminal" pick: persist the bare-shell preference (terminal-only)
  // and open a bare shell. A subsequent primary click then opens a terminal too.
  function pickNewChatTerminal() {
    setPreferBareTerminal(true);
    writePreferBareTerminal(true);
    openSession(null);
  }

  // Record the title the session's program set via OSC 0/2. A trimmed-empty title
  // clears it so the tab reverts to its positional `Terminal N` default (some
  // programs emit an empty title on exit). Shells re-emit the title on every
  // prompt, so when nothing changed we return the SAME array reference — React's
  // Object.is bailout then skips the re-render entirely (a per-element guard alone
  // wouldn't: a fresh array always fails the bailout).
  function setSessionTitle(id: string, title: string) {
    const next = title.trim() === '' ? null : title.trim();
    setSessions((prev) => {
      if (!prev.some((session) => session.id === id && session.title !== next)) return prev;
      return prev.map((session) => (session.id === id ? { ...session, title: next } : session));
    });
  }
  // Latest-ref so deps-stable effects below call the current closure without
  // re-subscribing (React Compiler forbids writing the ref during render).
  const openSessionRef = useRef(openSession);

  function closeSession(id: string) {
    // Read the live list from the ref (kept in sync post-commit), not the render
    // closure, so two close actions that coalesce into one batch can't act on a
    // stale snapshot — the same source the ⌘-number handler reads.
    const current = sessionsRef.current;
    const index = current.findIndex((session) => session.id === id);
    if (index === -1) return;
    const next = current.filter((session) => session.id !== id);
    // Closing the active tab activates its left neighbor, else the right one.
    if (id === activeSessionId) {
      const neighbor = current[index - 1] ?? current[index + 1];
      const neighborId = neighbor?.id ?? '';
      setActiveSessionId(neighborId);
      // Move focus into the surviving neighbor's terminal so a keyboard user who
      // closed the focused tab is not stranded on the body. Deferred so the newly
      // active panel has committed to shown before focusing.
      if (neighborId !== '') queueMicrotask(() => focusTerminalSession(neighborId));
    }
    setSessions(next);
    // Closing the last tab hides the terminal and returns focus to the editor; the
    // none-left state means the next open spawns a fresh session.
    if (next.length === 0) {
      onVisibleChange(false);
      onRequestEditorFocus();
    }
  }
  const closeActiveRef = useRef(() => {});

  useEffect(() => {
    openSessionRef.current = openSession;
    activeSessionIdRef.current = activeSessionId;
    sessionsRef.current = sessions;
    closeActiveRef.current = () => {
      if (activeSessionId !== '') closeSession(activeSessionId);
    };
  });

  // Open/launch lifecycle: a fresh launch intent opens its own tab; otherwise an
  // open-from-hidden transition seeds the first session. Reacting to
  // `sessions.length` lets the close-last settle without a re-create.
  useEffect(() => {
    // While the async rehydrate is in flight (capable bridge), it owns the initial
    // session set — stand down entirely, including the prevVisible bookkeeping, so
    // a false→true visibility restore that lands mid-flight is still seen as a
    // fresh open transition once rehydration settles.
    if (!rehydrationSettled) return;

    const wasVisible = prevVisibleRef.current;
    prevVisibleRef.current = visible;

    if (launch != null && launch.nonce !== lastHandledLaunchNonceRef.current) {
      lastHandledLaunchNonceRef.current = launch.nonce;
      // A CLI launch (create composer, "Open in terminal" menus, bottom composer)
      // always opens its own tab: "create" means a fresh terminal, never hijacking
      // a shell the user already has running. Reuse of an open terminal is
      // exclusively the selection-bubble path (requestActiveTerminalInput), which
      // writes the highlighted text into the live PTY without a launch nonce.
      openSessionRef.current(launch);
      return;
    }
    if (visible && !wasVisible && sessions.length === 0) {
      openSessionRef.current(null);
    }
  }, [visible, launch, sessions.length, rehydrationSettled]);

  // Reload rehydration (capable bridge only): on mount ask main which PTY sessions
  // survived the reload and rebuild one tab per survivor, each carrying the
  // surviving ptyId so its panel adopts the live shell rather than spawning a fresh
  // one. Run-once (ref-guarded). With no survivors it simply settles and lets the
  // open/launch effect own cold-start seeding. A throw resolves to "no survivors"
  // so a bridge hiccup degrades to a normal cold start, never a crash.
  useEffect(() => {
    if (typeof bridge.terminal?.list !== 'function') return;
    if (rehydratedRef.current) return;
    rehydratedRef.current = true;
    let cancelled = false;
    void (async () => {
      let survivors: readonly { ptyId: string }[] = [];
      try {
        survivors = (await bridge.terminal.list()) ?? [];
      } catch (err) {
        // Degrade to a normal cold start, but leave a breadcrumb: a transient
        // list() failure is otherwise indistinguishable from "no survivors", so
        // any surviving PTYs stay orphaned while the dock starts fresh.
        console.error('[terminal] reload session list() failed; cold-starting:', err);
        survivors = [];
      }
      if (cancelled) return;
      if (survivors.length > 0) {
        const recovered = survivors.map((entry, index) => ({
          id: makeSessionId(index + 1),
          launch: null,
          title: null,
          adoptPtyId: entry.ptyId,
        }));
        sessionCounterRef.current = recovered.length;
        setSessions(recovered);
        setActiveSessionId(recovered[0]?.id ?? '');
      }
      setRehydrationSettled(true);
    })();
    return () => {
      cancelled = true;
      // Reset the run-once guard so React StrictMode's dev double-mount re-runs
      // rehydration on the second mount; the first mount's in-flight list() is
      // discarded via `cancelled`. The reset is load-bearing, NOT removable: the
      // first StrictMode pass is cancelled before it settles `rehydrationSettled`,
      // so without the reset the second pass would skip and the gate would never
      // settle (the terminal would never seed). This depends on `bridge` being
      // referentially stable in production — it is `window.okDesktop`, captured
      // once in EditorPane — so the effect only re-runs under StrictMode, never on
      // a live bridge churn that could re-seed over an active session set.
      rehydratedRef.current = false;
    };
  }, [bridge]);

  // The editor's "Ask AI" selection affordance routes here: when a terminal is
  // open with a live PTY, write the selected text straight into the active shell
  // (e.g. a running claude TUI). No trailing newline — the user reviews/sends it.
  // With no terminal open, fall back to the bottom Ask-AI composer, the same
  // surface a caret-only Ask AI opens. The host is mounted whenever the desktop
  // bridge exists (even with zero sessions), so this subscription is always live.
  useEffect(() => {
    return subscribeToActiveTerminalInput((text) => {
      const activeId = activeSessionIdRef.current;
      const livePtyId = activeId === '' ? undefined : ptyIdBySessionRef.current.get(activeId);
      if (livePtyId != null) {
        bridge.terminal.input(livePtyId, text);
        queueMicrotask(() => focusTerminalSession(activeId));
      } else {
        emitOpenAskAiComposer();
      }
    });
  }, [bridge]);

  // The Terminal application menu's per-session items act on the tab collection:
  // "New Terminal" opens a fresh tab, "Kill Terminal" closes the active one —
  // reusing the strip's own open/close paths so menu and strip stay identical.
  // ⌘W (`close-active-tab-or-window`) closes the active tab in the WINDOW
  // variant only — every BrowserWindow type must subscribe to it (menu.ts
  // contract), and in the terminal window this host is the only subscriber
  // (close-last then closes the window via the close-last report). In the
  // editor window the doc tree owns ⌘W (DocumentContext closes the active doc
  // tab); handling it here too would double-close.
  useEffect(() => {
    return bridge.onMenuAction((action) => {
      if (action === 'new-terminal') openSessionRef.current(null);
      else if (action === 'kill-terminal') closeActiveRef.current();
      else if (action === 'close-active-tab-or-window' && variant === 'window')
        closeActiveRef.current();
    });
  }, [bridge, variant]);

  // ⌘1–⌘9 jump straight to the Nth tab. Capture phase so a focused xterm can't
  // swallow the chord; scoped to focus inside the stable host div (which follows
  // the terminal to whichever dock) so the digit chord stays free everywhere else.
  // The window variant skips the scope gate — the whole window is the terminal,
  // so there is nothing else the digit chord could mean there.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (!/^[1-9]$/.test(event.key)) return;
      if (variant !== 'window' && (hostEl == null || !hostEl.contains(document.activeElement)))
        return;
      const target = sessionsRef.current[Number(event.key) - 1];
      if (target == null) return;
      event.preventDefault();
      event.stopPropagation();
      setActiveSessionId(target.id);
      queueMicrotask(() => focusTerminalSession(target.id));
    }
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [hostEl, variant]);

  // Reflect PTY liveness to main so the Terminal menu's "Kill Terminal" item
  // enables only while at least one session is live. A collapsed-but-alive
  // terminal still counts: the session list tracks the latch, not visibility.
  useEffect(() => {
    bridge.editor.notifyViewMenuStateChanged({ terminalLive: sessions.length > 0 });
  }, [bridge, sessions.length]);

  useEffect(() => {
    onHasSessionsChange?.(sessions.length > 0);
  }, [onHasSessionsChange, sessions.length]);

  // Return focus out of the hidden terminal so a keyboard user is never stranded.
  // Only acts when focus is actually inside the terminal.
  //
  // Gate on `visible`, not just `isShowing`: a dock move (bottom ↔ right) keeps the
  // terminal `visible` but transiently drops `isShowing` to false for one commit
  // while the destination container's callback ref attaches (`activeTerminalContainer`
  // is null until then). Without the `visible` guard, clicking the dock-toggle —
  // which lives inside this portaled host, so focus is inside it — would satisfy the
  // focus-inside check and yank focus to the editor mid-move. A genuine hide (⌘J,
  // collapse, close-last) always sets `visible` false, so focus-return still fires.
  useLayoutEffect(() => {
    if (isShowing || visible) return;
    if (hostEl == null || !hostEl.contains(document.activeElement)) return;
    onRequestEditorFocus();
  }, [isShowing, visible, hostEl, onRequestEditorFocus]);

  // Focus the active session's terminal when the terminal is revealed so the user
  // can type immediately. Keyed on the show transition only (active id read from a
  // ref) so switching tabs does not re-fire this.
  useEffect(() => {
    if (!isShowing) return;
    focusTerminalSession(activeSessionIdRef.current);
  }, [isShowing]);

  const tabDescriptors = sessions.map((session, index) => ({
    id: session.id,
    // The program's OSC title when it set one, else the positional default.
    label: session.title ?? t`Terminal ${index + 1}`,
  }));

  const sessionViews =
    sessions.length > 0 ? (
      <TerminalTabStrip
        sessions={tabDescriptors}
        activeSessionId={activeSessionId}
        onSelect={setActiveSessionId}
        // Focus the terminal after the activation commits (so the now-shown
        // container is focusable) when a tab is selected by pointer or Enter.
        onTabActivate={(id) => queueMicrotask(() => focusTerminalSession(id))}
        newChatSelected={newChatSelected}
        onNewChatLaunch={launchSelectedNewTab}
        onNewChatPickCli={pickNewChatCli}
        onNewChatPickTerminal={pickNewChatTerminal}
        onClose={closeSession}
        dockPosition={dockPosition}
        onToggleDock={onToggleDock}
        // Collapse hides the terminal but keeps every session alive (hide is not
        // kill), exactly like the ⌘J toggle — the next reveal restores the tabs.
        // The window has no collapse (closing the window is the OS affordance).
        onCollapse={variant === 'window' ? undefined : () => onVisibleChange(false)}
        // Window mode: the tab row doubles as the frameless window's title bar.
        draggable={variant === 'window'}
        className="h-full"
      >
        {sessions.map((session) => (
          // forceMount keeps every session mounted (active shown, inactive
          // CSS-hidden) so each retains its xterm scrollback and keeps consuming
          // output — switching tabs is show/hide, never unmount.
          <TabsContent
            key={session.id}
            value={session.id}
            forceMount
            data-terminal-session={session.id}
            // Window mode insets the terminal content by the traffic-light gutter
            // (22px, = trafficLightPosition.x) so its left edge lines up with the
            // bubbles and it isn't glued to the window's edges; the padding shows
            // the window background, framing the xterm. The dock sits flush.
            className={cn(
              'm-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden',
              variant === 'window' && 'px-[22px] pb-[22px]',
            )}
          >
            <TerminalGate
              bridge={bridge}
              launch={session.launch}
              // On a renderer reload the session adopts its surviving PTY (live
              // shell + replay) instead of spawning a fresh one; null for new tabs.
              adoptPtyId={session.adoptPtyId}
              // Track this session's live PTY id so the selection-bubble "Ask AI"
              // input can reuse the open terminal (write into the live shell)
              // rather than fall back to the composer. Adopted sessions report
              // their id too, so reuse works for reload survivors.
              onPtyId={(ptyId) => setSessionPtyId(session.id, ptyId)}
              // OSC 0/2 title from the running program → this session's tab label.
              onTitleChange={(title) => setSessionTitle(session.id, title)}
              // The session's "Close terminal" affordance (shown on a refusal/exit
              // notice) closes that tab — hiding the terminal only when it is the
              // last one. The keyboard exit stays ⌘J.
              onClose={() => closeSession(session.id)}
            />
          </TabsContent>
        ))}
      </TerminalTabStrip>
    ) : null;

  // Render the session subtree into the stable host div (which the relocate effect
  // appends to the active container). A constant portal target = no remount on a
  // dock move.
  return hostEl != null ? createPortal(sessionViews, hostEl) : null;
}
