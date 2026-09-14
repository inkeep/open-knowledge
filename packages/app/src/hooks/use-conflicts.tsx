import { type ConflictEntryWire, SyncConflictsSuccessSchema } from '@inkeep/open-knowledge-core';
import { createContext, type ReactNode, use, useEffect, useRef, useState } from 'react';
import { subscribeToDocumentsChanged } from '@/lib/documents-events';

type ConflictsFetchError = 'network' | 'server';

interface ConflictsFetchResult {
  conflicts: ConflictEntryWire[];
  error?: ConflictsFetchError;
}

interface ConflictsSnapshot {
  conflicts: ConflictEntryWire[];
  loading: boolean;
  error: ConflictsFetchError | null;
}

interface ConflictsState extends ConflictsSnapshot {
  byDocName: ReadonlyMap<string, ConflictEntryWire>;
}

interface ConflictsActions {
  refresh: () => void;
}

type ConflictsContextValue = ConflictsState & ConflictsActions;
type ConflictsResult = ConflictsSnapshot & ConflictsActions;

export class ConflictsProviderMissingError extends Error {
  constructor(hookName: string) {
    super(`${hookName} must be rendered inside <ConflictsProvider />`);
    this.name = 'ConflictsProviderMissingError';
  }
}

const ConflictsContext = createContext<ConflictsContextValue | null>(null);

const UNPROVIDED_CONFLICTS: ConflictsResult = {
  conflicts: [],
  loading: false,
  error: null,
  refresh: () => {},
};

const CONFLICTS_REQUEST_TIMEOUT_MS = 5_000;

async function fetchConflicts(): Promise<ConflictsFetchResult> {
  try {
    const res = await fetch('/api/sync/conflicts', {
      signal: AbortSignal.timeout(CONFLICTS_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(
        JSON.stringify({
          event: 'conflicts-fetch-failed',
          status: res.status,
        }),
      );
      return { conflicts: [], error: 'server' };
    }
    const body = await res.json().catch(() => null);
    const parsed = SyncConflictsSuccessSchema.safeParse(body);
    if (!parsed.success) {
      console.warn(
        JSON.stringify({
          event: 'conflicts-fetch-failed',
          status: res.status,
          detail: 'schema-drift',
        }),
      );
      return { conflicts: [], error: 'server' };
    }
    return { conflicts: parsed.data.conflicts };
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: 'conflicts-fetch-failed',
        status: null,
        errorName: err instanceof Error ? err.name : 'non-error-throw',
        detail: err instanceof Error ? err.message : String(err),
      }),
    );
    return { conflicts: [], error: 'network' };
  }
}

function indexByDocName(
  conflicts: readonly ConflictEntryWire[],
): ReadonlyMap<string, ConflictEntryWire> {
  const index = new Map<string, ConflictEntryWire>();
  for (const entry of conflicts) {
    if (typeof entry.docName === 'string' && entry.docName.length > 0) {
      index.set(entry.docName, entry);
    }
  }
  return index;
}

function entrySignature(entry: ConflictEntryWire): string {
  const fields = entry as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(fields)
      .sort()
      .map((key) => [key, fields[key]]),
  );
}

function reuseUnchangedEntries(
  previous: readonly ConflictEntryWire[],
  next: readonly ConflictEntryWire[],
): { entries: ConflictEntryWire[]; changed: boolean } {
  const priorByFile = new Map<string, ConflictEntryWire>();
  for (const entry of previous) priorByFile.set(entry.file, entry);

  let changed = previous.length !== next.length;
  const entries = next.map((entry, index) => {
    const prior = priorByFile.get(entry.file);
    const reused =
      prior !== undefined && entrySignature(prior) === entrySignature(entry) ? prior : entry;
    if (reused !== previous[index]) changed = true;
    return reused;
  });
  return { entries, changed };
}

const INITIAL_VALUE: ConflictsState = {
  conflicts: [],
  loading: true,
  error: null,
  byDocName: new Map(),
};

function nextValue(
  previous: ConflictsState,
  conflicts: ConflictEntryWire[],
  error: ConflictsFetchError | undefined,
): ConflictsState {
  if (error !== undefined) {
    if (previous.error === error && !previous.loading) return previous;
    return { ...previous, loading: false, error };
  }
  const { entries, changed } = reuseUnchangedEntries(previous.conflicts, conflicts);
  if (!changed && !previous.loading && previous.error === null) return previous;
  return {
    conflicts: entries,
    loading: false,
    error: null,
    byDocName: indexByDocName(entries),
  };
}

export function ConflictsProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<ConflictsState>(INITIAL_VALUE);
  const latestRequestId = useRef(0);

  function refresh() {
    const requestId = ++latestRequestId.current;
    void fetchConflicts().then(({ conflicts: list, error: err }) => {
      if (requestId !== latestRequestId.current) return;
      setValue((previous) => nextValue(previous, list, err));
    });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is intentionally stable (defined in hook scope)
  useEffect(() => {
    refresh();
    return subscribeToDocumentsChanged((channels) => {
      if (channels.includes('sync-status')) refresh();
    });
  }, []);

  return <ConflictsContext value={{ ...value, refresh }}>{children}</ConflictsContext>;
}

export function useConflicts(): ConflictsResult {
  const value = use(ConflictsContext);
  if (value === null) return UNPROVIDED_CONFLICTS;
  return {
    conflicts: value.conflicts,
    loading: value.loading,
    error: value.error,
    refresh: value.refresh,
  };
}

export function useDocConflict(docName: string | null): ConflictEntryWire | null {
  const value = use(ConflictsContext);
  if (value === null) throw new ConflictsProviderMissingError('useDocConflict');
  if (docName === null) return null;
  return value.byDocName.get(docName) ?? null;
}
