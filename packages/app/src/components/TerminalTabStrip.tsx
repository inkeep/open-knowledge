// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from '@dnd-kit/sortable';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  PanelBottomIcon,
  PanelRightIcon,
  XIcon,
} from 'lucide-react';
import { type ReactElement, type ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { InputGroup, InputGroupInput } from '@/components/ui/input-group';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  createTabReorderModifier,
  getSortableTabStyle,
  measureTabReorderBounds,
  shouldOpenTabContextMenu,
  TAB_REORDER_AUTO_SCROLL,
  type TabReorderBounds,
  tabRunCollisionDetection,
} from './editor-tabs-chrome';
import { scrollTabStripOnWheel } from './tab-strip-wheel';

const TERMINAL_TAB_SORTABLE_SELECTOR = '[data-terminal-tab-sortable]';

function SortableTerminalTab({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled: boolean;
  children: (sortable: {
    setNodeRef: (node: HTMLElement | null) => void;
    listeners: ReturnType<typeof useSortable>['listeners'];
    style: ReturnType<typeof getSortableTabStyle>;
  }) => ReactNode;
}) {
  const { setNodeRef, listeners, rect, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });
  const style = getSortableTabStyle({
    activeWidth: rect.current?.width,
    isDragging,
    transform,
    transition,
  });
  return children({ setNodeRef, listeners, style });
}

export interface TerminalTabDescriptor {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
}

export type SessionPanelEdge = 'bottom' | 'right';
type SessionKind = 'terminal' | 'agent';

