// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import { zodResolver } from '@hookform/resolvers/zod';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowRight, Check, Mail, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Spinner } from '@/components/ui/spinner';
import { type SubscribeSource, submitSubscribe } from '@/lib/subscribe';
import { cn } from '@/lib/utils';

interface SubscribeValues {
  email: string;
}

export interface SubscribeFormProps {
  source: SubscribeSource;
  title?: ReactNode;
  description?: ReactNode;
  onSuccess?: () => void;
  onDismiss?: () => void;
  autoFocus?: boolean;
  compactSubmit?: boolean;
  className?: string;
}

export function SubscribeForm({
  source,
  title,
  description,
  onSuccess,
  onDismiss,
  autoFocus,
  compactSubmit,
  className,
}: SubscribeFormProps) {
  const { t } = useLingui();
  const [subscribed, setSubscribed] = useState(false);
  const successHeadingRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (subscribed) successHeadingRef.current?.focus();
  }, [subscribed]);

  const schema = z.object({
    email: z.email({ message: t`Please enter a valid email address.` }),
  });

  const form = useForm<SubscribeValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '' },
  });

  const { isSubmitting } = form.formState;
  const errorMessage = form.formState.errors.email?.message ?? form.formState.errors.root?.message;

  async function onSubmit(values: SubscribeValues) {
    form.clearErrors('root');
    const result = await submitSubscribe(values.email, source);
    if (result.ok) {
      setSubscribed(true);
      onSuccess?.();
      return;
    }
    if (result.reason === 'invalid') {
      form.setError('email', { message: t`Please enter a valid email address.` });
      return;
    }
    if (result.reason === 'unavailable') {
      form.setError('root', { message: t`Subscriptions aren't available right now.` });
      return;
    }
    form.setError('root', { message: t`Something went wrong. Please try again.` });
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          {}
          <p
            ref={successHeadingRef}
            tabIndex={subscribed ? -1 : undefined}
            className="text-sm font-medium leading-tight text-foreground focus:outline-none"
          >
            {subscribed ? (
              <span className="mb-1.5 inline-flex flex-row items-center gap-2">
                <Check className="size-4 text-primary" />
                <Trans>You're subscribed!</Trans>
              </span>
            ) : (
              (title ?? <Trans>Stay in the loop</Trans>)
            )}
          </p>
          {}
          <p className="text-1sm text-muted-foreground" role="status">
            {subscribed ? (
              <Trans>Thanks for subscribing. Watch your inbox for product updates.</Trans>
            ) : (
              (description ?? <Trans>Get product updates in your inbox.</Trans>)
            )}
          </p>
        </div>
        {onDismiss ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onDismiss}
            aria-label={t`Close`}
            className="-mr-1.5 -mt-1 size-7 shrink-0 text-muted-foreground opacity-60"
          >
            <X className="size-4" />
          </Button>
        ) : null}
      </div>

      {subscribed ? null : (
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-2" noValidate>
          <Controller
            control={form.control}
            name="email"
            render={({ field, fieldState }) => (
              <InputGroup className="h-10 rounded-xl">
                <InputGroupAddon className="pl-2.5">
                  <Mail className="size-4 text-muted-foreground opacity-60" />
                </InputGroupAddon>
                <InputGroupInput
                  {...field}
                  id={field.name}
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  spellCheck={false}
                  autoFocus={autoFocus}
                  placeholder={t`my@email.com`}
                  aria-invalid={fieldState.invalid}
                  aria-label={t`Email address`}
                  data-testid="subscribe-email"
                  className="placeholder:text-muted-foreground/60"
                />
                <Button
                  type="submit"
                  disabled={isSubmitting}
                  size={compactSubmit ? 'icon' : 'default'}
                  className={cn(
                    'mr-1 ml-auto text-1sm',
                    compactSubmit && 'size-8 shrink-0 rounded-lg',
                  )}
                  data-testid="subscribe-submit"
                >
                  {isSubmitting ? (
                    <>
                      <Spinner className="size-3.5" aria-hidden />
                      <span className="sr-only">
                        <Trans>Subscribing...</Trans>
                      </span>
                    </>
                  ) : compactSubmit ? (
                    <>
                      <ArrowRight className="size-4" aria-hidden />
                      <span className="sr-only">
                        <Trans>Subscribe</Trans>
                      </span>
                    </>
                  ) : (
                    <Trans>Subscribe</Trans>
                  )}
                </Button>
              </InputGroup>
            )}
          />
          {errorMessage ? (
            <p className="text-sm text-destructive" role="alert">
              {errorMessage}
            </p>
          ) : null}
        </form>
      )}
    </div>
  );
}
