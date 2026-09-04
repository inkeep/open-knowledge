import { useLingui } from '@lingui/react/macro';
import { useEffect, useRef, useState } from 'react';

type TextViewerLoadResult =
  | { ok: true; text: string }
  | { ok: false; status?: number; message?: string };

export type ViewerTextSource =
  | {
      src: string;
      assetPath: string;
      loadText?: never;
    }
  | {
      src?: never;
      assetPath?: never;
      loadText: (signal: AbortSignal) => Promise<TextViewerLoadResult>;
    };

export type FetchState =
  | { status: 'loading' }
  | {
      status: 'error';
      message: string;
      httpStatus?: number;
    }
  | { status: 'loaded'; content: string };

class ViewerTextLoadError extends Error {
  readonly httpStatus: number;
  constructor(message: string, httpStatus: number) {
    super(message);
    this.name = 'ViewerTextLoadError';
    this.httpStatus = httpStatus;
  }
}

export function useViewerText(props: ViewerTextSource): FetchState {
  const { t } = useLingui();
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
            httpStatus: result.status,
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
          throw new ViewerTextLoadError(messageForStatusRef.current(resp.status), resp.status);
        }
        return resp.text();
      })
      .then((content) => {
        if (cancelled) return;
        setState({ status: 'loaded', content });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        const message = err instanceof Error ? err.message : t`Failed to load file`;
        setState({
          status: 'error',
          message,
          httpStatus: err instanceof ViewerTextLoadError ? err.httpStatus : undefined,
        });
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [src, t]);
  return state;
}
