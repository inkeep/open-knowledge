/**
 * Seeds the Ask AI composer with the resolve-conflicts instruction while the
 * open document is conflicted. This is the only entry point to that payload —
 * the conflict toolbar carries no AI control.
 *
 * The load-bearing part is `isSeedIntact`, not the seeding. A seeded draft is
 * byte-indistinguishable from a typed one, and the composer treats a non-empty
 * draft as "the user is composing" — which drives touched-file accumulation, so
 * an unadvertised seed makes every conflicted doc the user clicks attach itself
 * as context they never asked for. Anything else keyed on emptiness has the
 * same trap, hence a flag the composer can consult rather than a fix at one
 * call site.
 *
 * The seed is withdrawn only while untouched. Once the user edits it the text
 * is theirs: it stops tracking the open document, survives leaving the
 * conflict, and counts as composing like any other draft.
 *
 * Recognition is by CONTENT, not by remembering what was written. The draft is
 * persisted to localStorage, so a seed outlives the process that wrote it and
 * comes back at mount looking exactly like something the user typed — an
 * in-memory record of "what I seeded" is null precisely when it is needed, and
 * the restored seed then reads as a draft in progress for the rest of the
 * session.
 */

import { type RefObject, useEffect, useRef, useState } from 'react';
import { useConflicts } from '@/hooks/use-conflicts';
import { buildResolveDraft } from '@/lib/conflict-resolve-draft';
import { filePathToDocName } from '@/lib/doc-hash';

interface PrefillTarget {
  getContent: () => { instruction: string; mentions: string[] };
  setText: (text: string) => void;
  clear: () => void;
}

interface PrefillState {
  /** Whether the composer currently holds this hook's seed, unedited. False
   *  whenever the draft is empty, user-authored, or user-modified. */
  isSeedIntact: boolean;
  /** Call on every composer content change so an edit retires the seed. */
  onContentChanged: () => void;
}

/**
 * Whether a draft is one of this hook's own seeds, rather than user text.
 *
 * Matched by CONTENT against every currently-tracked conflict, because the
 * draft persists to localStorage: a seed outlives the process that wrote it and
 * returns at mount looking exactly like something the user typed, so an
 * in-memory record is null precisely when it is needed. `lastSeed` covers the
 * opposite gap — a seed whose file has just left the conflict list, which is
 * when it must be withdrawn and when content matching can no longer see it.
 *
 * Module-level and argument-taking so it is not a hook dependency: as a closure
 * it is re-created every render, and the exhaustive-deps autofix adds it to the
 * effect's dependency array, which then re-runs forever.
 */
function isSeedText(text: string, conflictFilesKey: string, lastSeed: string | null): boolean {
  if (text === '') return false;
  if (text === lastSeed) return true;
  return conflictFilesKey.split('\u0000').some((file) => buildResolveDraft(file) === text);
}

export function useConflictComposerPrefill(
  docName: string | null,
  inputRef: RefObject<PrefillTarget | null>,
): PrefillState {
  const { conflicts } = useConflicts();
  const conflictFile =
    docName === null
      ? undefined
      : conflicts.find((entry) => filePathToDocName(entry.file) === docName)?.file;

  // Stable across renders that re-derive an equal conflict list.
  const conflictFilesKey = conflicts
    .map((entry) => entry.file)
    .sort()
    .join('\u0000');

  const [isSeedIntact, setIsSeedIntact] = useState(false);
  // Content recognition cannot identify a seed once its file leaves the
  // conflict list, which is exactly when the seed must be withdrawn. This
  // covers that window; it is deliberately not the primary signal, because it
  // is empty on the mount that restores a persisted seed.
  const lastSeedRef = useRef<string | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    const current = input.getContent().instruction;
    const holdsIntactSeed = isSeedText(current, conflictFilesKey, lastSeedRef.current);

    if (conflictFile === undefined) {
      // Left the conflict — navigated away, or the agent resolved it.
      if (holdsIntactSeed) input.clear();
      lastSeedRef.current = null;
      setIsSeedIntact(false);
      return;
    }

    // Seed into an empty composer, and re-seed when the standing draft is this
    // hook's own untouched seed for a different file — a user clicking between
    // conflicted docs should not be told to resolve the one they just left.
    // Never over a draft the user wrote: a conflict can arrive from a background
    // sync while they are mid-sentence on something unrelated.
    if (current !== '' && !holdsIntactSeed) return;

    const draft = buildResolveDraft(conflictFile);
    if (current === draft) {
      // Already correct — a seed restored from a previous session for the doc
      // that is open. Still needs claiming, or it reads as a draft in progress.
      lastSeedRef.current = current;
      setIsSeedIntact(true);
      return;
    }

    // `setText` calls the host's change relay synchronously, so this write
    // arrives at `onContentChanged` looking like typing and momentarily retires
    // the seed. The two lines below re-establish it in the same pass and React
    // batches the flag, so no guard is needed — a test that removes one cannot
    // fail, which is why there isn't one.
    input.setText(draft);
    lastSeedRef.current = draft;
    setIsSeedIntact(true);
  }, [conflictFile, conflictFilesKey, inputRef]);

  return {
    isSeedIntact,
    onContentChanged: () => {
      const current = inputRef.current?.getContent().instruction ?? '';
      const stillSeed = isSeedText(current, conflictFilesKey, lastSeedRef.current);
      if (!stillSeed) lastSeedRef.current = null;
      setIsSeedIntact(stillSeed);
    },
  };
}
