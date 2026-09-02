import { type MouseEvent as ReactMouseEvent, useEffect, useRef } from 'react';

interface UseSidebarResizeProps {
  direction?: 'left' | 'right';
  currentWidth: string;
  onResize: (width: string) => void;
  onToggle?: () => void;
  isCollapsed?: boolean;
  minResizeWidth?: string;
  maxResizeWidth?: string;
  enableAutoCollapse?: boolean;
  autoCollapseThreshold?: number;
  expandThreshold?: number;
  enableDrag?: boolean;
  setIsDraggingRail?: (isDragging: boolean) => void;
  widthCookieName?: string;
  widthCookieMaxAge?: number;
  isNested?: boolean;
  enableToggle?: boolean;
}

interface WidthUnit {
  value: number;
  unit: 'rem' | 'px';
}

function parseWidth(width: string): WidthUnit {
  const unit = width.endsWith('rem') ? 'rem' : 'px';
  const value = Number.parseFloat(width);
  return { value, unit };
}

function toPx(width: string): number {
  const { value, unit } = parseWidth(width);
  return unit === 'rem' ? value * 16 : value;
}

function formatWidth(value: number, unit: 'rem' | 'px'): string {
  return `${unit === 'rem' ? value.toFixed(1) : Math.round(value)}${unit}`;
}

const WIDTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

