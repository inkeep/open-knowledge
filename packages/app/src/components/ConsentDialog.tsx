/**
 * Per-project consent dialog — thin lazy-loading gate.
 *
 * Renders only inside the Navigator (`main.tsx` mode === 'navigator'); the
 * editor renderer never receives `ok:onboarding:show`. Subscribes to
 * `consentStore` and renders nothing until main fires the show event and the
 * store becomes non-null. **The dialog body is behind `React.lazy()`** — the
 * checkbox/textarea/preview UI only loads when a fresh-folder pick triggers
 * the dialog, keeping the Navigator's first paint lean.
 */

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
