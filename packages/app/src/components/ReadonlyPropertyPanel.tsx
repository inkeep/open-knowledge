/**
 * Read-only frontmatter viewer for markdown surfaces that have no CRDT provider
 * — the read-only skill-file viewer (`SkillMarkdownViewer`), where the bytes are
 * a static string, not a live `Y.Text`.
 *
 * The editable document panel (`PropertyPanel`) binds `bindFrontmatterDoc(provider)`
 * for two-way edits; a read-only viewer has no provider to bind, and its scalar
 * widgets are `<input>`-based editors with no display-only mode. So this renders
 * the same "Properties" disclosure chrome (`PropertyDisclosure`, so the two
 * surfaces don't drift on a restyle) with static rows parsed once from the raw
 * text via the same `readFmRegion*` helpers the editable panel reads at mount.
 *
 * Nested objects / arrays-of-objects reuse the editable panel's own
 * `ComplexValueWidget`, which is already a read-only preview.
 */
import {
  type FrontmatterValue,
  inferType,
  readFmKeys,
  readFmRegionWithError,
} from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import { PropertyDisclosure } from '@/components/PropertyDisclosure';
import { ComplexValueWidget, isComplexValue, TYPE_ICON } from '@/components/PropertyWidgets';

/**
 * Renders the frontmatter of a raw markdown string as a read-only Properties
 * panel. `text` is the full file source (frontmatter region + body) — the same
 * shape `PropertyPanel.readInitialSnapshot` reads from the provider. Returns
 * `null` when the file has no frontmatter, so a body-only doc pays no layout.
 */
export function ReadonlyPropertyPanel({ text }: { text: string }) {
  const { map } = readFmRegionWithError(text);
  // Prefer the YAML source order; fall back to `Object.keys(map)` when the
  // region is malformed (mirrors `PropertyPanel`'s degraded render).
  const orderedKeys = readFmKeys(text);
  const renderKeys = orderedKeys.length > 0 ? orderedKeys : Object.keys(map);
  if (renderKeys.length === 0) return null;

  return (
    <PropertyDisclosure
      title={<Trans>Properties</Trans>}
      testId="readonly-property-panel"
      className="pt-4 pb-4"
    >
      {renderKeys.map((key, idx) => {
        const value = map[key];
        if (value === undefined) return null;
        return (
          // Position-aware key: yaml@2 admits duplicate keys, so the same name
          // can appear twice; the source-order index disambiguates the rows.
          // biome-ignore lint/suspicious/noArrayIndexKey: position-aware key for dup-name rows (matches PropertyPanel).
          <ReadonlyRow key={`${key}-${idx}`} keyName={key} value={value} />
        );
      })}
    </PropertyDisclosure>
  );
}

/**
 * One read-only frontmatter row — static type icon, key name, and a
 * non-editable value. Column layout mirrors `SkillProperties`' identity rows
 * (icon `size-7` + key `w-32` + value) so a read-only skill file lines up with
 * the editable skill panel a user sees elsewhere.
 */
function ReadonlyRow({ keyName, value }: { keyName: string; value: FrontmatterValue }) {
  const Icon = TYPE_ICON[inferType(value)];
  return (
    <div
      className="group flex items-start gap-1 py-0.5"
      data-testid="readonly-property-row"
      data-key={keyName}
    >
      <span
        aria-hidden
        className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground"
      >
        <Icon className="size-3.5" />
      </span>
      <span className="flex h-7 w-32 shrink-0 items-center truncate px-2 text-sm text-muted-foreground">
        {keyName}
      </span>
      <div className="min-w-0 flex-1">
        <ReadonlyValue keyName={keyName} value={value} />
      </div>
    </div>
  );
}

/**
 * Read-only value display. Complex shapes (nested object / array of objects)
 * reuse the editable panel's `ComplexValueWidget` (already read-only); arrays of
 * scalars join to a comma list; everything else stringifies. An empty value
 * renders a height-preserving blank so the row still shows its key.
 */
function ReadonlyValue({ keyName, value }: { keyName: string; value: FrontmatterValue }) {
  if (isComplexValue(value)) {
    return <ComplexValueWidget keyName={keyName} value={value} />;
  }
  const display = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').join(', ')
    : String(value);
  return (
    <div
      className="flex min-h-7 items-center px-2 py-1 text-sm break-words"
      data-testid="readonly-property-value"
      data-key={keyName}
    >
      {display}
    </div>
  );
}
