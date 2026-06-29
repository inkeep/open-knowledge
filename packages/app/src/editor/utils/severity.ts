
type Severity = 'info' | 'warn' | 'error';

export function classifySeverity(reason: string | undefined): Severity {
  if (!reason) return 'error';
  if (reason.startsWith('Unregistered component:')) return 'info';
  if (reason.startsWith('Render error in')) return 'warn';
  return 'error';
}

interface SeverityStyle {
  wrapperClass: string;
  badgeClass: string;
  label: string;
}

export const SEVERITY_STYLES: Record<Severity, SeverityStyle> = {
  info: {
    wrapperClass: 'border-muted-foreground/30 bg-muted/30',
    badgeClass: 'text-muted-foreground bg-muted',
    label: 'unknown',
  },
  warn: {
    wrapperClass:
      'border-amber-400/60 dark:border-amber-500/40 bg-amber-50/50 dark:bg-amber-900/10',
    badgeClass: 'text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/30',
    label: 'render error',
  },
  error: {
    wrapperClass: 'border-destructive/60 bg-destructive/5',
    badgeClass: 'text-destructive bg-destructive/10',
    label: 'parse error',
  },
};
