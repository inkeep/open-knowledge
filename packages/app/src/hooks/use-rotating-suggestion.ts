import { useEffect, useState } from 'react';

export const SUGGESTION_HOLD_MS = 5200;
export const SUGGESTION_FADE_MS = 500;

export function useRotatingSuggestion(
  phrases: readonly string[],
  enabled: boolean,
): { text: string; visible: boolean } {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);
  const [phraseCount, setPhraseCount] = useState(phrases.length);
  if (phraseCount !== phrases.length) {
    setPhraseCount(phrases.length);
    setIndex(0);
    setVisible(true);
  }

  useEffect(() => {
    if (!enabled) return;
    if (visible) {
      const id = setTimeout(() => setVisible(false), SUGGESTION_HOLD_MS);
      return () => clearTimeout(id);
    }
    const id = setTimeout(() => {
      setIndex((i) => i + 1);
      setVisible(true);
    }, SUGGESTION_FADE_MS);
    return () => clearTimeout(id);
  }, [visible, enabled]);

  if (!enabled) return { text: phrases[0] ?? '', visible: true };
  const safeIndex = phrases.length > 0 ? index % phrases.length : 0;
  return { text: phrases[safeIndex] ?? '', visible };
}
