import { zodResolver } from '@hookform/resolvers/zod';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { Paperclip, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { type FC, type ReactNode, useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { fileToFeedbackAttachment, submitFeedback } from '@/lib/feedback';
import { cn } from '@/lib/utils';
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from './ui/attachment';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from './ui/form';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

// Multi-select reasons, only surfaced when the "Not great" rating is chosen.
// Lazy MessageDescriptors so labels resolve against the active locale per render.
const REASONS: { value: string; label: MessageDescriptor }[] = [
  { value: 'too-slow', label: msg`Too slow` },
  { value: 'hard-to-use', label: msg`Hard to use` },
  { value: 'missing-feature', label: msg`Missing a feature` },
  { value: 'something-broke', label: msg`Something broke` },
  { value: 'formatting', label: msg`Formatting looked wrong` },
  { value: 'other', label: msg`Other` },
];

// Attachment caps. The route ships each image base64-encoded inside a single
// POST, so the total is bounded well under Vercel's ~4.5 MB body cap (base64
// inflates ~33%); the count keeps the ticket and the picker manageable.
const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENTS_TOTAL_BYTES = 3 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

// Shared selected-state look for the rating buttons and the reason pills.
const selectedStateClassName =
  'data-[state=on]:border-primary data-[state=on]:bg-primary/5 data-[state=on]:text-primary';

const pillClassName = `rounded-full border border-input bg-transparent px-3 ${selectedStateClassName}`;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Merge a fresh FileList into the current selection: keep only accepted image
// types, drop name+size duplicates, and cap at MAX_ATTACHMENTS. Total-size and
// type validation still runs in the schema so the user sees a message rather
// than a silent drop for anything this filter lets through.
function mergeAttachments(current: File[], picked: FileList | null): File[] {
  const seen = new Set(current.map((f) => `${f.name}:${f.size}`));
  const accepted = Array.from(picked ?? []).filter(
    (f) => ACCEPTED_IMAGE_TYPES.includes(f.type) && !seen.has(`${f.name}:${f.size}`),
  );
  return [...current, ...accepted].slice(0, MAX_ATTACHMENTS);
}

// Object-URL lifecycle for a single image thumbnail: created on mount, revoked
// on unmount/file-change so previews don't leak. `alt=""` — the filename lives
// in the sibling AttachmentTitle, so the thumbnail is decorative.
const AttachmentImagePreview: FC<{ file: File }> = ({ file }) => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return url ? <img src={url} alt="" className="size-full object-cover" /> : null;
};

export const FeedbackForm = ({
  onSuccess,
  source = 'resources_menu',
  compact,
  title,
  onDismiss,
  className,
}: {
  /** Called after a confirmed submit (e.g. to close the dialog). */
  onSuccess?: () => void;
  /** Which in-app surface opened the form; sent for analytics attribution. */
  source?: string;
  /**
   * Tighten spacing and type for narrow surfaces — the sidebar footer card sits
   * at `--sidebar-width` (~256px), where the dialog's rhythm overflows. Mirrors
   * `SubscribeForm`'s `compactSubmit` seam: additive and default-off, so the
   * dialog rendering is byte-identical to before.
   */
  compact?: boolean;
  /** Heading rendered above the form. Omitted surfaces supply their own (the dialog uses DialogTitle). */
  title?: ReactNode;
  /** When provided, renders a close (X) button beside the title. */
  onDismiss?: () => void;
  className?: string;
}) => {
  const { t } = useLingui();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Email is only required once the user opts into follow-ups, so its
  // validation is conditional on `shareEmail` rather than always-on.
  const schema = z
    .object({
      rating: z.enum(['positive', 'negative'], { error: t`Please choose Good or Not great.` }),
      reasons: z.array(z.string()),
      message: z.string(),
      attachments: z
        .array(z.instanceof(File))
        .max(MAX_ATTACHMENTS, t`You can attach up to ${MAX_ATTACHMENTS} images.`)
        .refine(
          (files) => files.every((f) => ACCEPTED_IMAGE_TYPES.includes(f.type)),
          t`Only PNG, JPEG, or WebP images are allowed.`,
        )
        .refine(
          (files) => files.reduce((total, f) => total + f.size, 0) <= MAX_ATTACHMENTS_TOTAL_BYTES,
          t`Attachments must total under 3 MB.`,
        ),
      shareEmail: z.boolean(),
      email: z.string(),
    })
    .refine((data) => !data.shareEmail || z.email().safeParse(data.email).success, {
      path: ['email'],
      message: t`Please enter a valid email.`,
    });

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      rating: undefined,
      reasons: [],
      message: '',
      attachments: [],
      shareEmail: false,
      email: '',
    },
  });

  const rating = useWatch({ control: form.control, name: 'rating' });

  /**
   * Compact surfaces reveal the rest of the form only once a rating is picked.
   * `rating` is required by the schema, so showing the message box, the email
   * opt-in, and Send before it is answered offers a control that cannot
   * succeed — on the sidebar card, which the user never asked for, that dead
   * end costs more than the reveal does. The dialog is opened deliberately and
   * has no height pressure, so it stays fully expanded.
   */
  const showBeyondRating = !compact || rating != null;
  const shareEmail = useWatch({ control: form.control, name: 'shareEmail' });

  // Attachments are driven directly off form state (not a FormField) so the
  // trigger can sit inside the textarea's corner while the previews render
  // below it — two spots that can't share one FormField render.
  const attachments = useWatch({ control: form.control, name: 'attachments' });
  const atMaxAttachments = attachments.length >= MAX_ATTACHMENTS;
  const attachmentsError = form.formState.errors.attachments;
  const setAttachments = (files: File[]) =>
    form.setValue('attachments', files, { shouldValidate: true });

  const onSubmit = async (data: z.infer<typeof schema>) => {
    // Guard the whole body: RHF's handleSubmit does not catch a rejected onValid
    // callback, so an unhandled throw (e.g. a FileReader read error while
    // base64-encoding an attachment) would leave isSubmitting stuck true and the
    // Send button frozen with no feedback. submitFeedback already catches its
    // own transport errors; this covers the attachment-conversion step before it.
    try {
      const attachments = data.attachments.length
        ? await Promise.all(data.attachments.map(fileToFeedbackAttachment))
        : undefined;
      const result = await submitFeedback({
        kind: 'general',
        rating: data.rating,
        reasons: data.reasons,
        message: data.message.trim() || undefined,
        email: data.shareEmail && data.email ? data.email : undefined,
        attachments,
        source,
      });
      if (result.ok) {
        toast.success(t`Thanks for the feedback!`);
        form.reset();
        onSuccess?.();
        return;
      }
      if (result.reason === 'unavailable') {
        toast.error(t`Feedback isn't available right now. Please try again later.`);
        return;
      }
      toast.error(t`Something went wrong sending your feedback. Please try again.`);
    } catch (err) {
      // Reaches here only on an unexpected throw before/around submit (e.g. a
      // FileReader read error while encoding an attachment); log for diagnosis,
      // then show the same generic error.
      console.warn(
        `[feedback] action=submit result=unexpected-error message=${err instanceof Error ? err.message : String(err)}`,
      );
      toast.error(t`Something went wrong sending your feedback. Please try again.`);
    }
  };

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className={cn(compact ? 'space-y-3' : 'space-y-5', className)}
      >
        {(title || onDismiss) && (
          <div className="flex items-start justify-between gap-2">
            {title ? <p className="font-medium text-1sm">{title}</p> : <span />}
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
        )}
        {/* Rating — single choice, drives whether the reason pills show. */}
        <FormField
          control={form.control}
          name="rating"
          render={({ field }) => (
            <FormItem>
              <FormControl>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  spacing={2}
                  // The Good/Not great options carry their own labels; the group
                  // itself needs a name so a screen reader announces what the
                  // radios are for. The visible heading is a plain <p>, not a
                  // programmatic label, so this can't be aria-labelledby to it.
                  aria-label={t`Rate your experience`}
                  value={field.value ?? ''}
                  onValueChange={(value) => {
                    if (!value) return;
                    field.onChange(value);
                    // Reasons are bad-only; drop any prior selection when the
                    // pills are hidden so they don't leak into the payload.
                    if (value === 'positive') form.setValue('reasons', []);
                  }}
                  className="w-full"
                >
                  <ToggleGroupItem
                    value="positive"
                    className={cn(
                      'h-auto flex-1 justify-center py-2',
                      compact ? 'gap-1.5 text-xs' : 'gap-2',
                      selectedStateClassName,
                    )}
                  >
                    <ThumbsUp className="size-4" />
                    <Trans>Good</Trans>
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="negative"
                    className={cn(
                      'h-auto flex-1 justify-center py-2',
                      compact ? 'gap-1.5 text-xs' : 'gap-2',
                      selectedStateClassName,
                    )}
                  >
                    <ThumbsDown className="size-4" />
                    <Trans>Not great</Trans>
                  </ToggleGroupItem>
                </ToggleGroup>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {showBeyondRating && (
          <>
            <div className="space-y-3">
              {/* Reason pills — only shown when the "Not great" rating is selected. */}
              {rating === 'negative' && (
                <FormField
                  control={form.control}
                  name="reasons"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <Trans>What got in the way?</Trans>
                      </FormLabel>
                      <FormControl>
                        <ToggleGroup
                          type="multiple"
                          variant="outline"
                          spacing={2}
                          value={field.value}
                          onValueChange={field.onChange}
                          className="w-full flex-wrap justify-start"
                        >
                          {REASONS.map((reason) => (
                            <ToggleGroupItem
                              key={reason.value}
                              value={reason.value}
                              className={pillClassName}
                            >
                              {t(reason.label)}
                            </ToggleGroupItem>
                          ))}
                        </ToggleGroup>
                      </FormControl>
                    </FormItem>
                  )}
                />
              )}

              {/* Message with the attach button tucked into its bottom-left corner —
            a real sibling button positioned over the textarea, not inside it —
            and the attachment previews rendered below. */}
              <div className="space-y-2">
                <FormField
                  control={form.control}
                  name="message"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <div className="relative">
                          <Textarea
                            {...field}
                            placeholder={t`Tell us more (optional)`}
                            className={cn('resize-none pb-9', compact ? 'min-h-16' : 'min-h-20')}
                          />
                          <Tooltip>
                            {/* Disabled buttons emit no pointer events, so the tooltip
                          trigger sits on a wrapping span (shadcn's documented
                          pattern); the button itself is truly disabled at the cap. */}
                            <TooltipTrigger asChild>
                              <span
                                className={cn(
                                  'absolute bottom-1.5 left-1.5 inline-flex',
                                  atMaxAttachments && 'cursor-not-allowed',
                                )}
                              >
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  disabled={atMaxAttachments}
                                  onClick={() => fileInputRef.current?.click()}
                                  className="size-7 text-muted-foreground"
                                >
                                  <Paperclip className="size-4" />
                                  <span className="sr-only">
                                    <Trans>Attach images</Trans>
                                  </span>
                                </Button>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              {atMaxAttachments ? (
                                <Trans>Maximum {MAX_ATTACHMENTS} attachments</Trans>
                              ) : (
                                <Trans>Attach images</Trans>
                              )}
                            </TooltipContent>
                          </Tooltip>
                          <Input
                            ref={fileInputRef}
                            type="file"
                            accept={ACCEPTED_IMAGE_TYPES.join(',')}
                            multiple
                            className="hidden"
                            onChange={(e) => {
                              setAttachments(mergeAttachments(attachments, e.target.files));
                              // Reset so re-picking the same file re-fires onChange.
                              e.target.value = '';
                            }}
                          />
                        </div>
                      </FormControl>
                    </FormItem>
                  )}
                />

                {attachments.length > 0 && (
                  <AttachmentGroup>
                    {attachments.map((file, index) => (
                      <Attachment key={`${file.name}:${file.size}`} size="xs">
                        <AttachmentMedia variant="image">
                          <AttachmentImagePreview file={file} />
                        </AttachmentMedia>
                        <AttachmentContent>
                          <AttachmentTitle>{file.name}</AttachmentTitle>
                          <AttachmentDescription>{formatFileSize(file.size)}</AttachmentDescription>
                        </AttachmentContent>
                        <AttachmentActions>
                          <AttachmentAction
                            type="button"
                            aria-label={t`Remove ${file.name}`}
                            onClick={() =>
                              setAttachments(attachments.filter((_, i) => i !== index))
                            }
                          >
                            <X className="size-3.5" />
                          </AttachmentAction>
                        </AttachmentActions>
                      </Attachment>
                    ))}
                  </AttachmentGroup>
                )}

                {attachmentsError?.message && (
                  <p className="text-destructive text-sm">{attachmentsError.message}</p>
                )}
              </div>
            </div>
            <div className="space-y-2">
              {/* Email opt-in — the address field only appears once checked. */}
              <FormField
                control={form.control}
                name="shareEmail"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center gap-2 space-y-0">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={(checked) => field.onChange(checked === true)}
                      />
                    </FormControl>
                    <FormLabel className="font-normal">
                      <Trans>Share your email for followups</Trans>
                    </FormLabel>
                  </FormItem>
                )}
              />

              {shareEmail && (
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <Input {...field} type="email" placeholder={t`you@company.com`} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
            </div>

            <div className="flex justify-end">
              <Button
                type="submit"
                size={compact ? 'sm' : 'default'}
                disabled={form.formState.isSubmitting}
              >
                {form.formState.isSubmitting ? <Trans>Sending</Trans> : <Trans>Send</Trans>}
              </Button>
            </div>
          </>
        )}
      </form>
    </Form>
  );
};
