/**
 * Tab — single panel inside a `<Tabs>` container.
 *
 * Pure presentational. Renders an inline `data-tab-label` and `data-tab-id`
 * so the parent Tabs's DOM walk can read the strip label and the panel's
 * ARIA-pairing id without observing the contentDOM. NO DOM mutation, NO
 * useEffect, NO refs — just JSX.
 *
 * The panel id falls back to a stable `useId()` when no user-provided `id`
 * is set, so every Tab carries `aria-labelledby` pointing at its strip
 * pill regardless of whether the author opted into a deep-link id.
 *
 * Active-state visibility is owned by the parent Tabs's CSS rule (in
 * `globals.css`), keyed off `data-active-index` on the Tabs's content
 * wrapper + `:nth-of-type` of this Tab among its siblings.
 */

import { useId } from 'react';

interface TabProps {
  label?: string;
  id?: string;
  children?: React.ReactNode;
}

export function Tab({ label, id, children }: TabProps) {
  const internalId = useId();
  const panelId = id || `tab-panel-${internalId.replace(/:/g, '')}`;
  const tabButtonId = `${panelId}-tab`;
  const safeLabel = label?.trim() || 'Tab';
  return (
    <section
      className="tab-panel"
      id={panelId}
      role="tabpanel"
      aria-labelledby={tabButtonId}
      data-tab-label={safeLabel}
      data-tab-id={panelId}
    >
      {children}
    </section>
  );
}
