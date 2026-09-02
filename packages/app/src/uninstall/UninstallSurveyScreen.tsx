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

interface UninstallSurveyAnswers {
  reason?: UninstallFeedbackReason;
  note?: string;
  email?: string;
}

interface UninstallSurveyScreenProps {
  onSend: (answers: UninstallSurveyAnswers) => void;
  onSkip: () => void;
}

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

      {}
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
          {}
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
