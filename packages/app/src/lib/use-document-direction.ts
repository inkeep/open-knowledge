import type { TextDirection } from '@inkeep/open-knowledge-core/i18n/direction';
import { useSyncExternalStore } from 'react';

function subscribeDocumentDirection(listener: () => void): () => void {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['dir'] });
  return () => observer.disconnect();
}

export function currentDocumentDirection(): TextDirection {
  return document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr';
}

export function useDocumentDirection(): TextDirection {
  return useSyncExternalStore(subscribeDocumentDirection, currentDocumentDirection, () => 'ltr');
}
