/**
 * The property (frontmatter) delta shown above the prose diff in the version
 * and agent diff panes.
 *
 * Renders as property rows rather than as YAML text: the delta compares parsed
 * values, so the rows can reuse the same widgets the property panel uses and a
 * nested object or array-of-objects displays the way it does everywhere else.
 * Change kind is carried by a glyph plus an assistive-text label, never by
 * color alone.
 */
import {
  type FrontmatterDelta,
  type FrontmatterValue,
  inferType,
  type PropertyChange,
} from '@inkeep/open-knowledge-core';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { Minus, Pencil, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { PropertyDisclosure } from '@/components/PropertyDisclosure';
import { PropertyDisplayRow } from '@/components/PropertyDisplayRow';
import { ComplexValueWidget, isComplexValue, TYPE_ICON } from '@/components/PropertyWidgets';

/**
 * Rows past this are summarized instead of rendered. A pasted YAML blob would
 * otherwise produce an unbounded pane above the diff the reader came for.
 * Exported because the panes' change-stepper total counts rendered anchors, so
 * it has to bound its property contribution by the same number.
 */
export const MAX_RENDERED_CHANGES = 50;

/** Scalar values longer than this truncate; the full text stays in `title`. */
const MAX_VALUE_CHARS = 200;

export function PropertyDiffBlock({
  delta,
  open,
  onOpenChange,
}: {
  delta: FrontmatterDelta;
  /**
   * Controlled disclosure state. A pane with a change stepper passes it so the
   * stepper's denominator can drop when the rows unmount; omit both for a
   * self-managed disclosure. Ignored on the unparseable block, which renders
   * outside the disclosure and is always visible.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  if (delta.unparseable !== null) {
    return <UnparseableProperties regions={delta.unparseable} />;
  }
  if (delta.changes.length === 0) return null;

  const shown = delta.changes.slice(0, MAX_RENDERED_CHANGES);
  const omitted = delta.changes.length - shown.length;

  return (
    <PropertyDisclosure
      title={<Trans>Properties</Trans>}
      count={delta.changes.length}
      testId="property-diff-block"
      className="border-b border-border py-3"
      open={open}
      onOpenChange={onOpenChange}
    >
      {shown.map((change) => (
        <PropertyChangeRow key={`${change.kind}-${change.key}`} change={change} />
      ))}
      {omitted > 0 && (
        <p className="px-2 pt-1 text-xs text-muted-foreground italic">
          <Plural
            value={omitted}
            one="# more property change not shown"
            other="# more property changes not shown"
          />
        </p>
      )}
    </PropertyDisclosure>
  );
}

function PropertyChangeRow({ change }: { change: PropertyChange }) {
  const { t } = useLingui();
  // The row's type icon describes the value that exists after the change; a
  // removal only has a before-value.
  const subject = change.kind === 'removed' ? change.before : change.after;
  const TypeIcon = TYPE_ICON[inferType(subject)];
  const { KindIcon, kindLabel } =
    change.kind === 'added'
      ? { KindIcon: Plus, kindLabel: t`Added` }
      : change.kind === 'removed'
        ? { KindIcon: Minus, kindLabel: t`Removed` }
        : { KindIcon: Pencil, kindLabel: t`Changed` };

  return (
    <div
      // Queried by both panes' change stepper as PROPERTY_CHANGE_ANCHOR_SELECTOR.
      data-property-change=""
      data-key={change.key}
      data-testid="property-diff-row"
      className="flex items-start gap-1"
    >
      <span className="flex size-7 shrink-0 items-center justify-center text-muted-foreground">
        <KindIcon aria-hidden="true" className="size-3.5" />
        <span className="sr-only">{kindLabel}</span>
      </span>
      <div className="min-w-0 flex-1">
        <PropertyDisplayRow
          icon={<TypeIcon aria-hidden="true" className="size-3.5" />}
          label={change.key}
          dataKey={change.key}
        >
          <ChangeValue change={change} />
        </PropertyDisplayRow>
      </div>
    </div>
  );
}

function ChangeValue({ change }: { change: PropertyChange }) {
  if (change.kind === 'added') return <ValueView value={change.after} keyName={change.key} />;
  if (change.kind === 'removed') {
    return <ValueView value={change.before} keyName={change.key} removed />;
  }
  // A complex before/after pair stacks rather than sitting inline: two nested
  // object previews on one line are unreadable at panel width.
  const complex = isComplexValue(change.before) || isComplexValue(change.after);
  return (
    <div
      className={complex ? 'flex flex-col gap-1' : 'flex flex-wrap items-center gap-1.5'}
      data-testid="property-diff-change-pair"
    >
      <ValueView value={change.before} keyName={change.key} removed />
      <span aria-hidden="true" className="text-muted-foreground">
        →
      </span>
      <ValueView value={change.after} keyName={change.key} />
    </div>
  );
}

function ValueView({
  value,
  keyName,
  removed = false,
}: {
  value: FrontmatterValue;
  keyName: string;
  removed?: boolean;
}) {
  if (isComplexValue(value)) {
    return (
      <div className={removed ? 'opacity-70' : undefined}>
        <ComplexValueWidget keyName={keyName} value={value} />
      </div>
    );
  }
  const full = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').join(', ')
    : String(value);
  const clipped = full.length > MAX_VALUE_CHARS;
  return (
    <span
      className={
        removed
          ? 'px-1 text-sm break-words text-muted-foreground line-through'
          : 'px-1 text-sm break-words'
      }
      title={clipped ? full : undefined}
      data-testid="property-diff-value"
    >
      {clipped ? `${full.slice(0, MAX_VALUE_CHARS)}…` : full}
    </span>
  );
}

/**
 * Shown when either side's YAML did not parse. A structural comparison is not
 * derivable, and silence would be indistinguishable from "nothing changed" on
 * exactly the version worth inspecting — so both raw regions are surfaced.
 */
function UnparseableProperties({ regions }: { regions: { before: string; after: string } }) {
  return (
    <div
      className="border-b border-border px-4 py-3"
      data-testid="property-diff-unparseable"
      data-property-change=""
    >
      <p className="text-xs text-muted-foreground italic">
        <Trans>
          The properties changed, but could not be compared — the YAML did not parse. Both versions
          are shown as written.
        </Trans>
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <RawRegion label={<Trans>Before</Trans>} text={regions.before} />
        <RawRegion label={<Trans>After</Trans>} text={regions.after} />
      </div>
    </div>
  );
}

function RawRegion({ label, text }: { label: ReactNode; text: string }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      <pre className="overflow-x-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs whitespace-pre-wrap">
        {text === '' ? '—' : text}
      </pre>
    </div>
  );
}
