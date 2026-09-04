import {
  type Base16Scheme,
  type ProblemDetails,
  ProblemDetailsSchema,
  parseSavedThemeId,
  SavedThemeDeleteSuccessSchema,
  type SavedThemeListEntry,
  type SavedThemeSaveRequest,
  SavedThemeSaveRequestSchema,
  SavedThemeSaveSuccessSchema,
  type SavedThemeScheme,
  SavedThemeSchemeSchema,
  SavedThemesListSuccessSchema,
  SavedThemeUpdateRequestSchema,
  SavedThemeUpdateSuccessSchema,
} from '@inkeep/open-knowledge-core';
import {
  createContext,
  createElement,
  type ReactNode,
  use,
  useEffect,
  useRef,
  useState,
} from 'react';
import { base16ToTokens, COLOR_THEMES, type ColorTheme } from '@/lib/color-themes';
import { useServerInstanceId } from '@/lib/server-instance-store';

interface SavedThemeWarning {
  filename: string;
  id?: string;
  code: string;
  conflictingFilenames?: string[];
}

export interface SavedThemesData {
  themes: readonly ColorTheme[];
  warnings: readonly SavedThemeWarning[];
  truncated: boolean;
}

export interface SavedThemesFetchResult extends SavedThemesData {
  authoritative: boolean;
}

interface SavedThemesContextValue extends SavedThemesData {
  loaded: boolean;
  loadError: boolean;
  refresh: () => Promise<boolean>;
  updateTheme: (input: { id: string; scheme: Base16Scheme }) => Promise<UpdateSavedThemeResult>;
  deleteTheme: (id: string) => Promise<DeleteSavedThemeResult>;
  restoreTheme: (input: {
    id: string;
    name: string;
    stem?: string;
    scheme: SavedThemeScheme;
    extension?: '.yaml' | '.yml';
  }) => Promise<SaveSavedThemeResult>;
  editingThemeId: string;
  themeIncarnations: Readonly<Record<string, number>>;
  themeEditorOpen: boolean;
  selectThemeToEdit: (id: string | null) => void;
}

type SavedThemesRequest = (path: string, init?: RequestInit) => Promise<Response>;

interface FetchSavedThemesOptions {
  request?: SavedThemesRequest;
  signal?: AbortSignal;
}

interface SavedThemeMutationOptions {
  request?: SavedThemesRequest;
}

type SavedThemeNameDetail = 'empty' | 'too-long' | 'invalid-chars';

export type SaveSavedThemeResult =
  | { ok: true; id: string; filename: string }
  | { ok: false; reason: 'name-taken' }
  | { ok: false; reason: 'name-invalid'; detail?: SavedThemeNameDetail }
  | { ok: false; reason: 'unexpected' };

export type UpdateSavedThemeResult =
  | { ok: true; id: string; filename: string }
  | { ok: false; reason: 'not-found' | 'unexpected' };

export type DeleteSavedThemeResult =
  | { ok: true; existed: true; filename: string; scheme: SavedThemeScheme }
  | { ok: true; existed: false }
  | { ok: false; reason: 'unexpected' };

type UsableSavedTheme = Extract<SavedThemeListEntry, { ok: true }>;

function emptySavedThemes(authoritative: boolean): SavedThemesFetchResult {
  return { authoritative, themes: COLOR_THEMES, warnings: [], truncated: false };
}

function savedThemeToColorTheme(entry: UsableSavedTheme): ColorTheme {
  const { scheme } = entry;
  return {
    id: entry.id,
    label: scheme.name,
    kind: scheme.variant,
    scheme,
    toTokens: () => base16ToTokens(scheme),
  };
}

function savedThemeSchemeToColorTheme(id: string, scheme: Base16Scheme): ColorTheme {
  return {
    id,
    label: scheme.name,
    kind: scheme.variant,
    scheme,
    toTokens: () => base16ToTokens(scheme),
  };
}

