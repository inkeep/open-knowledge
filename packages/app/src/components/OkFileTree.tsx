/**
 * The Pierre (`@pierre/trees`) tree mount used by the skills bundle-file tree
 * (`SkillsSidebarSection.tsx`): it centralizes the colored icon set + extension
 * badges + title stamping so a tree gets them without bespoke wiring. (The main
 * Files tree `FileTree.tsx` still mounts Pierre directly with its own copy of
 * these observers — migrating it onto this component is a pending follow-up.)
 *
 * Owns the two GENERIC shadow-root decoration observers (full-path title
 * stamping + the uppercase extension badge) and the content-height reporter.
 * Does NOT own workspace-specific behavior: the caller creates the `model`
 * (via `useFileTree({ ...buildOkFileTreeOptions(...), dragAndDrop, renaming })`)
 * and passes decorations / context menu / drag handlers through the option
 * builder.
 */

import { FILE_TREE_TAG_NAME, type FileTree as PierreFileTreeModel } from '@pierre/trees';
import { type FileTreeProps, FileTree as PierreFileTree } from '@pierre/trees/react';
import {
  type CSSProperties,
  type MouseEventHandler,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
} from 'react';
import { applyExtensionBadges } from '@/components/file-tree-extension-badge';

export interface OkFileTreeProps {
  readonly model: PierreFileTreeModel;
  /**
   * Shared host ref. This component attaches it to its wrapper `<div>`; the
   * caller may hold the same ref to run additional observers off the shadow root
   * (the main tree's rename-affordance observer does this).
   */
  readonly hostRef: RefObject<HTMLDivElement | null>;
  /** Gate for the generic shadow observers — true once rows are painting. */
  readonly ready: boolean;
  readonly style: CSSProperties;
  readonly header?: ReactNode;
  /** Sizing: `flex min-h-0 flex-1 flex-col` (fill) vs `min-h-0` (+ sizeToContent). */
  readonly className?: string;
  /** Attributes forwarded onto the `<file-tree-container>` host (e.g. creation-cleared). */
  readonly hostAttrs?: Record<string, string | undefined>;
  readonly renderContextMenu?: FileTreeProps['renderContextMenu'];
  readonly onClickCapture?: MouseEventHandler;
  readonly onMouseMove?: MouseEventHandler;
  readonly onMouseLeave?: MouseEventHandler;
  readonly onContentHeightChange?: (px: number) => void;
  /** Grow the host to the tree's content height (no inner scrollbar). */
  readonly sizeToContent?: boolean;
  /**
   * Override the row hover-`title` (the full-path tooltip). Given a row's tree
   * path, return the string to stamp, or `null` to keep the default (the tree
   * path itself). The skills tree uses this to disclose a row's real on-disk
   * location (`~/.ok/skills/…`) instead of the "Global/name" tree path (§4).
   */
  readonly titleForPath?: (treePath: string) => string | null;
}

