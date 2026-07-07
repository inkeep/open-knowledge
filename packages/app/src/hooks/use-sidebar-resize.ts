/**
 * Copied from https://github.com/lumpinif/shadcn-resizable-sidebar
 */
import { type MouseEvent as ReactMouseEvent, useEffect, useRef } from 'react';

interface UseSidebarResizeProps {
  /**
   * Direction of the resize handle
   * - 'left': Handle is on left side (for right-positioned panels)
   * - 'right': Handle is on right side (for left-positioned panels)
   */
  direction?: 'left' | 'right';
  /**
   * Current width of the panel
   */
  currentWidth: string;
  /**
   * Callback to update width when resizing
   */
  onResize: (width: string) => void;
  /**
   * Callback to toggle panel visibility
   */
  onToggle?: () => void;
  /**
   * Whether the panel is currently collapsed
   */
  isCollapsed?: boolean;
  /**
   * Minimum resize width
   */
  minResizeWidth?: string;
  /**
   * Maximum resize width
   */
  maxResizeWidth?: string;
  /**
   * Whether to enable auto-collapse when dragged below threshold
   */
  enableAutoCollapse?: boolean;
  /**
   * Auto-collapse threshold as percentage of minResizeWidth
   * A value of 1.0 means the panel will collapse when dragged to minResizeWidth
   * A value of 0.5 means the panel will collapse when dragged to 50% of minResizeWidth
   * A value of 1.5 means the panel will collapse when dragged to 50% beyond minResizeWidth
   * Can be any positive number, not limited to the range 0.0-1.0
   */
  autoCollapseThreshold?: number;
  /**
   * Threshold to expand when dragging in opposite direction (0.0-1.0)
   * Percentage of distance needed to drag back to expand
   */
  expandThreshold?: number;
  /**
   * Whether to enable drag functionality
   */
  enableDrag?: boolean;
  /**
   * Callback to update dragging rail state
   */
  setIsDraggingRail?: (isDragging: boolean) => void;
  /**
   * Cookie name for persisting width
   */
  widthCookieName?: string;
  /**
   * Cookie max age in seconds
   */
  widthCookieMaxAge?: number;
  /**
   * Whether this is a nested sidebar (not at the edge of the screen)
   */
  isNested?: boolean;
  /**
   * Whether to enable toggle functionality
   */
  enableToggle?: boolean;
}

interface WidthUnit {
  value: number;
  unit: 'rem' | 'px';
}

/**
 * Parse width string into value and unit
 */
function parseWidth(width: string): WidthUnit {
  const unit = width.endsWith('rem') ? 'rem' : 'px';
  const value = Number.parseFloat(width);
  return { value, unit };
}

/**
 * Convert any width to pixels for calculations
 */
function toPx(width: string): number {
  const { value, unit } = parseWidth(width);
  return unit === 'rem' ? value * 16 : value;
}

/**
 * Format width value with unit
 */
function formatWidth(value: number, unit: 'rem' | 'px'): string {
  return `${unit === 'rem' ? value.toFixed(1) : Math.round(value)}${unit}`;
}

const WIDTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

