import { Trans } from '@lingui/react/macro';
import { useId } from 'react';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';

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
