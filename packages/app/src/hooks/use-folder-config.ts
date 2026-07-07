import { type TemplatesListEntry, TemplatesListSuccessSchema } from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';
import { subscribeToTemplatesChanged } from '@/lib/documents-events';
import { parseApiError } from '@/lib/parse-api-error';

/**
 * Folder frontmatter + templates data subscriptions.
 *
 * Imperative writes live in `@/lib/folder-config-api` — these hooks are
 * read-only, refresh-aware data sources. Call `refresh()` after a successful
 * write so the UI re-fetches.
 */

/**
 * Folder metadata + templates menu, as returned by `GET /api/folder-config`.
 * Mirrors the server-side `DirectoryMeta` shape — kept structural so the
 * server can extend it without breaking this hook. `title` / `description` /
 * `tags` are the conventional well-known keys surfaced on the typed shape; the
 * folder's full open-shape frontmatter is in `frontmatterLocal`. Self-only —
 * no ancestor cascade.
 */
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

/**
 * Snapshot from `GET /api/folder-config` — the folder metadata plus the
 * folder's own on-disk frontmatter.
 */
export interface FolderConfigSnapshot {
  folder: FolderConfig;
  /**
   * The on-disk `<folder>/.ok/frontmatter.yml` contents verbatim (the
   * folder's own open-shape frontmatter — self-only). `null` if the file
   * doesn't exist or is malformed.
   */
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
  /**
   * Re-fetch the folder's frontmatter + templates menu. Call after a
   * successful write (folder properties edit, template create/update/delete)
   * so the UI reflects the new state.
   */
  refresh: () => void;
}

/**
 * Folder frontmatter + templates fetch with refresh control.
 * Re-runs whenever `folderPath` or `refreshKey` changes. Folder path can be
 * empty (project root). Skip the fetch entirely by passing `null`.
 */
export function useFolderConfig(folderPath: string | null): FolderConfigHandle {
  const [state, setState] = useState<AsyncState<FolderConfigSnapshot>>({ status: 'idle' });
  const [refreshKey, setRefreshKey] = useState(0);

  // Cross-instance reactivity: any successful template create/delete
  // (via folder-config-api) emits `templates-changed`; every mounted
  // useFolderConfig refreshes so consumers like the sidebar's smart-hide
  // and an open NewItemDialog reflect the new state without a reload.
  //
  // Skip when `folderPath === null` (NewItemDialog's dedup branch when a
  // parent supplies `folderConfigOverride`): the fetch effect below
  // early-returns on null, so an event-driven `setRefreshKey` would
  // re-run that effect only to land on `setState({ status: 'idle' })`,
  // burning two renders + a new handle reference per persistently-mounted
  // null-path consumer per template save.
  useEffect(() => {
    if (folderPath === null) return;
    return subscribeToTemplatesChanged(() => {
      setRefreshKey((k) => k + 1);
    });
  }, [folderPath]);

  // `refreshKey` is intentionally listed in the dep array even though it's
  // not read inside the effect body — incrementing it is the mechanism
  // that triggers a re-fetch when callers invoke `refresh()`.
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
          // RFC 9457 problem+json on error — extract the title for display.
          // Falls back to the bare HTTP status if the body isn't an
          // RFC 9457 envelope (proxy 502 HTML, network failures, etc.).
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
        // Structural trust-boundary guard: a 200 response with a malformed
        // body (server bug, transparent proxy rewrite) would otherwise crash
        // with "Cannot read properties of undefined" downstream. The schema
        // shape is closed at the server, but the client doesn't validate the
        // wire — keep a lightweight presence check at the boundary. Also
        // covers the `null` JSON-literal case where `payload` itself is null
        // and `payload.folder` would throw "Cannot read properties of null".
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

/**
 * Project-wide flat enumeration of templates. Backed by `GET /api/templates`,
 * which walks every `<folder>/.ok/templates/*.md` once. Re-fetches on the
 * `templates-changed` event bus (same trigger `useFolderConfig` subscribes
 * to), so a template create/update/delete from any surface lands here
 * without a window reload. Used by the editor's empty-state surface.
 */
export function useAllTemplates(): AsyncState<readonly TemplatesListEntry[]> {
  const [state, setState] = useState<AsyncState<readonly TemplatesListEntry[]>>({ status: 'idle' });
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    return subscribeToTemplatesChanged(() => {
      setRefreshKey((k) => k + 1);
    });
  }, []);

  // `refreshKey` is intentionally listed in the dep array even though it's
  // not read inside the effect body — incrementing it is the mechanism
  // that triggers a re-fetch when the templates-changed bus fires.
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
        // Full Zod parse (vs the lightweight presence check used by the
        // siblings above). `TemplatesListEntrySchema` is `.strict()` —
        // server-side drift on field names surfaces here as an error
        // envelope rather than landing partial objects in component
        // state. The trade-off is per-row validation cost; the response
        // is small + happens on a non-hot path, so this is fine.
        const parsed = TemplatesListSuccessSchema.safeParse(payload);
        if (!parsed.success) {
          // Surface the Zod issue array to devtools so a schema regression
          // (server adds an unexpected field, type drift on `source_folder`,
          // etc.) is debuggable — the user-facing message stays generic
          // because the issue paths leak server-implementation detail.
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
