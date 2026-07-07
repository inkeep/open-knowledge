/**
 * Severity taxonomy for `rawMdxFallback` chrome (and any future invalid-state
 * surface). Three levels, distinguished both by color AND by label so the
 * signal survives colorblind users, monochrome screenshots, and small badges.
 *
 *   info  — valid MDX for a component we don't render here (e.g. `<DataViz>`).
 *           The document is fine; a downstream target may render it. Muted
 *           styling, label `unknown` — matches the "Unknown component: X"
 *           placeholder copy surfaced by `JsxComponentView`.
 *   warn  — a registered component threw at render time. Doc is structurally
 *           valid; the component is misbehaving. Amber styling — attention.
 *   error — MDX failed to parse. The source is actively broken and won't
 *           round-trip cleanly. Destructive styling — fix required.
 *
 * Severity is derived from the `reason` string stamped on the node at the
 * moment of conversion. The two friendly prefixes (`Unregistered component:`
 * and `Render error in`) are set by `JsxComponentView.tsx`; everything else
 * (parse failures from `parseWithFallback`, unknown causes) falls through to
 * `error`. Derivation avoids a new schema attr and keeps classification
 * logic in one testable place.
 */

type Severity = 'info' | 'warn' | 'error';

export function classifySeverity(reason: string | undefined): Severity {
  if (!reason) return 'error';
  if (reason.startsWith('Unregistered component:')) return 'info';
  if (reason.startsWith('Render error in')) return 'warn';
  return 'error';
}

interface SeverityStyle {
  /** Tailwind classes applied to the wrapper's border + background. */
  wrapperClass: string;
  /** Tailwind classes applied to the status badge. */
  badgeClass: string;
  /** Short uppercase label shown in the badge. */
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
