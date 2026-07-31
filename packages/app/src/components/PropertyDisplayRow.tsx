import type { ReactNode } from 'react';

const LABEL_CLASS =
  'flex h-7 w-32 shrink-0 items-center truncate px-2 text-sm text-muted-foreground';

/**
 * Shared property display grid for editable identity rows and static previews.
 * `htmlFor` turns the key into a real label; static values use the same column
 * without claiming a label relationship.
 */
export function PropertyDisplayRow({
  icon,
  label,
  htmlFor,
  children,
  testId,
  dataKey,
}: {
  icon: ReactNode;
  label: string;
  htmlFor?: string;
  children: ReactNode;
  testId?: string;
  dataKey?: string;
}) {
  return (
    <div className="group flex items-start gap-1 py-0.5" data-testid={testId} data-key={dataKey}>
      <span aria-hidden className="h-7 w-4 shrink-0" data-slot="property-row-gutter" />
      <div className="flex items-center gap-1">
        <span className="flex size-7 shrink-0 items-center justify-center text-muted-foreground">
          {icon}
        </span>
        {htmlFor ? (
          <label htmlFor={htmlFor} className={LABEL_CLASS}>
            {label}
          </label>
        ) : (
          <span className={LABEL_CLASS}>{label}</span>
        )}
      </div>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </div>
  );
}
