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
  readonly hostRef: RefObject<HTMLDivElement | null>;
  readonly ready: boolean;
  readonly style: CSSProperties;
  readonly header?: ReactNode;
  readonly className?: string;
  readonly hostAttrs?: Record<string, string | undefined>;
  readonly renderContextMenu?: FileTreeProps['renderContextMenu'];
  readonly onClickCapture?: MouseEventHandler;
  readonly onMouseMove?: MouseEventHandler;
  readonly onMouseLeave?: MouseEventHandler;
  readonly onContentHeightChange?: (px: number) => void;
  readonly sizeToContent?: boolean;
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
  const titleForPathRef = useRef(titleForPath);
  useEffect(() => {
    titleForPathRef.current = titleForPath;
  });
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
