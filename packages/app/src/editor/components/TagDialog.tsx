
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useRef, useState } from 'react';
import {
  DialogBody,
  DialogContent,
  DialogHeader,
  Dialog as DialogRoot,
  DialogTitle,
} from '@/components/ui/dialog';
import { TAG_CLICK_EVENT, type TagClickEventDetail } from '@/editor/extensions/tag-click-plugin';
import { hashFromDocName } from '@/lib/doc-hash';
import { parseApiError } from '@/lib/parse-api-error';

interface TagDocEntry {
  docName: string;
  title: string;
  matchingTags?: string[];
  snippet: string | null;
}

interface TagApiSuccessBody {
  name: string;
  docs: TagDocEntry[];
}

type FetchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; docs: TagDocEntry[] }
  | { kind: 'error'; message: string };

async function fetchTagDocs(value: string): Promise<TagDocEntry[]> {
  const res = await fetch(`/api/tags/${encodeURIComponent(value)}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as unknown;
    const status = res.status;
    const statusText = res.statusText;
    throw new Error(parseApiError(body) ?? t`Server error: ${status} ${statusText}`);
  }
  const data = (await res.json()) as TagApiSuccessBody;
  return data.docs ?? [];
}

export function TagDialog() {
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState<string | null>(null);
  const [fetchState, setFetchState] = useState<FetchState>({ kind: 'idle' });
  const fetchSeqRef = useRef(0);

  useEffect(() => {
    function onTagClick(event: Event): void {
      const detail = (event as CustomEvent<TagClickEventDetail>).detail;
      if (!detail || typeof detail.value !== 'string') return;
      const seq = ++fetchSeqRef.current;
      setTag(detail.value);
      setOpen(true);
      setFetchState({ kind: 'loading' });
      fetchTagDocs(detail.value)
        .then((docs) => {
          if (fetchSeqRef.current !== seq) return;
          setFetchState({ kind: 'ready', docs });
        })
        .catch((err) => {
          if (fetchSeqRef.current !== seq) return;
          setFetchState({
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        });
    }
    document.addEventListener(TAG_CLICK_EVENT, onTagClick);
    return () => document.removeEventListener(TAG_CLICK_EVENT, onTagClick);
  }, []);

  function navigateTo(docName: string): void {
    setOpen(false);
    window.location.assign(hashFromDocName(docName));
  }

  const tagName = tag ?? '';

  return (
    <DialogRoot open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>
              Documents tagged <span className="font-mono">#{tagName}</span>
            </Trans>
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <TagDialogBody fetchState={fetchState} tag={tag ?? ''} onSelectDoc={navigateTo} />
        </DialogBody>
      </DialogContent>
    </DialogRoot>
  );
}

interface TagDialogBodyProps {
  fetchState: FetchState;
  tag: string;
  onSelectDoc: (docName: string) => void;
}

export function TagDialogBody({ fetchState, tag, onSelectDoc }: TagDialogBodyProps) {
  if (fetchState.kind === 'idle' || fetchState.kind === 'loading') {
    return (
      <p className="text-muted-foreground text-sm" data-testid="tag-dialog-loading">
        <Trans>Loading</Trans>
      </p>
    );
  }
  if (fetchState.kind === 'error') {
    return (
      <p className="text-destructive text-sm" data-testid="tag-dialog-error">
        {fetchState.message}
      </p>
    );
  }
  if (fetchState.docs.length === 0) {
    return (
      <p className="text-muted-foreground text-sm" data-testid="tag-dialog-empty">
        <Trans>
          Only the current document uses <span className="font-mono">#{tag}</span>.
        </Trans>
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1" data-testid="tag-dialog-list">
      {fetchState.docs.map((doc) => {
        const matches = doc.matchingTags ?? [];
        return (
          <li key={doc.docName}>
            <button
              type="button"
              className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
              onClick={() => onSelectDoc(doc.docName)}
              data-testid="tag-dialog-row"
            >
              <span className="block truncate font-medium">{doc.title}</span>
              {doc.docName !== doc.title ? (
                <span className="block truncate text-xs text-muted-foreground">{doc.docName}</span>
              ) : null}
              {matches.length > 0 ? (
                <span
                  className="mt-1 flex flex-wrap items-center gap-1"
                  data-testid="tag-dialog-row-matches"
                >
                  {matches.map((m) => (
                    <span
                      key={m}
                      data-testid="tag-dialog-row-match"
                      data-tag={m}
                      className="tag pointer-events-none text-xs"
                    >
                      #{m}
                    </span>
                  ))}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
