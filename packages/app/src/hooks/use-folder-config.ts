import { type TemplatesListEntry, TemplatesListSuccessSchema } from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';
import { subscribeToTemplatesChanged } from '@/lib/documents-events';
import { parseApiError } from '@/lib/parse-api-error';

interface FolderConfig {
  path: string;
  type: 'directory';
  title?: string;
  description?: string;
  tags?: string[];
  templates_available?: TemplateMenuEntry[];
  directMdCount: number;
  recursiveMdCount: number;
  childDirCount: number;
  truncated: boolean;
  mostRecentMd?: { path: string; title?: string; updatedAt: string };
}

export interface FolderConfigSnapshot {
  folder: FolderConfig;
  frontmatterLocal: Record<string, unknown> | null;
}

export interface TemplateMenuEntry {
  name: string;
  title?: string;
  description?: string;
  path: string;
  source_folder: string;
  scope: 'local' | 'inherited';
}

export type AsyncState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; message: string };

export interface FolderConfigHandle {
  state: AsyncState<FolderConfigSnapshot>;
  refresh: () => void;
}

export function useFolderConfig(folderPath: string | null): FolderConfigHandle {
  const [state, setState] = useState<AsyncState<FolderConfigSnapshot>>({ status: 'idle' });
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (folderPath === null) return;
    return subscribeToTemplatesChanged(() => {
      setRefreshKey((k) => k + 1);
    });
  }, [folderPath]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-fetch trigger is the only purpose of refreshKey
  useEffect(() => {
    if (folderPath === null) {
      setState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    const qs = folderPath ? `?path=${encodeURIComponent(folderPath)}` : '';
    fetch(`/api/folder-config${qs}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = (await r.json().catch(() => null)) as unknown;
          throw new Error(parseApiError(body) ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<{
          folder: FolderConfig;
          frontmatter_local?: Record<string, unknown> | null;
        }>;
      })
      .then((payload) => {
        if (cancelled) return;
        if (!payload || typeof payload !== 'object' || !payload.folder) {
          setState({ status: 'error', message: 'Server returned an incomplete folder response.' });
          return;
        }
        setState({
          status: 'ready',
          data: {
            folder: payload.folder,
            frontmatterLocal: payload.frontmatter_local ?? null,
          },
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [folderPath, refreshKey]);

  return {
    state,
    refresh: () => setRefreshKey((k) => k + 1),
  };
}

export function useAllTemplates(): AsyncState<readonly TemplatesListEntry[]> {
  const [state, setState] = useState<AsyncState<readonly TemplatesListEntry[]>>({ status: 'idle' });
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    return subscribeToTemplatesChanged(() => {
      setRefreshKey((k) => k + 1);
    });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-fetch trigger is the only purpose of refreshKey
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fetch('/api/templates')
      .then(async (r) => {
        if (!r.ok) {
          const body = (await r.json().catch(() => null)) as unknown;
          throw new Error(parseApiError(body) ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<unknown>;
      })
      .then((payload) => {
        if (cancelled) return;
        const parsed = TemplatesListSuccessSchema.safeParse(payload);
        if (!parsed.success) {
          console.error(
            '[ok-templates] /api/templates response failed schema validation:',
            parsed.error.issues,
          );
          setState({
            status: 'error',
            message: 'Server returned an incomplete templates response.',
          });
          return;
        }
        setState({ status: 'ready', data: parsed.data.templates });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return state;
}