export function useSidebarResize({
  direction = 'right',
  currentWidth,
  onResize,
  onToggle,
  isCollapsed = false,
  minResizeWidth = '14rem',
  maxResizeWidth = '24rem',
  enableToggle = true,
  enableAutoCollapse = true,
  autoCollapseThreshold = 1.5,
  expandThreshold = 0.2,
  enableDrag = true,
  setIsDraggingRail = () => {},
  widthCookieName,
  widthCookieMaxAge = WIDTH_COOKIE_MAX_AGE,
  isNested = false,
}: UseSidebarResizeProps) {
  const dragRef = useRef<HTMLButtonElement>(null);
  const startWidth = useRef(0);
  const startX = useRef(0);
  const isDragging = useRef(false);
  const isInteractingWithRail = useRef(false);
  const lastDragDirection = useRef<'expand' | 'collapse' | null>(null);
  const lastTogglePoint = useRef(0);
  const toggleCooldown = useRef(false);
  const lastToggleTime = useRef(0);
  const dragDistanceFromToggle = useRef(0);
  const railRect = useRef<DOMRect | null>(null);
  const currentWidthRef = useRef(currentWidth);
  const isCollapsedRef = useRef(isCollapsed);
  useEffect(() => {
    currentWidthRef.current = currentWidth;
  }, [currentWidth]);
  useEffect(() => {
    isCollapsedRef.current = isCollapsed;
  }, [isCollapsed]);

  const minWidthPx = toPx(minResizeWidth);
  const maxWidthPx = toPx(maxResizeWidth);

  function handleMouseDown(e: ReactMouseEvent) {
    if (!enableDrag) {
      return;
    }
    isInteractingWithRail.current = true;

    const currentWidthPx = isCollapsedRef.current ? 0 : toPx(currentWidthRef.current);
    startWidth.current = currentWidthPx;
    startX.current = e.clientX;
    lastTogglePoint.current = e.clientX;
    lastDragDirection.current = null;
    toggleCooldown.current = false;
    lastToggleTime.current = 0;
    dragDistanceFromToggle.current = 0;

    railRect.current = isNested && dragRef.current ? dragRef.current.getBoundingClientRect() : null;

    e.preventDefault();
  }

  useEffect(() => {
    function persistWidth(width: string) {
      if (widthCookieName) {
        // biome-ignore lint/suspicious/noDocumentCookie: shadcn sidebar pattern
        document.cookie = `${widthCookieName}=${width}; path=/; max-age=${widthCookieMaxAge}`;
      }
    }
    function isIncreasingWidth(currentX: number, referenceX: number): boolean {
      return direction === 'left' ? currentX < referenceX : currentX > referenceX;
    }
    function calculateWidth(
      e: MouseEvent,
      initialX: number,
      initialWidth: number,
      currentRailRect: DOMRect | null,
    ): number {
      if (isNested && currentRailRect) {
        const deltaX = e.clientX - initialX;

        if (direction === 'left') {
          return initialWidth - deltaX;
        }
        return initialWidth + deltaX;
      }
      if (direction === 'left') {
        return window.innerWidth - e.clientX;
      }
      return e.clientX;
    }
    function handleMouseMove(e: MouseEvent) {
      if (!isInteractingWithRail.current) return;

      const deltaX = Math.abs(e.clientX - startX.current);
      if (!isDragging.current && deltaX > 5) {
        isDragging.current = true;
        setIsDraggingRail(true);
      }

      if (isDragging.current) {
        const { unit } = parseWidth(currentWidthRef.current);

        let currentRailRect = railRect.current;
        if (isNested && dragRef.current) {
          currentRailRect = dragRef.current.getBoundingClientRect();
        }

        const currentDragDirection = isIncreasingWidth(e.clientX, lastTogglePoint.current)
          ? 'expand'
          : 'collapse';

        if (lastDragDirection.current !== currentDragDirection) {
          lastDragDirection.current = currentDragDirection;
        }

        dragDistanceFromToggle.current = Math.abs(e.clientX - lastTogglePoint.current);

        const now = Date.now();
        if (toggleCooldown.current && now - lastToggleTime.current > 200) {
          toggleCooldown.current = false;
        }

        if (!toggleCooldown.current) {
          if (enableAutoCollapse && onToggle && !isCollapsedRef.current) {
            const currentDragWidth = calculateWidth(
              e,
              startX.current,
              startWidth.current,
              currentRailRect,
            );

            let shouldCollapse = false;

            if (autoCollapseThreshold <= 1.0) {
              shouldCollapse = currentDragWidth <= minWidthPx * autoCollapseThreshold;
            } else {
              if (currentDragWidth <= minWidthPx) {
                const extraDragNeeded = minWidthPx * (autoCollapseThreshold - 1.0);

                const distanceBeyondMin = minWidthPx - currentDragWidth;

                shouldCollapse = distanceBeyondMin >= extraDragNeeded;
              }
            }

            if (currentDragDirection === 'collapse' && shouldCollapse) {
              onToggle();
              lastTogglePoint.current = e.clientX;
              toggleCooldown.current = true;
              lastToggleTime.current = now;
              return;
            }
          }

          if (
            onToggle &&
            isCollapsedRef.current &&
            currentDragDirection === 'expand' &&
            dragDistanceFromToggle.current > minWidthPx * expandThreshold
          ) {
            onToggle();

            const initialWidth = calculateWidth(
              e,
              startX.current,
              startWidth.current,
              currentRailRect,
            );

            const clampedWidth = Math.max(minWidthPx, Math.min(maxWidthPx, initialWidth));

            const formattedWidth = formatWidth(
              unit === 'rem' ? clampedWidth / 16 : clampedWidth,
              unit,
            );
            onResize(formattedWidth);
            persistWidth(formattedWidth);

            lastTogglePoint.current = e.clientX;
            toggleCooldown.current = true;
            lastToggleTime.current = now;
            return;
          }
        }

        if (isCollapsedRef.current) {
          return;
        }

        const newWidthPx = calculateWidth(e, startX.current, startWidth.current, currentRailRect);

        const clampedWidthPx = Math.max(minWidthPx, Math.min(maxWidthPx, newWidthPx));

        const newWidth = unit === 'rem' ? clampedWidthPx / 16 : clampedWidthPx;

        const formattedWidth = formatWidth(newWidth, unit);
        onResize(formattedWidth);
        persistWidth(formattedWidth);
      }
    }

    function handleMouseUp() {
      if (!isInteractingWithRail.current) return;

      if (!isDragging.current && onToggle && enableToggle) {
        onToggle();
      }

      isDragging.current = false;
      isInteractingWithRail.current = false;
      lastDragDirection.current = null;
      lastTogglePoint.current = 0;
      toggleCooldown.current = false;
      lastToggleTime.current = 0;
      dragDistanceFromToggle.current = 0;
      railRect.current = null;
      setIsDraggingRail(false);
    }

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [
    onResize,
    onToggle,
    setIsDraggingRail,
    minWidthPx,
    maxWidthPx,
    isNested,
    enableAutoCollapse,
    autoCollapseThreshold,
    expandThreshold,
    enableToggle,
    widthCookieName,
    widthCookieMaxAge,
    direction,
  ]);

  return {
    dragRef,
    isDragging,
    handleMouseDown,
  };
}
