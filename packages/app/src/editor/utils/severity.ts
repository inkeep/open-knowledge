import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';

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
  label: MessageDescriptor;
}

export const SEVERITY_STYLES: Record<Severity, SeverityStyle> = {
  info: {
    wrapperClass: 'border-muted-foreground/30 bg-muted/30',
    badgeClass: 'text-muted-foreground bg-muted',
    label: msg`unknown`,
  },
  warn: {
    wrapperClass: 'border-warning/60',
    badgeClass: 'text-warning bg-warning/10',
    label: msg`render error`,
  },
  error: {
    wrapperClass: 'border-destructive/60',
    badgeClass: 'text-destructive bg-destructive/10',
    label: msg`parse error`,
  },
};
