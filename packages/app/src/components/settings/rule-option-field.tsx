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

export type RuleOptionValue = boolean | number | string | string[];

export interface RuleOptionFieldProps {
  ruleId: string;
  spec: RuleOptionSpec;
  value: unknown;
  disabled?: boolean;
  onChange: (next: RuleOptionValue) => void;
}

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
