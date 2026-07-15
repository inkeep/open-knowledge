/**
 * Generic editor for one markdownlint rule option. Dispatches the generated
 * catalog's `RuleOptionSpec.type` to a shadcn control, so every rule's
 * options render with zero per-rule UI code; option shapes outside the
 * vocabulary (`unsupported`) render as a read-only chip pointing at the
 * config file. Option values are native markdownlint config values and may
 * come from a hand-edited `.markdownlint.*` file, so every control narrows
 * its `value` before trusting the shape.
 */
import type { RuleOptionSpec } from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import { type ComponentType, type ReactNode, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { FieldDescription } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { TagPillInput } from '@/components/ui/tag-pill-input';

/** A value the generic widgets can emit — one key's worth of a rule's params object. */
export type RuleOptionValue = boolean | number | string | string[];

export interface RuleOptionFieldProps {
  /** Rule id (`MD013`) — namespaces control ids and the override lookup. */
  ruleId: string;
  spec: RuleOptionSpec;
  /** The option's current value from the rule's effective params (undefined = unset). */
  value: unknown;
  disabled?: boolean;
  /** Fires with the option's new typed value when the user commits an edit. */
  onChange: (next: RuleOptionValue) => void;
}

/**
 * Escape hatch: a rule id mapped here renders its option fields through the
 * given component instead of the generic dispatch. Ships empty — the
 * vocabulary covers every current rule's supported options; add an entry
 * only when a rule needs bespoke option UI the vocabulary can't express.
 */
export const RULE_OPTION_WIDGET_OVERRIDES: Readonly<
  Record<string, ComponentType<RuleOptionFieldProps>>
> = {};

export function RuleOptionField(props: RuleOptionFieldProps) {
  const Override = RULE_OPTION_WIDGET_OVERRIDES[props.ruleId];
  if (Override !== undefined) return <Override {...props} />;
  return <GenericRuleOptionField {...props} />;
}

function GenericRuleOptionField({ ruleId, spec, value, disabled, onChange }: RuleOptionFieldProps) {
  const controlId = `rule-option-${ruleId}-${spec.key}`;
  const descriptionId = `${controlId}-description`;

  const header = (
    <div className="min-w-0 space-y-0.5">
      {spec.type === 'unsupported' ? (
        // No form control to label — keep the key out of label semantics.
        <span className="font-mono text-sm font-medium">{spec.key}</span>
      ) : (
        <Label htmlFor={controlId} className="font-mono text-sm font-medium">
          {spec.key}
        </Label>
      )}
      <FieldDescription id={descriptionId}>
        {spec.description}
        {spec.default !== undefined ? (
          <>
            {' · '}
            <Trans>
              Default: <code className="font-mono">{formatOptionConfigValue(spec.default)}</code>
            </Trans>
          </>
        ) : null}
      </FieldDescription>
    </div>
  );

  const shared = { controlId, descriptionId, disabled: disabled === true, onChange };

  switch (spec.type) {
    case 'boolean':
      return (
        <FieldRow testId={controlId} header={header}>
          <BooleanOptionControl {...shared} spec={spec} value={value} />
        </FieldRow>
      );
    case 'enum':
      return (
        <FieldRow testId={controlId} header={header}>
          <EnumOptionControl {...shared} spec={spec} value={value} />
        </FieldRow>
      );
    case 'integer':
      return (
        <FieldRow testId={controlId} header={header}>
          <IntegerOptionControl {...shared} spec={spec} value={value} />
        </FieldRow>
      );
    case 'string':
      return (
        <FieldStack testId={controlId} header={header}>
          <StringOptionControl {...shared} spec={spec} value={value} />
        </FieldStack>
      );
    case 'string-array':
      return (
        <FieldStack testId={controlId} header={header}>
          <StringArrayOptionControl {...shared} spec={spec} value={value} />
        </FieldStack>
      );
    case 'unsupported':
      return (
        <FieldRow testId={controlId} header={header}>
          <Badge variant="gray" data-testid={`${controlId}-unsupported`}>
            <Trans>Edit in config file</Trans>
          </Badge>
        </FieldRow>
      );
    default:
      return spec satisfies never;
  }
}

/** Compact controls sit beside the label; the header keeps layout priority. */
function FieldRow({
  testId,
  header,
  children,
}: {
  testId: string;
  header: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3" data-testid={testId}>
      {header}
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Wide controls (text, pill lists) stack under the label at full width. */
function FieldStack({
  testId,
  header,
  children,
}: {
  testId: string;
  header: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5" data-testid={testId}>
      {header}
      {children}
    </div>
  );
}

/**
 * Render an option value as the config-file literal it round-trips to
 * (`80`, `"atx"`, `[]`) — unambiguous for users who also hand-edit the file.
 * Defaults come from the vendored JSON schema, so they are always
 * JSON-representable.
 */
function formatOptionConfigValue(value: unknown): string {
  return JSON.stringify(value);
}

interface OptionControlProps<S extends RuleOptionSpec> {
  spec: S;
  value: unknown;
  controlId: string;
  descriptionId: string;
  disabled: boolean;
  onChange: (next: RuleOptionValue) => void;
}

type SpecOf<T extends RuleOptionSpec['type']> = Extract<RuleOptionSpec, { type: T }>;

function BooleanOptionControl({
  spec,
  value,
  controlId,
  descriptionId,
  disabled,
  onChange,
}: OptionControlProps<SpecOf<'boolean'>>) {
  const checked = typeof value === 'boolean' ? value : (spec.default ?? false);
  return (
    <Switch
      id={controlId}
      checked={checked}
      disabled={disabled}
      aria-describedby={descriptionId}
      onCheckedChange={(next) => onChange(next)}
    />
  );
}

function EnumOptionControl({
  spec,
  value,
  controlId,
  descriptionId,
  disabled,
  onChange,
}: OptionControlProps<SpecOf<'enum'>>) {
  const current = typeof value === 'string' ? value : (spec.default ?? '');
  return (
    <Select value={current} onValueChange={(next) => onChange(next)} disabled={disabled}>
      <SelectTrigger id={controlId} aria-describedby={descriptionId} className="w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {spec.enum.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Number input over a string presentation buffer (the user can hold
 * intermediate text like `12` on the way to `120` without premature
 * parsing), matching the Settings number-control pattern. Commits on
 * blur/Enter: empty or unparseable text reverts to the committed value;
 * a parseable value is rounded, clamped into the schema's
 * `minimum`/`maximum`, and emitted only when it actually changed.
 */
function IntegerOptionControl({
  spec,
  value,
  controlId,
  descriptionId,
  disabled,
  onChange,
}: OptionControlProps<SpecOf<'integer'>>) {
  const committed = typeof value === 'number' ? value : spec.default;
  const committedText = committed === undefined ? '' : String(committed);
  const [pendingText, setPendingText] = useState(committedText);
  const lastSyncedRef = useRef(committed);

  useEffect(() => {
    if (lastSyncedRef.current === committed) return;
    setPendingText(committed === undefined ? '' : String(committed));
    lastSyncedRef.current = committed;
  }, [committed]);

  const commit = () => {
    if (pendingText.trim() === '') {
      setPendingText(committedText);
      return;
    }
    const parsed = Number(pendingText);
    if (!Number.isFinite(parsed)) {
      setPendingText(committedText);
      return;
    }
    let next = Math.round(parsed);
    if (spec.minimum !== undefined && next < spec.minimum) next = spec.minimum;
    if (spec.maximum !== undefined && next > spec.maximum) next = spec.maximum;
    setPendingText(String(next));
    if (next === committed) return;
    onChange(next);
  };

  return (
    <Input
      id={controlId}
      type="number"
      value={pendingText}
      min={spec.minimum}
      max={spec.maximum}
      disabled={disabled}
      aria-describedby={descriptionId}
      onChange={(e) => setPendingText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
      className="h-8 w-28 text-sm tabular-nums"
    />
  );
}

/**
 * Text input committing on blur/Enter. An empty string commits — it is a
 * meaningful markdownlint value (e.g. clearing MD001's front-matter title
 * pattern disables that check).
 */
function StringOptionControl({
  spec,
  value,
  controlId,
  descriptionId,
  disabled,
  onChange,
}: OptionControlProps<SpecOf<'string'>>) {
  const committed = typeof value === 'string' ? value : (spec.default ?? '');
  const [pendingText, setPendingText] = useState(committed);
  const lastSyncedRef = useRef(committed);

  useEffect(() => {
    if (lastSyncedRef.current === committed) return;
    setPendingText(committed);
    lastSyncedRef.current = committed;
  }, [committed]);

  const commit = () => {
    if (pendingText === committed) return;
    onChange(pendingText);
  };

  return (
    <Input
      id={controlId}
      value={pendingText}
      disabled={disabled}
      aria-describedby={descriptionId}
      onChange={(e) => setPendingText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
      className="h-8 font-mono text-sm"
    />
  );
}

function StringArrayOptionControl({
  spec,
  value,
  controlId,
  descriptionId,
  disabled,
  onChange,
}: OptionControlProps<SpecOf<'string-array'>>) {
  const entries = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [...(spec.default ?? [])];
  return (
    <TagPillInput
      id={controlId}
      value={entries}
      grammar="free-text"
      disabled={disabled}
      aria-describedby={descriptionId}
      onChange={(next) => onChange(next)}
    />
  );
}