function warnSavedThemeRequestFailure(
  action: 'list' | 'save' | 'update' | 'delete',
  result: 'http-error' | 'request-error',
  details: { status?: number; error?: unknown } = {},
): void {
  console.warn(
    JSON.stringify({
      event: 'ok-saved-theme-request-failed',
      action,
      result,
      ...(details.status === undefined ? {} : { status: details.status }),
      ...(details.error === undefined
        ? {}
        : { errorName: details.error instanceof Error ? details.error.name : 'UnknownError' }),
    }),
  );
}

export async function fetchSavedThemes(
  options: FetchSavedThemesOptions = {},
): Promise<SavedThemesFetchResult> {
  const request = options.request ?? globalThis.fetch;
  try {
    const response = await request('/api/saved-themes', { signal: options.signal });
    if (!response.ok) {
      warnSavedThemeRequestFailure('list', 'http-error', { status: response.status });
      return emptySavedThemes(false);
    }

    const parsed = SavedThemesListSuccessSchema.safeParse(await response.json());
    if (!parsed.success) {
      console.warn('[themes] saved-themes response failed schema validation', parsed.error.issues);
      return emptySavedThemes(false);
    }

    const savedThemes: ColorTheme[] = [];
    const warnings: SavedThemeWarning[] = [];
    for (const entry of parsed.data.themes) {
      if (entry.ok) savedThemes.push(savedThemeToColorTheme(entry));
      else {
        warnings.push({
          filename: entry.filename,
          id: entry.id,
          code: entry.code,
          ...(entry.conflictingFilenames
            ? { conflictingFilenames: entry.conflictingFilenames }
            : {}),
        });
      }
    }

    return {
      authoritative: true,
      themes: savedThemes.length === 0 ? COLOR_THEMES : [...COLOR_THEMES, ...savedThemes],
      warnings,
      truncated: parsed.data.truncated,
    };
  } catch (error) {
    if (options.signal?.aborted) return emptySavedThemes(false);
    warnSavedThemeRequestFailure('list', 'request-error', { error });
    return emptySavedThemes(false);
  }
}

function nameDetail(problem: ProblemDetails): SavedThemeNameDetail | undefined {
  switch (problem.detail) {
    case 'empty':
    case 'too-long':
    case 'invalid-chars':
      return problem.detail;
    default:
      return undefined;
  }
}

export async function saveSavedTheme(
  input: SavedThemeSaveRequest,
  options: SavedThemeMutationOptions = {},
): Promise<SaveSavedThemeResult> {
  const payload = SavedThemeSaveRequestSchema.safeParse(input);
  if (!payload.success) return { ok: false, reason: 'unexpected' };

  const request = options.request ?? globalThis.fetch;
  try {
    const response = await request('/api/saved-theme', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload.data),
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (response.ok) {
      const success = SavedThemeSaveSuccessSchema.safeParse(body);
      return success.success ? { ok: true, ...success.data } : { ok: false, reason: 'unexpected' };
    }

    const problem = ProblemDetailsSchema.safeParse(body);
    if (!problem.success) return { ok: false, reason: 'unexpected' };
    if (problem.data.type === 'urn:ok:error:theme-name-taken') {
      return { ok: false, reason: 'name-taken' };
    }
    if (problem.data.type === 'urn:ok:error:theme-name-invalid') {
      const detail = nameDetail(problem.data);
      return detail
        ? { ok: false, reason: 'name-invalid', detail }
        : { ok: false, reason: 'name-invalid' };
    }
    return { ok: false, reason: 'unexpected' };
  } catch (error) {
    warnSavedThemeRequestFailure('save', 'request-error', { error });
    return { ok: false, reason: 'unexpected' };
  }
}

