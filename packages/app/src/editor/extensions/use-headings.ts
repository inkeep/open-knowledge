import type { HeadingEntry } from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';
import { fetchHeadings } from './wiki-link-suggestion';

export function useHeadings(docName: string, enabled: boolean): HeadingEntry[] | null {
  const [headings, setHeadings] = useState<HeadingEntry[] | null>(null);

  useEffect(() => {
    if (!enabled || !docName) {
      setHeadings(null);
      return;
    }

    let cancelled = false;
    setHeadings(null);

    void fetchHeadings(docName)
      .then((next) => {
        if (!cancelled) {
          setHeadings(next);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHeadings([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [docName, enabled]);

  return headings;
}
