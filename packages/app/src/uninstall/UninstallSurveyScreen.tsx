import {
  UNINSTALL_FEEDBACK_EMAIL_MAX_LEN,
  UNINSTALL_FEEDBACK_NOTE_MAX_LEN,
  UNINSTALL_FEEDBACK_REASONS,
  type UninstallFeedbackReason,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';

/** What the user left behind; every field is absent when untouched. */
interface UninstallSurveyAnswers {
  reason?: UninstallFeedbackReason;
  note?: string;
  email?: string;
}

interface UninstallSurveyScreenProps {
  /** Send the answers and continue the uninstall. */
  onSend: (answers: UninstallSurveyAnswers) => void;
  /** Continue the uninstall having asked nothing. */
  onSkip: () => void;
}

/**
 * The reason labels, translated.
 *
 * `UNINSTALL_FEEDBACK_REASONS` stays the source of the taxonomy — its order and
 * its `value` slugs are the wire contract — but its `label` half is plain
 * English for the two consumers that have no Lingui (Electron main, the CLI).
 * This window does have Lingui, so it renders its own translated labels and
 * keeps the English ones verbatim. A test pins both halves together, so adding
 * a reason without a label here fails rather than rendering a blank row.
 */
function useUninstallReasonLabels(): Record<UninstallFeedbackReason, string> {
  const { t } = useLingui();
  return {
    'workflow-fit': t`It didn't fit into my workflow`,
    'missing-feature': t`It was missing a feature I needed`,
    'hard-to-start': t`It was too hard to set up or get started`,
    unreliable: t`Bugs, crashes, or it felt unreliable`,
    'switched-tool': t`I'm switching to another tool`,
    'one-off': t`It was a trial or one-off project`,
    other: t`Something else`,
  };
}

/**
 * The optional churn survey, shown after the uninstall is already confirmed and
 * the removal has already succeeded.
 *
 * Both buttons continue the uninstall — this screen has no cancel path — and
 * nothing here is required, so it deliberately has no Escape handler: the only
 * exits are the two buttons or a deliberate window close, which main maps to
 * "continue with nothing".
 */
export function UninstallSurveyScreen({ onSend, onSkip }: UninstallSurveyScreenProps) {
  const { t } = useLingui();
  const reasonLabels = useUninstallReasonLabels();
  const [reason, setReason] = useState<string>('');
  const [note, setNote] = useState('');
  const [emailOptIn, setEmailOptIn] = useState(false);
  const [email, setEmail] = useState('');
  const emailRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const egressId = useId();
  const legendId = useId();
  const noteId = useId();
  const optInId = useId();
  const emailId = useId();

  useEffect(() => {
    if (emailOptIn) emailRef.current?.focus();
  }, [emailOptIn]);

  return (
    <div
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={egressId}
      className="flex h-dvh flex-col bg-background text-foreground"
    >
      <header className="px-6 pt-5 pb-3.5 space-y-4">
        <h1 id={titleId} className="font-medium leading-none text-base">
          <Trans>Thanks for giving OpenKnowledge a try.</Trans>
        </h1>
        <p id={egressId} className="text-muted-foreground text-sm">
          <Trans>What you share is sent to the OpenKnowledge team.</Trans>
        </p>
      </header>

      {/* A real form, so a malformed address trips the browser's own validation
          instead of 400-ing the whole ticket away at the intake. */}
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmedNote = note.trim();
          const trimmedEmail = emailOptIn ? email.trim() : '';
          onSend({
            ...(reason === '' ? {} : { reason: reason as UninstallFeedbackReason }),
            ...(trimmedNote === '' ? {} : { note: trimmedNote }),
            ...(trimmedEmail === '' ? {} : { email: trimmedEmail }),
          });
        }}
      >
        <div className="subtle-scrollbar min-h-0 flex-1 overflow-y-auto px-6 pt-1 pb-4">
          {/* The heading is a plain element rather than a fieldset/legend: Radix
              already gives the list `role="radiogroup"`, so a legend would wrap
              it in a second labelled group and announce the question twice. */}
          <div className="mb-6">
            <p id={legendId} className="mb-2 font-medium text-sm">
              <Trans>Before you go, mind sharing why?</Trans>
            </p>
            <RadioGroup aria-labelledby={legendId} value={reason} onValueChange={setReason}>
              {UNINSTALL_FEEDBACK_REASONS.map((option) => (
                <div key={option.value} className="flex items-center gap-2.5 rounded-md px-1 py-1">
                  <RadioGroupItem id={`${legendId}-${option.value}`} value={option.value} />
                  <Label
                    htmlFor={`${legendId}-${option.value}`}
                    className="font-normal text-sm leading-snug"
                  >
                    {reasonLabels[option.value]}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>

          <div className="mb-6">
            <Label htmlFor={noteId} className="mb-2 font-medium text-sm">
              <Trans>Anything you'd like to add? (optional)</Trans>
            </Label>
            <Textarea
              id={noteId}
              rows={3}
              maxLength={UNINSTALL_FEEDBACK_NOTE_MAX_LEN}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>

          <div className="mb-2 flex items-center gap-2.5">
            <Checkbox
              id={optInId}
              checked={emailOptIn}
              onCheckedChange={(next) => setEmailOptIn(next === true)}
            />
            <Label htmlFor={optInId} className="font-medium text-sm">
              <Trans>Let us follow up by email</Trans>
            </Label>
          </div>

          <div className="mb-6" hidden={!emailOptIn}>
            <Label htmlFor={emailId} className="mb-2 font-medium text-sm sr-only">
              <Trans>Email address</Trans>
            </Label>
            <Input
              id={emailId}
              ref={emailRef}
              type="email"
              maxLength={UNINSTALL_FEEDBACK_EMAIL_MAX_LEN}
              autoComplete="email"
              spellCheck={false}
              placeholder={t`you@company.com`}
              // Disabled, not merely hidden: a hidden-but-validatable field makes
              // the browser silently refuse the submit (it cannot focus what it
              // must report on), which would strand the user on a screen with no
              // visible problem.
              disabled={!emailOptIn}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
        </div>

        <footer className="flex items-center justify-end gap-2.5 border-border border-t bg-muted/50 px-6 pt-3.5 pb-4">
          <Button type="button" variant="outline-mono" autoFocus onClick={onSkip}>
            <Trans>Skip</Trans>
          </Button>
          <Button type="submit">
            <Trans>Send & continue</Trans>
          </Button>
        </footer>
      </form>
    </div>
  );
}