export async function updateSavedTheme(
  input: { id: string; scheme: Base16Scheme },
  options: SavedThemeMutationOptions = {},
): Promise<UpdateSavedThemeResult> {
  const payload = SavedThemeUpdateRequestSchema.safeParse(input);
  if (!payload.success) return { ok: false, reason: 'unexpected' };

  const request = options.request ?? globalThis.fetch;
  try {
    const response = await request('/api/saved-theme', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload.data),
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (response.ok) {
      const success = SavedThemeUpdateSuccessSchema.safeParse(body);
      return success.success ? { ok: true, ...success.data } : { ok: false, reason: 'unexpected' };
    }
    const problem = ProblemDetailsSchema.safeParse(body);
    return problem.success && problem.data.type === 'urn:ok:error:not-found'
      ? { ok: false, reason: 'not-found' }
      : { ok: false, reason: 'unexpected' };
  } catch (error) {
    warnSavedThemeRequestFailure('update', 'request-error', { error });
    return { ok: false, reason: 'unexpected' };
  }
}

export async function deleteSavedTheme(
  id: string,
  options: SavedThemeMutationOptions = {},
): Promise<DeleteSavedThemeResult> {
  if (!parseSavedThemeId(id).ok) return { ok: false, reason: 'unexpected' };

  const request = options.request ?? globalThis.fetch;
  try {
    const query = new URLSearchParams({ id });
    const response = await request(`/api/saved-theme?${query}`, { method: 'DELETE' });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) return { ok: false, reason: 'unexpected' };

    const success = SavedThemeDeleteSuccessSchema.safeParse(body);
    if (!success.success) return { ok: false, reason: 'unexpected' };
    if (!success.data.existed) return { ok: true, existed: false };
    const scheme = SavedThemeSchemeSchema.safeParse(success.data.scheme);
    return scheme.success
      ? {
          ok: true,
          existed: true,
          filename: success.data.filename,
          scheme: scheme.data,
        }
      : { ok: false, reason: 'unexpected' };
  } catch (error) {
    warnSavedThemeRequestFailure('delete', 'request-error', { error });
    return { ok: false, reason: 'unexpected' };
  }
}

const SavedThemesContext = createContext<SavedThemesContextValue | null>(null);

