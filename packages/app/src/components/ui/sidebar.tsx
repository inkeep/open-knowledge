import { detectEmbeddedHostFromBrowser } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { cva, type VariantProps } from 'class-variance-authority';
import { PanelLeft, PanelLeftOpen } from 'lucide-react';
import { Slot } from 'radix-ui';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSidebarResize } from '@/hooks/use-sidebar-resize';
import { formatShortcutLabel, matchesKeyboardShortcut } from '@/lib/keyboard-shortcuts';
import { isOverlayLayerOpen } from '@/lib/overlay-layers';
import { LEFT_COLLAPSE_THRESHOLD, resolvePartition } from '@/lib/sidebar-partition';
import { applyToggle, readPins, resolveEffectiveState } from '@/lib/sidebar-pin-store';
import { cn } from '@/lib/utils';

const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const SIDEBAR_WIDTH = '18rem';
const SIDEBAR_WIDTH_ICON = '3rem';
const SIDEBAR_ID = 'app-file-sidebar';
const MIN_SIDEBAR_WIDTH = '14.625rem';
const MAX_SIDEBAR_WIDTH = '32rem';
const SIDEBAR_WIDTH_COOKIE_NAME = 'sidebar_width';
const SIDEBAR_WIDTH_VALUE_PATTERN = /^\d+(?:\.\d+)?(?:rem|px)$/;

type OpenHandler = React.Dispatch<React.SetStateAction<boolean>>;

type SidebarContextProps = {
  state: 'expanded' | 'collapsed';
  open: boolean;
  setOpen: OpenHandler;
  toggleSidebar: () => void;
  width: string;
  setWidth: React.Dispatch<React.SetStateAction<string>>;
  isDraggingRail: boolean;
  setIsDraggingRail: React.Dispatch<React.SetStateAction<boolean>>;
  showPushPulse: boolean;
  setShowPushPulse: React.Dispatch<React.SetStateAction<boolean>>;
  notifySidebarFileSelected: () => void;
};

const SidebarContext = React.createContext<SidebarContextProps | null>(null);

function getInitialSidebarWidth(defaultWidth: string) {
  if (typeof document === 'undefined') return defaultWidth;

  const savedWidth = document.cookie
    .split('; ')
    .find((row) => row.startsWith(`${SIDEBAR_WIDTH_COOKIE_NAME}=`))
    ?.split('=')[1];

  if (!savedWidth) return defaultWidth;

  let decodedWidth: string;
  try {
    decodedWidth = decodeURIComponent(savedWidth);
  } catch {
    return defaultWidth;
  }
  return SIDEBAR_WIDTH_VALUE_PATTERN.test(decodedWidth) ? decodedWidth : defaultWidth;
}

function useSidebar() {
  const context = React.use(SidebarContext);
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider.');
  }

  return context;
}

