import { useLingui } from '@lingui/react/macro';
import { Loader2Icon, type LucideIcon, type LucideProps } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Loading spinner.
 *
 * Hand-authored from shadcn/ui's default-style `spinner` rather than installed via
 * `shadcn add`: this project's configured `radix-nova` style ships a Spinner that
 * imports `IconPlaceholder` from a path internal to the shadcn website, which does
 * not resolve here.
 *
 * Two deliberate divergences from upstream, recorded so a future `shadcn diff`
 * reviewer knows the drift is intentional rather than rot:
 *   1. `motion-reduce:animate-none` — makes reduced motion the default instead of
 *      something each call site has to remember. Continuous spin is a vestibular
 *      trigger, so opting out per call site is the wrong default.
 *   2. `icon` — lets call sites whose glyph shape carries meaning (RefreshCw for
 *      syncing, Undo2 for reverting) use this primitive instead of hand-rolling
 *      `animate-spin`.
 * The `aria-label` is localized rather than upstream's hardcoded English.
 *
 * Props spread last, so callers override `role` / `aria-label` / `aria-hidden`.
 * Pass `aria-hidden="true"` wherever a wrapper or enclosing control already names
 * the loading state — otherwise assistive tech announces it twice.
 */
function Spinner({
  className,
  icon: Icon = Loader2Icon,
  ...props
}: LucideProps & { icon?: LucideIcon }) {
  const { t } = useLingui();

  return (
    <Icon
      role="status"
      aria-label={t`Loading`}
      // biome-ignore lint/plugin/no-hand-rolled-spinner: this is the primitive the rule points callers to
      className={cn('size-4 animate-spin motion-reduce:animate-none', className)}
      {...props}
    />
  );
}

export { Spinner };
