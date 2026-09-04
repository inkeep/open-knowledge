import { useLingui } from '@lingui/react/macro';
import { Loader2Icon, type LucideIcon, type LucideProps } from 'lucide-react';
import { cn } from '@/lib/utils';

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
