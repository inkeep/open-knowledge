import { HocuspocusProvider } from '@hocuspocus/provider';
import { mdastToHtml } from '@inkeep/open-knowledge-core';
import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { useCollabUrl } from '@/lib/use-collab-url';
import { getSharedMarkdownManager } from '../utils/md-singleton.ts';

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
  | { kind: 'empty-props' };

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

interface MirrorSubscriber {
  onUpdate: () => void;
  onSynced: () => void;
}
interface MirrorPoolEntry {
  provider: HocuspocusProvider;
  ySource: Y.Text;
  refcount: number;
  synced: boolean;
  subscribers: Set<MirrorSubscriber>;
}
const mirrorPool = new Map<string, MirrorPoolEntry>();

const MIRROR_POOL_WARN_AT = 30;
const OBSERVE_DEBOUNCE_MS = 150;
const SYNC_WATCHDOG_MS = 10_000;

function acquireMirrorProvider(collabUrl: string, src: string): MirrorPoolEntry {
  const key = `${collabUrl}|${src}`;
  const existing = mirrorPool.get(key);
  if (existing) {
    existing.refcount += 1;
    return existing;
  }
  const yDoc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: collabUrl,
    name: src,
    document: yDoc,
  });
  const subscribers = new Set<MirrorSubscriber>();
  const entry: MirrorPoolEntry = {
    provider,
    ySource: yDoc.getText('source'),
    refcount: 1,
    synced: false,
    subscribers,
  };
  provider.on('synced', () => {
    entry.synced = true;
    for (const sub of subscribers) sub.onSynced();
  });
  entry.ySource.observe(() => {
    for (const sub of subscribers) sub.onUpdate();
  });
  mirrorPool.set(key, entry);
  if (mirrorPool.size > MIRROR_POOL_WARN_AT) {
    console.warn(
      `[Mirror] provider pool exceeded ${MIRROR_POOL_WARN_AT} entries (current=${mirrorPool.size}). Many Mirrors pointing at distinct source docs — investigate if this is a runaway pattern.`,
    );
  }
  return entry;
}

function releaseMirrorProvider(collabUrl: string, src: string): void {
  const key = `${collabUrl}|${src}`;
  const entry = mirrorPool.get(key);
  if (!entry) return;
  entry.refcount -= 1;
  if (entry.refcount <= 0) {
    try {
      entry.provider.destroy();
    } catch (err) {
      console.warn('[Mirror] provider.destroy() failed during release', { src, err });
    }
    mirrorPool.delete(key);
  }
}

export function useMirrorSource(src: string, anchor: string): MirrorSourceStatus {
  const { collabUrl } = useCollabUrl();
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

    const entry = acquireMirrorProvider(collabUrl, src);

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
      setStatus({ kind: 'ready', html });
    };

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const recomputeDebounced = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        recomputeNow();
      }, OBSERVE_DEBOUNCE_MS);
    };

    const subscriber: MirrorSubscriber = {
      onUpdate: recomputeDebounced,
      onSynced: () => {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        recomputeNow();
      },
    };
    entry.subscribers.add(subscriber);
    recomputeRef.current = recomputeNow;

    const watchdog = setTimeout(() => {
      if (!entry.synced) {
        setStatus({ kind: 'source-removed' });
      }
    }, SYNC_WATCHDOG_MS);

    recomputeNow();

    return () => {
      clearTimeout(watchdog);
      if (debounceTimer) clearTimeout(debounceTimer);
      entry.subscribers.delete(subscriber);
      recomputeRef.current = null;
      releaseMirrorProvider(collabUrl, src);
    };
  }, [collabUrl, src]);

  useEffect(() => {
    anchorRef.current = anchor;
    recomputeRef.current?.();
  }, [anchor]);

  return status;
}
