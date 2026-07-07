/**
 * Shared read-only file-load state machine for the bundle/asset viewers.
 *
 * Both `TextViewer` (source render via CodeMirror) and `SkillMarkdownViewer`
 * (rendered markdown) need the identical fetch → loading → loaded / error
 * lifecycle: a pluggable `loadText` loader (scope-aware `/api/skill-file`) or a
 * raw `src` fetch (`/api/asset-text`), HTTP-status → human-message mapping,
 * abort-on-unmount, and the jsdom `cancelled`-flag guard. Extracted here so the
 * two render surfaces share ONE loader instead of each reimplementing it.
 */
import { useLingui } from '@lingui/react/macro';
import { useEffect, useRef, useState } from 'react';

/**
 * Outcome of a pluggable text load. `status` carries the HTTP status (when
 * known) so the viewer maps 404 / 413 / 415 to a human message, mirroring the
 * `/api/asset-text` fetch branches below.
 */
type TextViewerLoadResult =
  | { ok: true; text: string }
  | { ok: false; status?: number; message?: string };

/**
 * The viewer's text source — EXACTLY ONE of `src` / `loadText`. A discriminated
 * union (rather than two optional fields) so "both" and "neither" are
 * unrepresentable at the type level instead of a documented-only invariant.
 */
export type ViewerTextSource =
  | {
      /**
       * Asset-server URL the viewer fetches as raw text
       * (`/api/asset-text?path=…`). Used for content-dir assets.
       */
      src: string;
      loadText?: never;
    }
  | {
      src?: never;
      /**
       * Scope-aware loader override. The hook calls this instead of fetching
       * `src` — used for skill bundle files (global refs + scripts) that live
       * outside the content dir and are read via `/api/skill-file`. The call
       * site `key`-remounts on file change, so a fresh load runs per file.
       */
      loadText: (signal: AbortSignal) => Promise<TextViewerLoadResult>;
    };

export type FetchState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; content: string };

/**
 * Network state for the file load. Kept as a single discriminated union so the
 * render-branch logic stays exhaustive. `AbortController` cancels the in-flight
 * request on unmount / key change so rapid sidebar navigation doesn't leak
 * connections; the cleanup also flips a `cancelled` flag — needed in addition to
 * `signal.aborted` because jsdom (test substrate) ships an older fetch that
 * doesn't always reject aborted requests with `AbortError`.
 */
export function useViewerText(props: ViewerTextSource): FetchState {
  const { t } = useLingui();
  // Map an HTTP status (415 = binary, 413 = too large, 404/400) to a
  // human-readable message. Defined inline so the `t` macro stays in `useLingui`
  // scope (Lingui's extractor can't follow `t` passed as a function argument).
  // 415 covers `/api/skill-file`'s binary-file rejection; the asset-text path
  // never emits it, so it's a no-op there.
  const messageForStatus = (status: number | undefined): string => {
    if (status === 413) {
      return t`This file is too large to open in the built-in text editor (1 MB limit). Use Open file below to open it in another app.`;
    }
    if (status === 415) {
      return t`This file is binary and can't be shown as text.`;
    }
    if (status === 404) {
      return t`This file could not be found.`;
    }
    if (status === 400) {
      return t`This file can't be opened in the text editor.`;
    }
    if (typeof status === 'number') {
      return t`Something went wrong opening this file (HTTP ${status}).`;
    }
    return t`Failed to load file`;
  };
  const { src, loadText } = props;
  // `loadText` and `messageForStatus` are closures recreated every render, so
  // they can't be effect dependencies without re-firing the fetch on every
  // render — read both through "latest" refs instead. Call sites pass a `key`
  // that remounts the consumer when the file changes, so the effect re-runs the
  // load per file via the mount. The refs are assigned in an effect (not during
  // render) per the React Compiler's no-ref-mutation-in-render rule.
  const loadFnRef = useRef(loadText);
  const messageForStatusRef = useRef(messageForStatus);
  useEffect(() => {
    loadFnRef.current = loadText;
    messageForStatusRef.current = messageForStatus;
  });
  const [state, setState] = useState<FetchState>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    setState({ status: 'loading' });

    // Pluggable loader (skill bundle files) — already returns a status-tagged
    // result, so no raw Response handling here.
    const loadFn = loadFnRef.current;
    if (loadFn) {
      loadFn(ctrl.signal)
        .then((result) => {
          if (cancelled) return;
          if (result.ok) {
            setState({ status: 'loaded', content: result.text });
            return;
          }
          setState({
            status: 'error',
            message: result.message ?? messageForStatusRef.current(result.status),
          });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (err instanceof Error && err.name === 'AbortError') return;
          setState({ status: 'error', message: t`Failed to load file` });
        });
      return () => {
        cancelled = true;
        ctrl.abort();
      };
    }

    fetch(src ?? '', { credentials: 'same-origin', signal: ctrl.signal })
      .then(async (resp) => {
        if (!resp.ok) {
          // Translate the raw HTTP status into a human-readable explanation
          // rather than surfacing a bare status code. 413 is the common,
          // actionable case: the server caps `/api/asset-text` at
          // TEXT_VIEW_MAX_BYTES (1 MiB) in api-extension.ts — keep the "1 MB"
          // wording aligned with that constant if it ever changes. Unmapped
          // statuses keep the code appended so unexpected failures stay
          // diagnosable.
          throw new Error(messageForStatusRef.current(resp.status));
        }
        return resp.text();
      })
      .then((content) => {
        if (cancelled) return;
        setState({ status: 'loaded', content });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Swallow the synthetic `AbortError` from `ctrl.abort()`; the
        // `cancelled` flag above already ignores stale resolutions, so
        // surfacing the abort as an error state would flash an
        // unrelated "Couldn't load …" message during sidebar nav.
        if (err instanceof Error && err.name === 'AbortError') return;
        const message = err instanceof Error ? err.message : t`Failed to load file`;
        setState({ status: 'error', message });
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [src, t]);
  return state;
}