function SidebarProvider({
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  defaultWidth = SIDEBAR_WIDTH,
  ...props
}: React.ComponentProps<'div'> & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultWidth?: string;
}) {
  const [embeddedHost] = React.useState(() => detectEmbeddedHostFromBrowser());

  const [partition, setPartition] = React.useState(() =>
    resolvePartition(embeddedHost, window.innerWidth, 'left'),
  );

  const [width, setWidth] = React.useState(() => getInitialSidebarWidth(defaultWidth));
  const [isDraggingRail, setIsDraggingRail] = React.useState(false);
  const [showPushPulse, setShowPushPulse] = React.useState(false);

  const [_open, _setOpen] = React.useState(() => {
    const pins = readPins();
    const p = resolvePartition(embeddedHost, window.innerWidth, 'left');
    return resolveEffectiveState('left', p, pins) === 'open';
  });
  const open = openProp ?? _open;

  const setOpen: OpenHandler = (value) => {
    const openState = typeof value === 'function' ? value(openRef.current) : value;
    if (setOpenProp) {
      setOpenProp(openState);
    } else {
      _setOpen(openState);
    }
    applyToggle('left', partition, openState ? 'open' : 'collapsed');
  };

  function toggleSidebar() {
    setOpen((prev) => !prev);
  }

  const openRef = React.useRef(open);
  React.useLayoutEffect(() => {
    openRef.current = open;
  });

  function notifySidebarFileSelected() {
    if (window.innerWidth >= LEFT_COLLAPSE_THRESHOLD) return;
    if (!openRef.current) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setShowPushPulse(true);
  }

  React.useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${LEFT_COLLAPSE_THRESHOLD}px)`);
    const onChange = () => {
      const newPartition = resolvePartition(embeddedHost, window.innerWidth, 'left');
      setPartition(newPartition);
      const pins = readPins();
      const effective = resolveEffectiveState('left', newPartition, pins);
      _setOpen(effective === 'open');
    };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [embeddedHost]);

  React.useLayoutEffect(() => {
    if (open) return;
    const sidebarEl = document.getElementById(SIDEBAR_ID);
    if (!sidebarEl?.contains(document.activeElement)) return;
    const trigger = document.querySelector<HTMLElement>('[data-sidebar="trigger"]');
    trigger?.focus();
  }, [open]);

  React.useEffect(() => {
    if (partition === 'above' || !open) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (isOverlayLayerOpen()) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
      }
      setOpen(false);
    };
    window.addEventListener('keydown', onEscape, { capture: true });
    return () => window.removeEventListener('keydown', onEscape, { capture: true });
    // biome-ignore lint/correctness/useExhaustiveDependencies: setOpen is render-bound; partition + open gate the subscription lifecycle
  }, [partition, open, setOpen]);

  React.useEffect(() => {
    if (typeof window !== 'undefined' && window.okDesktop != null) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!matchesKeyboardShortcut(event, 'toggle-files-sidebar')) return;
      if (isOverlayLayerOpen()) return;
      event.preventDefault();
      toggleSidebar();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    // biome-ignore lint/correctness/useExhaustiveDependencies: toggleSidebar is render-bound; re-subscribing keeps the handler fresh
    toggleSidebar,
  ]);

  const state = open ? 'expanded' : 'collapsed';

  return (
    <SidebarContext.Provider
      value={{
        state,
        open,
        setOpen,
        toggleSidebar,
        width,
        setWidth,
        isDraggingRail,
        setIsDraggingRail,
        showPushPulse,
        setShowPushPulse,
        notifySidebarFileSelected,
      }}
    >
      <div
        data-slot="sidebar-wrapper"
        style={
          {
            '--sidebar-width': width,
            '--sidebar-width-icon': SIDEBAR_WIDTH_ICON,
            ...style,
          } as React.CSSProperties
        }
        className={cn(
          'group/sidebar-wrapper flex min-h-svh w-full has-data-[variant=inset]:bg-sidebar',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

function Sidebar({
  side = 'left',
  variant = 'sidebar',
  collapsible = 'offcanvas',
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  side?: 'left' | 'right';
  variant?: 'sidebar' | 'floating' | 'inset';
  collapsible?: 'offcanvas' | 'icon' | 'none';
}) {
  const { t } = useLingui();
  const { state, isDraggingRail } = useSidebar();

  if (collapsible === 'none') {
    return (
      <div
        data-slot="sidebar"
        data-variant={variant}
        className={cn(
          'flex h-full w-(--sidebar-width) flex-col bg-sidebar text-sidebar-foreground',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    );
  }

  return (
    <div
      className="group peer text-sidebar-foreground"
      data-state={state}
      data-collapsible={state === 'collapsed' ? collapsible : ''}
      data-variant={variant}
      data-side={side}
      data-slot="sidebar"
      data-dragging={isDraggingRail}
    >
      <div
        data-slot="sidebar-gap"
        className={cn(
          'relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear',
          'group-data-[collapsible=offcanvas]:w-0',
          'group-data-[side=right]:rotate-180',
          variant === 'floating' || variant === 'inset'
            ? 'group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]'
            : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon)',
          'group-data-[dragging=true]:duration-0! group-data-[dragging=true]_*:!duration-0',
        )}
      />
      <nav
        id={SIDEBAR_ID}
        aria-label={t`File sidebar`}
        data-slot="sidebar-container"
        data-side={side}
        className={cn(
          'fixed inset-y-0 z-10 flex h-svh w-(--sidebar-width) transition-[left,right,width] duration-200 ease-linear motion-reduce:transition-none motion-reduce:duration-0 data-[side=left]:left-0 data-[side=left]:group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)] data-[side=right]:right-0 data-[side=right]:group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]',
          variant === 'floating' || variant === 'inset'
            ? 'p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]'
            : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l',
          'group-data-[dragging=true]:duration-0! group-data-[dragging=true]_*:!duration-0',
          className,
        )}
        {...props}
      >
        <div
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
          className="flex size-full flex-col bg-sidebar group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:shadow-sm group-data-[variant=floating]:ring-1 group-data-[variant=floating]:ring-sidebar-border"
        >
          {children}
        </div>
      </nav>
    </div>
  );
}

function SidebarTrigger({ className, onClick, ...props }: React.ComponentProps<typeof Button>) {
  const { t } = useLingui();
  const { toggleSidebar, state } = useSidebar();
  const sidebarShortcutLabel = formatShortcutLabel('toggle-files-sidebar');

  return (
    <Button
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon-sm"
      aria-expanded={state === 'expanded'}
      aria-controls={SIDEBAR_ID}
      aria-label={
        state === 'expanded'
          ? t`Hide Files (${sidebarShortcutLabel})`
          : t`Show Files (${sidebarShortcutLabel})`
      }
      className={cn(className)}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      {...props}
    >
      {state === 'expanded' ? <PanelLeft /> : <PanelLeftOpen />}
    </Button>
  );
}

function SidebarRail({
  className,
  enableDrag = true,
  enableToggle = true,
  onMouseDown,
  ...props
}: React.ComponentProps<'button'> & {
  enableDrag?: boolean;
  enableToggle?: boolean;
}) {
  const { t } = useLingui();
  const { toggleSidebar, setWidth, state, width, setIsDraggingRail } = useSidebar();
  const { dragRef, handleMouseDown } = useSidebarResize({
    direction: 'right',
    enableDrag,
    enableToggle,
    onResize: setWidth,
    onToggle: toggleSidebar,
    currentWidth: width,
    isCollapsed: state === 'collapsed',
    minResizeWidth: MIN_SIDEBAR_WIDTH,
    maxResizeWidth: MAX_SIDEBAR_WIDTH,
    setIsDraggingRail,
    widthCookieName: SIDEBAR_WIDTH_COOKIE_NAME,
    widthCookieMaxAge: SIDEBAR_COOKIE_MAX_AGE,
  });

  return (
    <button
      ref={dragRef}
      data-sidebar="rail"
      data-slot="sidebar-rail"
      aria-label={state === 'expanded' ? t`Hide Files` : t`Show Files`}
      tabIndex={-1}
      onMouseDown={(event) => {
        onMouseDown?.(event);
        if (!event.defaultPrevented) {
          handleMouseDown(event);
        }
      }}
      title={state === 'expanded' ? t`Hide Files` : t`Show Files`}
      className={cn(
        'absolute inset-y-0 z-20 hidden w-4 transition-all ease-linear group-data-[side=left]:-right-4 group-data-[side=right]:left-0 after:absolute after:inset-y-0 after:start-1/2 after:w-[2px] hover:after:bg-sidebar-border sm:flex ltr:-translate-x-1/2 rtl:-translate-x-1/2',
        'in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize',
        '[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize',
        'group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full hover:group-data-[collapsible=offcanvas]:bg-sidebar',
        '[[data-side=left][data-collapsible=offcanvas]_&]:-right-2',
        '[[data-side=right][data-collapsible=offcanvas]_&]:-left-2',
        'md:group-data-[variant=inset]:after:inset-y-5',
        className,
      )}
      {...props}
    />
  );
}

function SidebarInset({ className, onAnimationEnd, ...props }: React.ComponentProps<'main'>) {
  const { showPushPulse, setShowPushPulse } = useSidebar();

  const handleAnimationEnd: React.AnimationEventHandler<HTMLElement> = (event) => {
    onAnimationEnd?.(event);
    if (event.animationName === 'sidebar-push-pulse') {
      setShowPushPulse(false);
    }
  };

  return (
    <main
      data-slot="sidebar-inset"
      data-push-pulse={showPushPulse ? '' : undefined}
      onAnimationEnd={handleAnimationEnd}
      className={cn(
        'relative flex w-full flex-1 flex-col bg-background peer-data-[variant=inset]:m-2 peer-data-[variant=inset]:ml-0 peer-data-[variant=inset]:rounded-xl peer-data-[variant=inset]:shadow-sm peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2',
        className,
      )}
      {...props}
    />
  );
}

function SidebarInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return (
    <Input
      data-slot="sidebar-input"
      data-sidebar="input"
      className={cn('h-8 w-full bg-background shadow-none', className)}
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-header"
      data-sidebar="header"
      className={cn('flex flex-col gap-2 p-2', className)}
      {...props}
    />
  );
}

function SidebarFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-footer"
      data-sidebar="footer"
      className={cn('flex flex-col gap-2 p-2', className)}
      {...props}
    />
  );
}

function SidebarSeparator({ className, ...props }: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="sidebar-separator"
      data-sidebar="separator"
      className={cn('mx-2 w-auto bg-sidebar-border', className)}
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn(
        'no-scrollbar flex min-h-0 flex-1 flex-col gap-0 overflow-auto group-data-[collapsible=icon]:overflow-hidden',
        className,
      )}
      {...props}
    />
  );
}

function SidebarGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-group"
      data-sidebar="group"
      className={cn('relative flex w-full min-w-0 flex-col p-2', className)}
      {...props}
    />
  );
}

function SidebarGroupLabel({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<'div'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'div';

  return (
    <Comp
      data-slot="sidebar-group-label"
      data-sidebar="group-label"
      className={cn(
        'flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 ring-sidebar-ring outline-hidden transition-[margin,opacity] duration-200 ease-linear group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0 focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0',
        className,
      )}
      {...props}
    />
  );
}

function SidebarGroupAction({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="sidebar-group-action"
      data-sidebar="group-action"
      className={cn(
        'absolute top-3.5 right-3 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground ring-sidebar-ring outline-hidden transition-transform group-data-[collapsible=icon]:hidden after:absolute after:-inset-2 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 md:after:hidden [&>svg]:size-4 [&>svg]:shrink-0',
        className,
      )}
      {...props}
    />
  );
}

function SidebarGroupContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-group-content"
      data-sidebar="group-content"
      className={cn('w-full text-sm', className)}
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      data-slot="sidebar-menu"
      data-sidebar="menu"
      className={cn('flex w-full min-w-0 flex-col gap-0', className)}
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={cn('group/menu-item relative', className)}
      {...props}
    />
  );
}

const sidebarMenuButtonVariants = cva(
  'peer/menu-button group/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm ring-sidebar-ring outline-hidden transition-[width,height,padding] group-has-data-[sidebar=menu-action]/menu-item:pr-8 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! hover:bg-sidebar-hover hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-hover active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-open:hover:bg-sidebar-hover data-open:hover:text-sidebar-accent-foreground data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground data-active:hover:bg-sidebar-accent [&_svg]:size-4 [&_svg]:shrink-0 [&>span:last-child]:truncate',
  {
    variants: {
      variant: {
        default: 'hover:bg-sidebar-hover hover:text-sidebar-accent-foreground',
        outline:
          'bg-background shadow-[0_0_0_1px_hsl(var(--sidebar-border))] hover:bg-sidebar-hover hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_hsl(var(--sidebar-accent))]',
      },
      size: {
        default: 'h-8 text-sm',
        sm: 'h-7 text-xs',
        lg: 'h-12 text-sm group-data-[collapsible=icon]:p-0!',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  variant = 'default',
  size = 'default',
  tooltip,
  className,
  ...props
}: React.ComponentProps<'button'> & {
  asChild?: boolean;
  isActive?: boolean;
  tooltip?: string | React.ComponentProps<typeof TooltipContent>;
} & VariantProps<typeof sidebarMenuButtonVariants>) {
  const Comp = asChild ? Slot.Root : 'button';
  const { state } = useSidebar();

  const button = (
    <Comp
      data-slot="sidebar-menu-button"
      data-sidebar="menu-button"
      data-size={size}
      data-active={isActive}
      className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
      {...props}
    />
  );

  if (!tooltip) {
    return button;
  }

  if (typeof tooltip === 'string') {
    tooltip = {
      children: tooltip,
    };
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" align="center" hidden={state !== 'collapsed'} {...tooltip} />
    </Tooltip>
  );
}

function SidebarMenuAction({
  className,
  asChild = false,
  showOnHover = false,
  ...props
}: React.ComponentProps<'button'> & {
  asChild?: boolean;
  showOnHover?: boolean;
}) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="sidebar-menu-action"
      data-sidebar="menu-action"
      className={cn(
        'absolute top-1.5 right-1 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground ring-sidebar-ring outline-hidden transition-transform group-data-[collapsible=icon]:hidden peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[size=default]/menu-button:top-1.5 peer-data-[size=lg]/menu-button:top-2.5 peer-data-[size=sm]/menu-button:top-1 after:absolute after:-inset-2 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 md:after:hidden [&>svg]:size-4 [&>svg]:shrink-0',
        showOnHover &&
          'group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 peer-data-active/menu-button:text-sidebar-accent-foreground aria-expanded:opacity-100 md:opacity-0',
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenuBadge({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-menu-badge"
      data-sidebar="menu-badge"
      className={cn(
        'pointer-events-none absolute right-1 flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-xs font-medium text-sidebar-foreground tabular-nums select-none group-data-[collapsible=icon]:hidden peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[size=default]/menu-button:top-1.5 peer-data-[size=lg]/menu-button:top-2.5 peer-data-[size=sm]/menu-button:top-1 peer-data-active/menu-button:text-sidebar-accent-foreground',
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenuSkeleton({
  className,
  showIcon = false,
  ...props
}: React.ComponentProps<'div'> & {
  showIcon?: boolean;
}) {
  const [width] = React.useState(() => {
    return `${Math.floor(Math.random() * 40) + 50}%`;
  });

  return (
    <div
      data-slot="sidebar-menu-skeleton"
      data-sidebar="menu-skeleton"
      className={cn('flex h-8 items-center gap-2 rounded-md px-2', className)}
      {...props}
    >
      {showIcon && <Skeleton className="size-4 rounded-md" data-sidebar="menu-skeleton-icon" />}
      <Skeleton
        className="h-4 max-w-(--skeleton-width) flex-1"
        data-sidebar="menu-skeleton-text"
        style={
          {
            '--skeleton-width': width,
          } as React.CSSProperties
        }
      />
    </div>
  );
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      data-slot="sidebar-menu-sub"
      data-sidebar="menu-sub"
      className={cn(
        'mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-l border-sidebar-border px-2.5 py-0.5 group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenuSubItem({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot="sidebar-menu-sub-item"
      data-sidebar="menu-sub-item"
      className={cn('group/menu-sub-item relative', className)}
      {...props}
    />
  );
}

function SidebarMenuSubButton({
  asChild = false,
  size = 'md',
  isActive = false,
  className,
  ...props
}: React.ComponentProps<'a'> & {
  asChild?: boolean;
  size?: 'sm' | 'md';
  isActive?: boolean;
}) {
  const Comp = asChild ? Slot.Root : 'a';

  return (
    <Comp
      data-slot="sidebar-menu-sub-button"
      data-sidebar="menu-sub-button"
      data-size={size}
      data-active={isActive}
      className={cn(
        'flex h-7 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-md px-2 text-sidebar-foreground ring-sidebar-ring outline-hidden group-data-[collapsible=icon]:hidden hover:bg-sidebar-hover hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-hover active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[size=md]:text-sm data-[size=sm]:text-xs data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground data-active:hover:bg-sidebar-accent [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-accent-foreground',
        className,
      )}
      {...props}
    />
  );
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
};
