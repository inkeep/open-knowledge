import { useLingui } from '@lingui/react/macro';
import { useTheme } from 'next-themes';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePanelRef } from 'react-resizable-panels';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { TabsContent } from '@/components/ui/tabs';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { getInitialTerminalHeight, writeTerminalHeight } from '@/lib/terminal-height-store';
import { cn } from '@/lib/utils';
import type { TerminalLaunchIntent } from './EditorPane';
import { TerminalGate } from './TerminalGate';
import { TerminalTabStrip } from './TerminalTabStrip';
import { xtermThemeForMode } from './terminal-theme';

const TERMINAL_PANEL_ID = 'terminal-dock-panel';

/** A concurrent terminal session the dock hosts as a tab. `id` is a stable
 *  client-side identity (not the async PTY id — the session resolves its own PTY
 *  on mount). `launch` is the one-shot intent the session writes once it is live;
 *  sessions opened from the tab strip carry none. `title` is the latest title the
 *  running program set via an OSC 0/2 escape sequence (shell prompt, `vim`, the
 *  `claude` TUI); null until the program sets one, falling back to the positional
 *  `Terminal N` default. Titles live for the session lifetime only. */
interface TerminalSessionDescriptor {
  readonly id: string;
  readonly launch: TerminalLaunchIntent | null;
  readonly title: string | null;
  /** The surviving PTY this tab reconnects to after a renderer reload, or `null`
   *  for a freshly-opened tab that spawns its own shell. */
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

interface TerminalDockProps {
  readonly bridge: OkDesktopBridge;
  readonly children: ReactNode;
  readonly visible: boolean;
  readonly onVisibleChange: (visible: boolean) => void;
  readonly launch?: TerminalLaunchIntent | null;
}

export function TerminalDock({
  bridge,
  children,
  visible,
  onVisibleChange,
  launch = null,
}: TerminalDockProps) {
  const { t } = useLingui();
  const { resolvedTheme } = useTheme();
  const panelRef = usePanelRef();
  const editorRegionRef = useRef<HTMLDivElement | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(!visible);

  const canRehydrate = typeof bridge.terminal?.list === 'function';

  const [sessions, setSessions] = useState<readonly TerminalSessionDescriptor[]>(() =>
    !canRehydrate && visible
      ? [{ id: makeSessionId(1), launch, title: null, adoptPtyId: null }]
      : [],
  );
  const [activeSessionId, setActiveSessionId] = useState(() =>
    !canRehydrate && visible ? makeSessionId(1) : '',
  );
  const [rehydrationSettled, setRehydrationSettled] = useState(!canRehydrate);
  const rehydratedRef = useRef(false);
  const activeSessionIdRef = useRef(activeSessionId);
  const sessionsRef = useRef(sessions);
  const sessionCounterRef = useRef(!canRehydrate && visible ? 1 : 0);
  const lastHandledLaunchNonceRef = useRef<number | null>(visible && launch ? launch.nonce : null);
  const prevVisibleRef = useRef(visible);

  function openSession(launchForSession: TerminalLaunchIntent | null) {
    sessionCounterRef.current += 1;
    const id = makeSessionId(sessionCounterRef.current);
    setSessions((prev) => [
      ...prev,
      { id, launch: launchForSession, title: null, adoptPtyId: null },
    ]);
    setActiveSessionId(id);
  }

  function setSessionTitle(id: string, title: string) {
    const next = title.trim() === '' ? null : title.trim();
    setSessions((prev) => {
      if (!prev.some((session) => session.id === id && session.title !== next)) return prev;
      return prev.map((session) => (session.id === id ? { ...session, title: next } : session));
    });
  }
  const openSessionRef = useRef(openSession);

  function closeSession(id: string) {
    const current = sessionsRef.current;
    const index = current.findIndex((session) => session.id === id);
    if (index === -1) return;
    const next = current.filter((session) => session.id !== id);
    if (id === activeSessionId) {
      const neighbor = current[index - 1] ?? current[index + 1];
      const neighborId = neighbor?.id ?? '';
      setActiveSessionId(neighborId);
      if (neighborId !== '') queueMicrotask(() => focusTerminalSession(neighborId));
    }
    setSessions(next);
    if (next.length === 0) {
      onVisibleChange(false);
      editorRegionRef.current?.focus();
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

  const [initialHeightPx] = useState(() => getInitialTerminalHeight());
  const heightPxRef = useRef(initialHeightPx);

  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);

  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function debouncedWriteHeight(px: number) {
    if (writeTimerRef.current != null) clearTimeout(writeTimerRef.current);
    writeTimerRef.current = setTimeout(() => {
      writeTerminalHeight(px);
      writeTimerRef.current = null;
    }, 100);
  }
  const dragUpHandlerRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      if (writeTimerRef.current != null) clearTimeout(writeTimerRef.current);
      if (dragUpHandlerRef.current != null) {
        window.removeEventListener('pointerup', dragUpHandlerRef.current);
        dragUpHandlerRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    if (!rehydrationSettled) return;

    const wasVisible = prevVisibleRef.current;
    prevVisibleRef.current = visible;

    if (launch != null && launch.nonce !== lastHandledLaunchNonceRef.current) {
      lastHandledLaunchNonceRef.current = launch.nonce;
      openSessionRef.current(launch);
      return;
    }
    if (visible && !wasVisible && sessions.length === 0) {
      openSessionRef.current(null);
    }
  }, [visible, launch, sessions.length, rehydrationSettled]);

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
      rehydratedRef.current = false;
    };
  }, [bridge]);

  useEffect(() => {
    return bridge.onMenuAction((action) => {
      if (action === 'new-terminal') openSessionRef.current(null);
      else if (action === 'kill-terminal') closeActiveRef.current();
    });
  }, [bridge]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (!/^[1-9]$/.test(event.key)) return;
      const panelEl = document.getElementById(TERMINAL_PANEL_ID);
      if (!panelEl?.contains(document.activeElement)) return;
      const target = sessionsRef.current[Number(event.key) - 1];
      if (target == null) return;
      event.preventDefault();
      event.stopPropagation();
      setActiveSessionId(target.id);
      queueMicrotask(() => focusTerminalSession(target.id));
    }
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);

  useEffect(() => {
    bridge.editor.notifyViewMenuStateChanged({ terminalLive: sessions.length > 0 });
  }, [bridge, sessions.length]);

  useEffect(() => {
    const panel = panelRef.current;
    if (panel == null) return;
    if (visible) {
      panel.resize(`${heightPxRef.current}px`);
    } else {
      panel.collapse();
    }
  }, [visible, panelRef]);

  useLayoutEffect(() => {
    if (!isCollapsed) return;
    const panelEl = document.getElementById(TERMINAL_PANEL_ID);
    if (!panelEl?.contains(document.activeElement)) return;
    editorRegionRef.current?.focus();
  }, [isCollapsed]);

  useEffect(() => {
    if (isCollapsed) return;
    focusTerminalSession(activeSessionIdRef.current);
  }, [isCollapsed]);

  const tabDescriptors = sessions.map((session, index) => ({
    id: session.id,
    label: session.title ?? t`Terminal ${index + 1}`,
  }));

  return (
    <ResizablePanelGroup
      orientation="vertical"
      className="min-h-0 flex-1"
      data-dragging={isDragging || undefined}
    >
      <ResizablePanel minSize="5%" className="flex min-h-0 flex-col">
        {/* tabIndex -1 makes this a programmatic focus target for focus-return
            on collapse without adding it to the tab order. */}
        <div
          ref={editorRegionRef}
          tabIndex={-1}
          className="flex h-full min-h-0 flex-col outline-none"
        >
          {children}
        </div>
      </ResizablePanel>
      <ResizableHandle
        withHandle
        onPointerDown={() => {
          setIsDragging(true);
          isDraggingRef.current = true;
          const handleUp = () => {
            setIsDragging(false);
            isDraggingRef.current = false;
            window.removeEventListener('pointerup', handleUp);
            dragUpHandlerRef.current = null;
          };
          dragUpHandlerRef.current = handleUp;
          window.addEventListener('pointerup', handleUp);
        }}
      />
      <ResizablePanel
        id={TERMINAL_PANEL_ID}
        style={{ backgroundColor: xtermThemeForMode(resolvedTheme).background }}
        panelRef={panelRef}
        defaultSize={visible ? `${initialHeightPx}px` : 0}
        minSize="120px"
        maxSize="95%"
        collapsible
        collapsedSize={0}
        onResize={(size) => {
          const collapsed = size.asPercentage === 0;
          setIsCollapsed(collapsed);
          if (isDraggingRef.current) {
            if (collapsed && visible) onVisibleChange(false);
            else if (!collapsed && !visible) onVisibleChange(true);
            if (size.inPixels > 0) {
              heightPxRef.current = size.inPixels;
              debouncedWriteHeight(size.inPixels);
            }
          }
        }}
        inert={isCollapsed}
        className={cn(
          'flex flex-col',
          !isDragging &&
            'transition-[flex-grow] duration-150 ease-out motion-reduce:transition-none motion-reduce:duration-0',
        )}
      >
        {sessions.length > 0 ? (
          <TerminalTabStrip
            sessions={tabDescriptors}
            activeSessionId={activeSessionId}
            onSelect={setActiveSessionId}
            onTabActivate={(id) => queueMicrotask(() => focusTerminalSession(id))}
            onNew={() => openSession(null)}
            onClose={closeSession}
            className="h-full"
          >
            {sessions.map((session) => (
              <TabsContent
                key={session.id}
                value={session.id}
                forceMount
                data-terminal-session={session.id}
                className="m-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden"
              >
                <TerminalGate
                  bridge={bridge}
                  launch={session.launch}
                  adoptPtyId={session.adoptPtyId}
                  onTitleChange={(title) => setSessionTitle(session.id, title)}
                  onClose={() => closeSession(session.id)}
                />
              </TabsContent>
            ))}
          </TerminalTabStrip>
        ) : null}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
