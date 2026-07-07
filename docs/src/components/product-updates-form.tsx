'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { MarketingButton } from '@/components/marketing-button';
import { Input } from '@/components/ui/input';

const subscribeSchema = z.object({
  email: z.email({ message: 'Please enter a valid email address.' }),
});

type SubscribeValues = z.infer<typeof subscribeSchema>;

// Compact email-capture form for the docs "On this page" TOC column. POSTs to
// /api/subscribe, which the microfrontends
// group routes to the ok-marketing app (see docs/microfrontends.json).
export function ProductUpdatesForm() {
  const [submitFailed, setSubmitFailed] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const successRef = useRef<HTMLParagraphElement>(null);

  // After a successful submit the input + button unmount and the confirmation
  // replaces them; move focus to it so keyboard/SR focus isn't orphaned.
  useEffect(() => {
    if (subscribed) successRef.current?.focus();
  }, [subscribed]);

  const form = useForm<SubscribeValues>({
    resolver: zodResolver(subscribeSchema),
    defaultValues: { email: '' },
  });

  async function onSubmit(values: SubscribeValues) {
    setSubmitFailed(false);
    try {
      const response = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `source` is a bounded allowlist enforced by the /api/subscribe route
        // (in ok-marketing); 'docs_toc' tags signups from this TOC form.
        body: JSON.stringify({ ...values, source: 'docs_toc' }),
      });
      if (response.ok) {
        form.reset();
        setSubscribed(true);
      } else {
        setSubmitFailed(true);
      }
    } catch (err) {
      console.error(
        `[product-updates-form] fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      setSubmitFailed(true);
    }
  }

  return (
    <div className="mt-6 border-t border-fd-border pt-4">
      <p className="mb-2 text-1sm font-medium text-fd-foreground">Product updates</p>
      {subscribed ? (
        <p
          ref={successRef}
          tabIndex={-1}
          className="text-xs text-fd-muted-foreground focus:outline-none"
          role="status"
        >
          Thanks for subscribing. Watch your inbox for product updates.
        </p>
      ) : (
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-2" noValidate>
          <Controller
            control={form.control}
            name="email"
            render={({ field, fieldState }) => (
              <div className="flex flex-col gap-1.5">
                <label htmlFor={field.name} className="sr-only">
                  Email
                </label>
                {/* Combined input + submit control (mirrors the OK app's
                    InputGroup pattern) built from the docs primitives: a pill
                    wrapper owns the border + focus ring, the Input renders
                    borderless, and the submit button sits inside on the right. */}
                <div
                  data-invalid={fieldState.invalid}
                  className="flex h-11 items-center rounded-xl border border-input bg-fd-background pr-1 transition-colors focus-within:border-slide-accent focus-within:ring-2 focus-within:ring-slide-accent/40 data-[invalid=true]:border-red-500"
                >
                  <Input
                    {...field}
                    id={field.name}
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    spellCheck={false}
                    placeholder="my@email.com"
                    aria-invalid={fieldState.invalid}
                    className="h-full flex-1 rounded-xl border-0 bg-transparent px-3 text-sm shadow-none focus-visible:border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                  />
                  <MarketingButton
                    type="submit"
                    variant="primary"
                    size="sm"
                    disabled={form.formState.isSubmitting}
                    className="h-8 shrink-0 rounded-lg px-3"
                  >
                    Subscribe
                  </MarketingButton>
                </div>
                {fieldState.error ? (
                  <p className="px-1 text-xs text-red-500" role="alert">
                    {fieldState.error.message}
                  </p>
                ) : null}
              </div>
            )}
          />
          {submitFailed ? (
            <p className="px-1 text-xs text-red-500" role="alert">
              Something went wrong. Please try again.
            </p>
          ) : null}
        </form>
      )}
    </div>
  );
}