export function SavedThemesProvider({ children }: { children: ReactNode }) {
  const serverInstanceId = useServerInstanceId();
  const [data, setData] = useState<SavedThemesData>(() => emptySavedThemes(false));
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [editingThemeId, setEditingThemeId] = useState('custom');
  const [themeEditorOpen, setThemeEditorOpen] = useState(false);
  const themeIncarnationsRef = useRef<Record<string, number>>({});
  const [themeIncarnations, setThemeIncarnations] = useState<Readonly<Record<string, number>>>({});
  const mutationVersionRef = useRef(0);
  const [requestManager] = useState(() => {
    let generation = 0;
    let inFlight: Promise<boolean> | null = null;
    let trailingRequested = false;
    let activeController: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const retryDelays = [250, 1_000, 4_000] as const;

    const clearRetryTimer = () => {
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
    };

    const refresh = (): Promise<boolean> => {
      if (inFlight) {
        trailingRequested = true;
        return inFlight;
      }
      const requestGeneration = generation;
      const run = async () => {
        let latestResponseAuthoritative = false;
        do {
          trailingRequested = false;
          const requestVersion = mutationVersionRef.current;
          const controller = new AbortController();
          activeController = controller;
          const { authoritative, ...next } = await fetchSavedThemes({
            signal: controller.signal,
          });
          if (requestGeneration !== generation) return false;
          latestResponseAuthoritative = authoritative;
          if (authoritative) {
            clearRetryTimer();
            if (requestVersion === mutationVersionRef.current) setData(next);
            setLoaded(true);
            setLoadError(false);
          } else {
            setLoadError(true);
          }
        } while (trailingRequested);
        return latestResponseAuthoritative;
      };
      const promise = run().finally(() => {
        if (inFlight === promise) inFlight = null;
      });
      inFlight = promise;
      return promise;
    };

    const startAutomaticRetry = () => {
      generation += 1;
      const retryGeneration = generation;
      activeController?.abort();
      activeController = null;
      inFlight = null;
      trailingRequested = false;
      clearRetryTimer();

      const load = async (attempt: number) => {
        const authoritative = await refresh();
        if (retryGeneration !== generation || authoritative || attempt >= retryDelays.length) {
          return;
        }
        retryTimer = setTimeout(() => void load(attempt + 1), retryDelays[attempt]);
      };

      void load(0);
      return () => {
        if (retryGeneration !== generation) return;
        generation += 1;
        activeController?.abort();
        activeController = null;
        inFlight = null;
        trailingRequested = false;
        clearRetryTimer();
      };
    };

    return { refresh, startAutomaticRetry };
  });
  const refresh = requestManager.refresh;
  const [mutations] = useState(() => {
    const tails = new Map<string, Promise<void>>();
    const enqueue = <Result>(id: string, mutation: () => Promise<Result>): Promise<Result> => {
      const previous = tails.get(id) ?? Promise.resolve();
      const result = previous.then(mutation, mutation);
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(id, tail);
      void tail.finally(() => {
        if (tails.get(id) === tail) tails.delete(id);
      });
      return result;
    };
    const upsertTheme = (id: string, scheme: Base16Scheme, filename?: string) => {
      mutationVersionRef.current += 1;
      const nextTheme = savedThemeSchemeToColorTheme(id, scheme);
      setData((current) => ({
        ...current,
        themes: current.themes.some((theme) => theme.id === id)
          ? current.themes.map((theme) => (theme.id === id ? nextTheme : theme))
          : [...current.themes, nextTheme],
        warnings: current.warnings.filter(
          (warning) =>
            warning.id !== id && (filename === undefined || warning.filename !== filename),
        ),
      }));
    };
    return {
      updateTheme: (input: { id: string; scheme: Base16Scheme }) =>
        enqueue(input.id, async () => {
          const result = await updateSavedTheme(input);
          if (result.ok) upsertTheme(input.id, input.scheme, result.filename);
          return result;
        }),
      deleteTheme: (id: string) =>
        enqueue(id, async () => {
          const result = await deleteSavedTheme(id);
          if (result.ok) {
            const nextIncarnations = {
              ...themeIncarnationsRef.current,
              [id]: (themeIncarnationsRef.current[id] ?? 0) + 1,
            };
            themeIncarnationsRef.current = nextIncarnations;
            setThemeIncarnations(nextIncarnations);
            mutationVersionRef.current += 1;
            setData((current) => ({
              ...current,
              themes: current.themes.filter((theme) => theme.id !== id),
              warnings: current.warnings.filter((warning) => warning.id !== id),
            }));
          }
          return result;
        }),
      restoreTheme: (input: {
        id: string;
        name: string;
        stem?: string;
        scheme: SavedThemeScheme;
        extension?: '.yaml' | '.yml';
      }) =>
        enqueue(input.id, async () => {
          const result = await saveSavedTheme({
            name: input.name,
            stem: input.stem,
            scheme: input.scheme,
            extension: input.extension,
          });
          if (result.ok) upsertTheme(result.id, input.scheme, result.filename);
          return result;
        }),
    };
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new server epoch invalidates in-flight work and restarts startup recovery.
  useEffect(() => {
    return requestManager.startAutomaticRetry();
  }, [requestManager, serverInstanceId]);

  function selectThemeToEdit(id: string | null) {
    if (id === null) {
      setThemeEditorOpen(false);
      return;
    }
    setEditingThemeId(id);
    setThemeEditorOpen(true);
  }

  return createElement(
    SavedThemesContext,
    {
      value: {
        ...data,
        loaded,
        loadError,
        refresh,
        ...mutations,
        editingThemeId,
        themeIncarnations,
        themeEditorOpen,
        selectThemeToEdit,
      },
    },
    children,
  );
}

export function useSavedThemes(): SavedThemesContextValue {
  const context = use(SavedThemesContext);
  if (!context) throw new Error('useSavedThemes must be used within <SavedThemesProvider />');
  return context;
}
