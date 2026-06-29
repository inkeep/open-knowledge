import { useLingui } from '@lingui/react/macro';
import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  type CreateScenario,
  useCreateSuggestions,
} from '@/components/empty-state/use-create-suggestions';
import { Button } from '@/components/ui/button';
import { scheduleClipboardWrite } from '@/lib/share/clipboard-adapter';
import { cn } from '@/lib/utils';

interface CopyablePromptListProps {
  readonly scenario: CreateScenario;
  readonly className?: string;
}

export function CopyablePromptList({ scenario, className }: CopyablePromptListProps) {
  const { t } = useLingui();
  const suggestions = useCreateSuggestions(scenario);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(resetTimerRef.current), []);

  function handleCopy(id: string, prompt: string) {
    void scheduleClipboardWrite(prompt)
      .then(() => {
        setCopiedId(id);
        clearTimeout(resetTimerRef.current);
        resetTimerRef.current = setTimeout(() => setCopiedId(null), 1600);
      })
      .catch(() => {
      });
  }

  return (
    <ul
      className={cn(
        'w-full divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60 bg-card',
        className,
      )}
    >
      {suggestions.map((suggestion) => {
        const Icon = suggestion.icon;
        const copied = copiedId === suggestion.id;
        return (
          <li
            key={suggestion.id}
            className="group flex items-start gap-3 p-3.5"
            data-testid={`copy-prompt-${suggestion.id}`}
          >
            {/* mt-0.5 optically centers the icon on the title line (vs the
                two-line label/preview block). */}
            <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="text-sm font-medium leading-tight text-foreground">
                {suggestion.label}
              </span>
              <span className="truncate text-1sm leading-relaxed text-muted-foreground">
                {suggestion.prompt}
              </span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => handleCopy(suggestion.id, suggestion.prompt)}
              aria-label={copied ? t`Copied` : t`Copy ${suggestion.label} prompt`}
              className={cn(
                'shrink-0 gap-1.5 transition-opacity focus-visible:opacity-100 uppercase font-mono',
                copied ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
              )}
              data-testid={`copy-prompt-button-${suggestion.id}`}
            >
              {copied ? (
                <Check className="size-3.5" aria-hidden="true" />
              ) : (
                <Copy className="size-3.5" aria-hidden="true" />
              )}
              {copied ? t`Copied` : t`Copy`}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
