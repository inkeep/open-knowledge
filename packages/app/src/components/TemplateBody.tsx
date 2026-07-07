import { Trans } from '@lingui/react/macro';
import { useId } from 'react';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';

/**
 * Monospace editor for a template body — the markdown that becomes a new
 * document's content when someone creates a doc from this template.
 *
 * Rendered raw, not as a WYSIWYG preview: for a template the structural
 * scaffolding — heading skeleton, parenthetical placeholders, and the
 * `{{date}}` / `{{user}}` substitution tokens — is the point, and a polished
 * render would hide it. The token allowlist is enforced server-side at write
 * time; any other `{{...}}` token is rejected at save.
 */
export function TemplateBodyTextarea({
  value,
  onChange,
  disabled = false,
  placeholder,
  rows = 12,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
  rows?: number;
}) {
  const id = useId();
  // `{{date}}` / `{{user}}` carry literal braces that `lingui compile` reads
  // as ICU syntax — bind them to locals and render as plain placeholders.
  const dateToken = '{{date}}';
  const userToken = '{{user}}';
  return (
    <Field>
      <FieldLabel htmlFor={id}>
        <Trans>Starter content</Trans>
      </FieldLabel>
      <FieldDescription>
        <Trans>
          Becomes the document's content when someone creates a doc from this template. Type{' '}
          <code className="font-mono">{dateToken}</code> or{' '}
          <code className="font-mono">{userToken}</code> to fill in today's date or the author's
          name automatically.
        </Trans>
      </FieldDescription>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={rows}
        spellCheck={false}
        placeholder={placeholder}
        className="font-mono text-xs leading-relaxed min-h-72"
      />
    </Field>
  );
}
