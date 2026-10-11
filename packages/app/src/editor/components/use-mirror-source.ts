import { mdastToHtml } from '@inkeep/open-knowledge-core/markdown/mdast-to-html';
import { useEffect, useRef, useState } from 'react';
import { useCollabUrl } from '@/lib/use-collab-url';
import { getSharedMarkdownManager } from '../utils/md-singleton.ts';
import {
  type AcquireLiveDocResult,
  LIVE_DOC_OBSERVE_DEBOUNCE_MS,
  LIVE_DOC_SYNC_WATCHDOG_MS,
  releaseLiveDocProvider,
  useLiveDocAcquirer,
} from './live-doc-pool.ts';

interface MdxJsxAttrLike {
  type: string;
  name?: string;
  value?: unknown;
}
interface MdxJsxFlowElementLike {
  type: 'mdxJsxFlowElement';
  name?: string | null;
  attributes?: MdxJsxAttrLike[];
  children?: MdastNodeLike[];
}
interface MdastNodeLike {
  type: string;
  children?: MdastNodeLike[];
  [key: string]: unknown;
}
interface MdastRootLike extends MdastNodeLike {
  type: 'root';
  children: MdastNodeLike[];
}

type MirrorSourceStatus =
  | { kind: 'loading' }
  | { kind: 'ready'; html: string }
  | { kind: 'source-removed' }
  | { kind: 'anchor-not-found' }
  | { kind: 'empty-props' }
  | { kind: 'at-capacity' };

export function findMirrorSource(
  tree: MdastNodeLike,
  anchor: string,
): MdxJsxFlowElementLike | null {
  if (tree.type === 'mdxJsxFlowElement') {
    const node = tree as MdxJsxFlowElementLike;
    if (node.name === 'MirrorSource') {
      for (const attr of node.attributes ?? []) {
        if (
          attr.type === 'mdxJsxAttribute' &&
          attr.name === 'id' &&
          typeof attr.value === 'string' &&
          attr.value === anchor
        ) {
          return node;
        }
      }
    }
  }
  const children = tree.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findMirrorSource(child, anchor);
      if (found) return found;
    }
  }
  return null;
}

export function renderMirrorSubtree(node: MdxJsxFlowElementLike): string {
  const synthRoot: MdastRootLike = {
    type: 'root',
    children: node.children ?? [],
  };
  // biome-ignore lint/suspicious/noExplicitAny: structural type match across the core boundary
  return mdastToHtml(synthRoot as any);
}

function refusedMirrorStatus(
  reason: Extract<AcquireLiveDocResult, { ok: false }>['reason'],
): MirrorSourceStatus {
  switch (reason) {
    case 'at-capacity':
      return { kind: 'at-capacity' };
    case 'inadmissible':
      return { kind: 'source-removed' };
    case 'refused':
      return { kind: 'loading' };
  }
}

export function useMirrorSource(src: string, anchor: string): MirrorSourceStatus {
  const { collabUrl } = useCollabUrl();
  const acquireLiveDoc = useLiveDocAcquirer();
  const [status, setStatus] = useState<MirrorSourceStatus>({ kind: 'loading' });
  const anchorRef = useRef(anchor);
  const recomputeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!src) {
      setStatus({ kind: 'empty-props' });
      return;
    }
    if (!collabUrl) {
      setStatus({ kind: 'loading' });
      return;
    }

    const acquired = acquireLiveDoc(collabUrl, src);
    if (!acquired.ok) {
      console.warn('[Mirror] live-doc pool refused subscription', {
        src,
        reason: acquired.reason,
      });
      setStatus(refusedMirrorStatus(acquired.reason));
      return;
    }
    const { entry } = acquired;

    const recomputeNow = () => {
      const currentAnchor = anchorRef.current;
      if (!currentAnchor) {
        setStatus({ kind: 'empty-props' });
        return;
      }
      const markdown = entry.ySource.toString();
      if (!markdown) {
        setStatus(entry.synced ? { kind: 'source-removed' } : { kind: 'loading' });
        return;
      }
      let tree: MdastRootLike;
      try {
        // biome-ignore lint/suspicious/noExplicitAny: structural type match across the core boundary
        tree = getSharedMarkdownManager().parseToMdast(markdown) as any;
      } catch (err) {
        console.warn('[Mirror] parseToMdast failed', { src, anchor: currentAnchor, err });
        setStatus({ kind: 'source-removed' });
        return;
      }
      const node = findMirrorSource(tree, currentAnchor);
      if (!node) {
        setStatus({ kind: 'anchor-not-found' });
        return;
      }
      let html: string;
      try {
        html = renderMirrorSubtree(node);
      } catch (err) {
        console.warn('[Mirror] renderMirrorSubtree failed', { src, anchor: currentAnchor, err });
        setStatus({ kind: 'anchor-not-found' });
        return;
      }
      setStatus((prev) =>
        prev.kind === 'ready' && prev.html === html ? prev : { kind: 'ready', html },
      );
    };

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const recomputeDebounced = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        recomputeNow();
      }, LIVE_DOC_OBSERVE_DEBOUNCE_MS);
    };

    const unsubscribe = entry.subscribe({
      onUpdate: recomputeDebounced,
      onSynced: () => {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        recomputeNow();
      },
    });
    recomputeRef.current = recomputeNow;

    const watchdog = setTimeout(() => {
      if (!entry.synced) {
        setStatus({ kind: 'source-removed' });
      }
    }, LIVE_DOC_SYNC_WATCHDOG_MS);

    recomputeNow();

    return () => {
      clearTimeout(watchdog);
      if (debounceTimer) clearTimeout(debounceTimer);
      unsubscribe();
      recomputeRef.current = null;
      releaseLiveDocProvider(collabUrl, src);
    };
  }, [collabUrl, src, acquireLiveDoc]);

  useEffect(() => {
    anchorRef.current = anchor;
    recomputeRef.current?.();
  }, [anchor]);

  return status;
}