/**
 * A versatile hook for handling resizable sidebar (or inset) panels
 * Works for both sidebar (left side) and artifacts (right side) panels
 * Supports VS Code-like continuous drag to collapse/expand
 */
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
  autoCollapseThreshold = 1.5, // Default to collapsing at minWidth + 50%
  expandThreshold = 0.2,
  enableDrag = true,
  setIsDraggingRail = () => {},
  widthCookieName,
  widthCookieMaxAge = WIDTH_COOKIE_MAX_AGE, // 1 week default
  isNested = false,
}: UseSidebarResizeProps) {
  // Refs for tracking drag state
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

  // Memoize min/max width calculations for performance
  const minWidthPx = toPx(minResizeWidth);
  const maxWidthPx = toPx(maxResizeWidth);

  // Handle mouse down on resize handle
  function handleMouseDown(e: ReactMouseEvent) {
    if (!enableDrag) {
      // Bail BEFORE setting `isInteractingWithRail`. Otherwise the document-
      // level mousemove handler (which gates on that ref) proceeds with
      // uninitialised `startX` / `dragDistanceFromToggle` and the
      // drag-to-expand-when-collapsed path can fire `onToggle()` from a
      // pointer trajectory the caller meant to disable.
      return;
    }
    isInteractingWithRail.current = true;

    // Store initial state
    const currentWidthPx = isCollapsedRef.current ? 0 : toPx(currentWidthRef.current);
    startWidth.current = currentWidthPx;
    startX.current = e.clientX;
    lastTogglePoint.current = e.clientX;
    lastDragDirection.current = null;
    toggleCooldown.current = false;
    lastToggleTime.current = 0;
    dragDistanceFromToggle.current = 0;

    // Store the rail element's position for nested sidebars
    railRect.current = isNested && dragRef.current ? dragRef.current.getBoundingClientRect() : null;

    e.preventDefault();
  }

  // Handle mouse movement and resizing
  useEffect(() => {
    // Persist width to cookie if cookie name is provided
    function persistWidth(width: string) {
      if (widthCookieName) {
        // biome-ignore lint/suspicious/noDocumentCookie: shadcn sidebar pattern
        document.cookie = `${widthCookieName}=${width}; path=/; max-age=${widthCookieMaxAge}`;
      }
    }
    // Helper function to determine if width is increasing based on direction and mouse movement
    function isIncreasingWidth(currentX: number, referenceX: number): boolean {
      return direction === 'left'
        ? currentX < referenceX // For left-positioned handle, moving left increases width
        : currentX > referenceX; // For right-positioned handle, moving right increases width
    }
    // Helper function to calculate width based on mouse position and direction
    function calculateWidth(
      e: MouseEvent,
      initialX: number,
      initialWidth: number,
      currentRailRect: DOMRect | null,
    ): number {
      if (isNested && currentRailRect) {
        // For nested sidebars, use the delta from start position for precise tracking
        const deltaX = e.clientX - initialX;

        if (direction === 'left') {
          // For left-positioned handle (right panel)
          // Width increases as mouse moves left (negative deltaX)
          return initialWidth - deltaX;
        }
        // For right-positioned handle (left panel)
        // Width increases as mouse moves right (positive deltaX)
        return initialWidth + deltaX;
      }
      // For standard sidebars at window edges
      if (direction === 'left') {
        // For left-positioned handle (right panel)
        return window.innerWidth - e.clientX;
      }
      // For right-positioned handle (left panel)
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
        // Get unit for width calculations
        const { unit } = parseWidth(currentWidthRef.current);

        // Get current rail position for ultra-precise tracking
        let currentRailRect = railRect.current;
        if (isNested && dragRef.current) {
          currentRailRect = dragRef.current.getBoundingClientRect();
        }

        // Determine current drag direction
        const currentDragDirection = isIncreasingWidth(e.clientX, lastTogglePoint.current)
          ? 'expand'
          : 'collapse';

        // Update direction tracking
        if (lastDragDirection.current !== currentDragDirection) {
          lastDragDirection.current = currentDragDirection;
        }

        // Calculate distance from last toggle point
        dragDistanceFromToggle.current = Math.abs(e.clientX - lastTogglePoint.current);

        // Check for toggle cooldown (prevent rapid toggling)
        const now = Date.now();
        if (toggleCooldown.current && now - lastToggleTime.current > 200) {
          toggleCooldown.current = false;
        }

        // Handle toggling between collapsed and expanded states
        if (!toggleCooldown.current) {
          // Handle collapsing when expanded
          if (enableAutoCollapse && onToggle && !isCollapsedRef.current) {
            // Calculate precise width based on mouse position
            const currentDragWidth = calculateWidth(
              e,
              startX.current,
              startWidth.current,
              currentRailRect,
            );

            // Determine if we should collapse based on threshold
            let shouldCollapse = false;

            if (autoCollapseThreshold <= 1.0) {
              // For thresholds <= 1.0, collapse when width is below minWidth * threshold
              shouldCollapse = currentDragWidth <= minWidthPx * autoCollapseThreshold;
            } else {
              // For thresholds > 1.0, we need to drag beyond minWidth by a certain amount
              if (currentDragWidth <= minWidthPx) {
                // Calculate how much beyond minWidth we need to drag
                const extraDragNeeded = minWidthPx * (autoCollapseThreshold - 1.0);

                // Only collapse if we've dragged far enough beyond minWidth
                const distanceBeyondMin = minWidthPx - currentDragWidth;

                shouldCollapse = distanceBeyondMin >= extraDragNeeded;
              }
            }

            if (currentDragDirection === 'collapse' && shouldCollapse) {
              onToggle(); // Collapse
              lastTogglePoint.current = e.clientX;
              toggleCooldown.current = true;
              lastToggleTime.current = now;
              return;
            }
          }

          // Handle expanding when collapsed
          if (
            onToggle &&
            isCollapsedRef.current &&
            currentDragDirection === 'expand' &&
            dragDistanceFromToggle.current > minWidthPx * expandThreshold
          ) {
            onToggle(); // Expand

            // Calculate initial width based on exact mouse position
            const initialWidth = calculateWidth(
              e,
              startX.current,
              startWidth.current,
              currentRailRect,
            );

            // Clamp to min/max
            const clampedWidth = Math.max(minWidthPx, Math.min(maxWidthPx, initialWidth));

            // Set initial width when expanding
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

        // Skip width calculations if panel is collapsed
        if (isCollapsedRef.current) {
          return;
        }

        // Calculate new width based on mouse position and drag direction
        const newWidthPx = calculateWidth(e, startX.current, startWidth.current, currentRailRect);

        // Clamp width between min and max
        const clampedWidthPx = Math.max(minWidthPx, Math.min(maxWidthPx, newWidthPx));

        // Convert to the target unit
        const newWidth = unit === 'rem' ? clampedWidthPx / 16 : clampedWidthPx;

        // Format and update width
        const formattedWidth = formatWidth(newWidth, unit);
        onResize(formattedWidth);
        persistWidth(formattedWidth);
      }
    }

    function handleMouseUp() {
      if (!isInteractingWithRail.current) return;

      // Handle click (not drag) behavior
      if (!isDragging.current && onToggle && enableToggle) {
        onToggle();
      }

      // Reset all state
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
