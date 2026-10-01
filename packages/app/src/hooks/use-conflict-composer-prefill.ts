import { useLingui } from '@lingui/react/macro';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { useConflicts } from '@/hooks/use-conflicts';
import { buildResolveDraft, isLegacyResolveDraft } from '@/lib/conflict-resolve-draft';

interface PrefillTarget {
  getContent: () => { instruction: string; mentions: string[] };
  setText: (text: string) => void;
  clear: () => void;
}

interface PrefillState {
  isSeedIntact: boolean;
  onContentChanged: () => void;
}

function isSeedText(text: string, conflictFilesKey: string, lastSeed: string | null): boolean {
  if (text === '') return false;
  if (text === lastSeed) return true;
  return conflictFilesKey
    .split('\u0000')
    .some((file) => buildResolveDraft(file) === text || isLegacyResolveDraft(text, file));
}

export function useConflictComposerPrefill(
  docName: string | null,
  inputRef: RefObject<PrefillTarget | null>,
): PrefillState {
  const { conflicts } = useConflicts();
  const { i18n } = useLingui();
  const conflictFile =
    docName === null ? undefined : conflicts.find((entry) => entry.docName === docName)?.file;

  const conflictFilesKey = conflicts
    .map((entry) => entry.file)
    .sort()
    .join('\u0000');

  const [isSeedIntact, setIsSeedIntact] = useState(false);
  const lastSeedRef = useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: i18n.locale re-runs recognition after activation because buildResolveDraft reads the active locale.
  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    const current = input.getContent().instruction;
    const holdsIntactSeed = isSeedText(current, conflictFilesKey, lastSeedRef.current);

    if (conflictFile === undefined) {
      if (holdsIntactSeed) input.clear();
      lastSeedRef.current = null;
      setIsSeedIntact(false);
      return;
    }

    if (current !== '' && !holdsIntactSeed) return;

    const draft = buildResolveDraft(conflictFile);
    if (current === draft) {
      lastSeedRef.current = current;
      setIsSeedIntact(true);
      return;
    }

    input.setText(draft);
    lastSeedRef.current = draft;
    setIsSeedIntact(true);
  }, [conflictFile, conflictFilesKey, inputRef, i18n.locale]);

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
