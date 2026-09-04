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