export function OkFileTree({
  model,
  hostRef,
  ready,
  style,
  header,
  className,
  hostAttrs,
  renderContextMenu,
  onClickCapture,
  onMouseMove,
  onMouseLeave,
  onContentHeightChange,
  sizeToContent,
  titleForPath,
}: OkFileTreeProps) {
  // The title stamper below runs inside a shadow-root observer set up once; read
  // the (possibly changing) override through a ref so it always sees the latest.
  const titleForPathRef = useRef(titleForPath);
  useEffect(() => {
    titleForPathRef.current = titleForPath;
  });
  // `@pierre/trees` renders rows inside an open shadow root and exposes no
  // per-row attribute hook, so the full-path `title` is stamped imperatively
  // here. It must also be stamped on the floating `[data-type=context-menu-anchor]`
  // overlay: @pierre/trees positions that `···` ("Options") trigger over the
  // hovered row's right edge as a *sibling* of the row, not a descendant — so
  // the row's own `title` doesn't resolve when the cursor rests there.
  useEffect(() => {
    if (!ready) return;
    const shadow = hostRef.current?.querySelector(FILE_TREE_TAG_NAME)?.shadowRoot;
    if (!shadow) return;
    const toTitle = (treePath: string) => {
      const override = titleForPathRef.current?.(treePath);
      if (override != null) return override;
      return treePath.endsWith('/') ? treePath.slice(0, -1) : treePath;
    };
    const stampTitles = () => {
      for (const row of shadow.querySelectorAll<HTMLElement>('[data-item-path]')) {
        const treePath = row.dataset.itemPath;
        if (!treePath) continue;
        const title = toTitle(treePath);
        if (row.title !== title) row.title = title;
      }
      const anchor = shadow.querySelector<HTMLElement>('[data-type="context-menu-anchor"]');
      if (anchor) {
        const hoveredPath = shadow.querySelector<HTMLElement>(
          '[data-item-context-hover="true"][data-item-path]',
        )?.dataset.itemPath;
        const title = hoveredPath ? toTitle(hoveredPath) : '';
        if (anchor.title !== title) anchor.title = title;
      }
    };
    stampTitles();
    const observer = new MutationObserver(stampTitles);
    observer.observe(shadow, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-item-path', 'data-item-context-hover'],
    });
    return () => observer.disconnect();
  }, [ready, hostRef]);

  // Replace Pierre's trailing-dot artifact with an always-visible uppercase
  // extension badge (delegates to the shared DOM processor).
  useEffect(() => {
    if (!ready) return;
    const shadow = hostRef.current?.querySelector(FILE_TREE_TAG_NAME)?.shadowRoot;
    if (!shadow) return;
    const apply = () => applyExtensionBadges(shadow);
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(shadow, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-item-path'],
    });
    return () => observer.disconnect();
  }, [ready, hostRef]);

  // Report the tree's true content height (and, when `sizeToContent`, grow the
  // host to it). The honest height is the virtualizer's total-size, written as an
  // inline `height` on `[data-file-tree-virtualized-list]` — NOT the scroller's
  // box metrics (the shadow stylesheet stretches the list to `min-height: 100%`,
  // so every box metric clamps to the current pane height). Because the list's
  // border-box stays clamped, a ResizeObserver never fires on content changes —
  // watch the inline `style` attribute with a MutationObserver instead, plus
  // model events (expand / collapse / add / remove) and resize.
  useEffect(() => {
    if (!onContentHeightChange && !sizeToContent) return;
    let raf = 0;
    let attachRaf = 0;
    const getList = () =>
      (hostRef.current
        ?.querySelector(FILE_TREE_TAG_NAME)
        ?.shadowRoot?.querySelector('[data-file-tree-virtualized-list]') as HTMLElement | null) ??
      null;
    const report = () => {
      const list = getList();
      if (!list) return;
      // Report 0 for a genuinely empty tree; skip only the pre-paint state where
      // the virtualizer hasn't set a height yet (the observer re-fires once it does).
      const h = Number.parseFloat(list.style.height);
      if (!Number.isFinite(h)) return;
      onContentHeightChange?.(h);
      if (sizeToContent && hostRef.current) hostRef.current.style.height = `${h}px`;
    };
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(report);
    };
    const mo = new MutationObserver(report);
    const tryAttach = () => {
      const list = getList();
      if (list) {
        mo.observe(list, { attributes: true, attributeFilter: ['style'] });
        report();
      } else {
        attachRaf = requestAnimationFrame(tryAttach);
      }
    };
    tryAttach();
    const unsub = model.subscribe(measure);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(attachRaf);
      mo.disconnect();
      unsub();
      window.removeEventListener('resize', measure);
    };
  }, [onContentHeightChange, sizeToContent, model, hostRef]);

  return (
    <div ref={hostRef} className={className}>
      <PierreFileTree
        header={header}
        model={model}
        style={style}
        {...hostAttrs}
        onClickCapture={onClickCapture}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        renderContextMenu={renderContextMenu}
      />
    </div>
  );
}
