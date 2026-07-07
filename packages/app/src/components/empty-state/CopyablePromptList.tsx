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

/**
 * Embedded-host counterpart to `CreatePromptComposer`. When OK runs inside a
 * host agent (Cursor/Codex/Claude) the launch-an-agent handoff would loop back,
 * so instead of composing + dispatching we surface the SAME starter prompts
 * (via `useCreateSuggestions`) as copy-to-clipboard rows. The user copies one
 * and pastes it straight into the host chat without leaving the agent.
 *
 * Each row: icon + label, a one-line preview of the prompt, and a Copy button
 * that flips to "Copied" briefly on success.
 */
export function CopyablePromptList({ scenario, className }: CopyablePromptListProps) {
  const { t } = useLingui();
  const suggestions = useCreateSuggestions(scenario);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Cleared on unmount so a late reset doesn't fire on a stale component.
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(resetTimerRef.current), []);

  // Routed through the shared adapter (not raw `navigator.clipboard`) so the
  // `execCommand` fallback fires when OK is embedded in a host iframe (e.g.
  // Claude) whose Permissions-Policy denies `clipboard-write` — there the
  // async write rejects, but execCommand still copies under the click's
  // transient activation. Must run inside the onClick gesture.
  function handleCopy(id: string, prompt: string) {
    void scheduleClipboardWrite(prompt)
      .then(() => {
        setCopiedId(id);
        clearTimeout(resetTimerRef.current);
        resetTimerRef.current = setTimeout(() => setCopiedId(null), 1600);
      })
      .catch(() => {
        // Every clipboard path refused (no execCommand, no Electron bridge) —
        // no-op; the prompt text stays selectable in the row.
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
              // Reveal on row hover / keyboard focus; stay visible while showing
              // the "Copied" confirmation so it doesn't vanish mid-feedback.
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