function BottomTerminalPlacementMenu({
  children,
  onMoveRight,
}: {
  readonly children: ReactElement;
  readonly onMoveRight?: () => void;
}) {
  const keyboardTriggerRef = useRef<HTMLElement | null>(null);
  if (onMoveRight == null) return children;

  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        onKeyDown={(event) => {
          if (!shouldOpenTabContextMenu(event)) return;
          event.preventDefault();
          keyboardTriggerRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          const rect = event.currentTarget.getBoundingClientRect();
          event.currentTarget.dispatchEvent(
            new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              clientX: rect.left,
              clientY: rect.bottom,
            }),
          );
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={(event) => {
          if (keyboardTriggerRef.current == null) return;
          event.preventDefault();
          keyboardTriggerRef.current.focus();
          keyboardTriggerRef.current = null;
        }}
      >
        <ContextMenuGroup>
          <ContextMenuItem onSelect={onMoveRight}>
            <PanelRightIcon aria-hidden="true" />
            <Trans>Move to right panel</Trans>
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface TerminalTabStripProps {
  readonly sessions: readonly TerminalTabDescriptor[];
  readonly sessionKind: SessionKind;
  readonly activeSessionId: string;
  readonly onSelect: (id: string) => void;
  readonly onTabActivate?: (id: string) => void;
  readonly newButton?: ReactNode;
  readonly trailingControls?: ReactNode;
  readonly onClose: (id: string) => void;
  readonly onRename?: (id: string, label: string) => void;
  readonly onReorder?: (newOrderIds: readonly string[]) => void;
  readonly onDragActiveChange?: (active: boolean) => void;
  readonly edge?: SessionPanelEdge;
  readonly onPlacementChange?: (placement: SessionPanelEdge) => void;
  readonly reserveRightRevealTabGutter?: boolean;
  readonly onCollapse?: () => void;
  readonly children?: ReactNode;
  readonly className?: string;
  readonly draggable?: boolean;
}

export function TerminalTabStrip({
  sessions,
  sessionKind,
  activeSessionId,
  onSelect,
  onTabActivate,
  newButton,
  trailingControls,
  onClose,
  onRename,
  onReorder,
  onDragActiveChange,
  edge,
  onPlacementChange,
  reserveRightRevealTabGutter,
  onCollapse,
  children,
  className,
  draggable,
}: TerminalTabStripProps) {
  const { t } = useLingui();
  const rightEdge = edge === 'right';
  const placementTarget: SessionPanelEdge = rightEdge ? 'bottom' : 'right';
  const placementLabel = rightEdge ? t`Move Terminal to bottom` : t`Move Terminal to right`;
  const onMoveRight =
    sessionKind === 'terminal' && edge === 'bottom' && onPlacementChange != null
      ? () => onPlacementChange('right')
      : undefined;

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const cancelRenameRef = useRef(false);
  const renameEnabled = onRename != null;

  useEffect(() => {
    if (renamingId == null) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingId]);

  useEffect(() => {
    if (renamingId != null && !sessions.some((session) => session.id === renamingId)) {
      cancelRenameRef.current = false;
      setRenamingId(null);
      setRenameValue('');
    }
  }, [sessions, renamingId]);

  function enterRename(session: TerminalTabDescriptor) {
    if (!renameEnabled) return;
    cancelRenameRef.current = false;
    setRenamingId(session.id);
    setRenameValue(session.label);
  }

  function focusTrigger(id: string) {
    const safeId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
    queueMicrotask(() => {
      document.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${safeId}"]`)?.focus();
    });
  }

  function endRename(id: string) {
    if (!cancelRenameRef.current) onRename?.(id, renameValue.trim());
    cancelRenameRef.current = false;
    setRenamingId(null);
    setRenameValue('');
    focusTrigger(id);
  }

  const rowRef = useRef<HTMLDivElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const [tabReorderBounds, setTabReorderBounds] = useState<TabReorderBounds | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const reorderEnabled = onReorder != null;
  const reorderModifiers = [createTabReorderModifier(tabReorderBounds)];
  const activeTabScrollKey =
    activeSessionId === ''
      ? null
      : `${activeSessionId}\u0000${sessions.map((session) => session.id).join('\u0000')}`;

  useEffect(() => {
    if (activeTabScrollKey === null) return;
    const [activeId] = activeTabScrollKey.split('\u0000', 1);
    const safeId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(activeId) : activeId;
    tabListRef.current
      ?.querySelector<HTMLElement>(`[data-tab-id="${safeId}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabScrollKey]);

  function handleDragStart() {
    setTabReorderBounds(measureTabReorderBounds(rowRef.current, TERMINAL_TAB_SORTABLE_SELECTOR));
    onDragActiveChange?.(true);
  }
  function handleDragEnd(event: DragEndEvent) {
    setTabReorderBounds(null);
    onDragActiveChange?.(false);
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    if (!overId || activeId === overId) return;
    const ids = sessions.map((session) => session.id);
    const from = ids.indexOf(activeId);
    const to = ids.indexOf(overId);
    if (from < 0 || to < 0 || from === to) return;
    onReorder?.(arrayMove(ids, from, to));
  }
  function handleDragCancel() {
    setTabReorderBounds(null);
    onDragActiveChange?.(false);
  }
  return (
    <Tabs
      value={activeSessionId}
      onValueChange={onSelect}
      className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)}
    >
      <BottomTerminalPlacementMenu onMoveRight={onMoveRight}>
        <div
          ref={rowRef}
          data-terminal-tab-row=""
          data-electron-drag={draggable ? '' : undefined}
          className={cn(
            'flex shrink-0 flex-row items-center gap-1 px-1.5 py-1',
            rightEdge && reserveRightRevealTabGutter && 'pr-9',
            draggable &&
              'h-[62px] [-webkit-app-region:drag] pr-[22px] pl-[calc(var(--ok-titlebar-reserve-left,1rem)+0.75rem)]',
          )}
        >
          <DndContext
            sensors={sensors}
            autoScroll={TAB_REORDER_AUTO_SCROLL}
            collisionDetection={tabRunCollisionDetection}
            modifiers={reorderModifiers}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
            accessibility={{
              container: typeof document !== 'undefined' ? document.body : undefined,
            }}
          >
            <SortableContext
              items={sessions.map((session) => session.id)}
              strategy={horizontalListSortingStrategy}
            >
              {}
              <div
                onWheel={scrollTabStripOnWheel}
                className={cn(
                  'grid h-auto w-fit max-w-full min-w-0 grid-flow-col items-center justify-start gap-0.5 overflow-x-auto overflow-y-hidden [grid-auto-columns:max-content] [scrollbar-width:none] scroll-fade-mask-x',
                  draggable && '[-webkit-app-region:no-drag]',
                )}
              >
                <TabsList
                  ref={tabListRef}
                  variant="line"
                  aria-label={sessionKind === 'agent' ? t`Agent chats` : t`Terminal sessions`}
                  className="contents"
                >
                  {sessions.map((session, index) => {
                    const isActive = session.id === activeSessionId;
                    const isRenaming = renamingId === session.id;
                    return (
                      <SortableTerminalTab
                        key={session.id}
                        id={session.id}
                        disabled={!reorderEnabled || renamingId != null}
                      >
                        {({ setNodeRef, listeners, style }) => (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <TabsTrigger
                                ref={setNodeRef}
                                value={session.id}
                                data-terminal-tab-sortable=""
                                data-tab-id={session.id}
                                style={{ ...style, gridColumn: index + 1, gridRow: 1 }}
                                {...listeners}
                                onMouseEnter={() => setHoveredId(session.id)}
                                onMouseLeave={() => setHoveredId(null)}
                                onClick={(event) => {
                                  if (event.detail >= 2) return;
                                  onTabActivate?.(session.id);
                                }}
                                onDoubleClick={() => enterRename(session)}
                                onKeyDown={(event) => {
                                  if (event.key === 'F2') {
                                    event.preventDefault();
                                    enterRename(session);
                                  }
                                }}
                                className={cn(
                                  'h-7 flex-none gap-1.5 rounded-md py-0 pr-7 pl-2 text-xs transition-colors motion-reduce:transition-none',
                                  isActive ? 'bg-muted' : 'hover:bg-muted/50',
                                  isRenaming && 'w-40 opacity-0',
                                  draggable && '[-webkit-app-region:no-drag]',
                                )}
                              >
                                {session.icon}
                                <span className="max-w-40 truncate">{session.label}</span>
                              </TabsTrigger>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" sideOffset={8}>
                              {session.label}
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </SortableTerminalTab>
                    );
                  })}
                </TabsList>
                <div className="contents">
                  {sessions.map((session, index) => {
                    const isActive = session.id === activeSessionId;
                    if (renamingId === session.id) {
                      return (
                        <InputGroup
                          key={session.id}
                          style={{ gridColumn: index + 1, gridRow: 1 }}
                          className={cn(
                            'z-20 h-7 w-40 rounded-md border-0 bg-transparent dark:bg-transparent',
                            draggable && '[-webkit-app-region:no-drag]',
                          )}
                        >
                          <InputGroupInput
                            ref={renameInputRef}
                            value={renameValue}
                            aria-label={t`Rename ${session.label}`}
                            data-testid="terminal-tab-rename-input"
                            className="h-7 px-2 text-xs"
                            onChange={(event) => setRenameValue(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                renameInputRef.current?.blur();
                              } else if (event.key === 'Escape') {
                                event.preventDefault();
                                cancelRenameRef.current = true;
                                renameInputRef.current?.blur();
                              }
                            }}
                            onBlur={() => endRename(session.id)}
                          />
                        </InputGroup>
                      );
                    }
                    return (
                      <Button
                        key={session.id}
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t`Close ${session.label}`}
                        tabIndex={isActive ? 0 : -1}
                        style={{ gridColumn: index + 1, gridRow: 1 }}
                        className={cn(
                          'z-20 mr-0.5 justify-self-end text-muted-foreground opacity-0 transition-opacity hover:text-foreground hover:opacity-100 focus-visible:opacity-100',
                          (isActive || hoveredId === session.id) && 'opacity-100',
                          tabReorderBounds != null && 'pointer-events-none opacity-0',
                          draggable && '[-webkit-app-region:no-drag]',
                        )}
                        onMouseEnter={() => setHoveredId(session.id)}
                        onMouseLeave={() => setHoveredId(null)}
                        onClick={(event) => {
                          event.stopPropagation();
                          onClose(session.id);
                        }}
                      >
                        <XIcon aria-hidden="true" />
                      </Button>
                    );
                  })}
                </div>
              </div>
            </SortableContext>
          </DndContext>
          {}
          {newButton != null ? (
            <div className={cn('shrink-0', draggable && '[-webkit-app-region:no-drag]')}>
              {newButton}
            </div>
          ) : null}
          {}
          <div className="flex-1" />
          {}
          {trailingControls != null ? (
            <div className={cn('shrink-0', draggable && '[-webkit-app-region:no-drag]')}>
              {trailingControls}
            </div>
          ) : null}
          {sessionKind === 'terminal' && edge != null && onPlacementChange != null ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={placementLabel}
                  className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                  onClick={() => onPlacementChange(placementTarget)}
                >
                  {rightEdge ? (
                    <PanelBottomIcon aria-hidden="true" />
                  ) : (
                    <PanelRightIcon aria-hidden="true" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={8}>
                {placementLabel}
              </TooltipContent>
            </Tooltip>
          ) : null}
          {onCollapse != null ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={
                    sessionKind === 'terminal' ? t`Collapse Terminal` : t`Collapse agent panel`
                  }
                  className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                  onClick={onCollapse}
                >
                  {}
                  {rightEdge ? (
                    <ChevronRightIcon aria-hidden="true" />
                  ) : (
                    <ChevronDownIcon aria-hidden="true" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={8}>
                {sessionKind === 'terminal' ? (
                  <Trans>Collapse Terminal</Trans>
                ) : (
                  <Trans>Collapse agent panel</Trans>
                )}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </BottomTerminalPlacementMenu>
      {children}
    </Tabs>
  );
}
