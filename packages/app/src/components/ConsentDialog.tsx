
import { lazy, Suspense, useSyncExternalStore } from 'react';
import { consentStore } from '@/lib/consent-store';

const LazyConsentDialogBody = lazy(() => import('./ConsentDialogBody'));

export function ConsentDialog() {
  const hasPayload = useSyncExternalStore(
    consentStore.subscribe,
    () => consentStore.getSnapshot() !== null,
    () => false,
  );
  if (!hasPayload) return null;
  return (
    <Suspense fallback={null}>
      <LazyConsentDialogBody />
    </Suspense>
  );
}
