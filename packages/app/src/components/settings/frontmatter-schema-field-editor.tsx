/**
 * Per-field editor over one frontmatter schema file. Renders the schema's
 * properties as friendly rows (name / type / required / description / allowed
 * values / pattern), recursing into object-typed fields so nested frontmatter
 * shapes are editable in place. Every edit persists as ONE operation through
 * `POST /api/lint/frontmatter-schema` — a non-destructive merge addressed by
 * `parentPath`, so keywords the editor does not model survive on disk and are
 * flagged per row. Reads the RESOLVED schema content from the effective lint
 * config (the server inlines loaded files; the browser never touches disk).
 */

// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import type {
  FrontmatterFieldConstraint,
  SchemaParentPathSegment,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Braces,
  Brackets,
  CaseSensitive,
  Hash,
  ListChecks,
  type LucideIcon,
  ToggleLeft,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
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
import {
  emitLintConfigChanged,
  removeFrontmatterSchemaField,
  renameFrontmatterSchemaField,
  useProjectLintConfig,
  writeFrontmatterSchemaField,
} from '@/editor/lint-config-client';
import { cn } from '@/lib/utils';

const FIELD_TYPES = ['string', 'number', 'boolean', 'array', 'object'] as const;
type FieldType = (typeof FIELD_TYPES)[number];

/**
 * The type select adds `enum` as pure UI sugar for discoverability (matching
 * the agents-manage-ui builder): picking it points the user at the
 * allowed-values input without writing anything, since on disk `enum` stays
 * what JSON Schema says it is — a constraint orthogonal to `type`. So the
 * select reads back `enum` only for a field the schema leaves untyped;
 * anything with a declared type presents as that type, allowed values or not.
 */
const TYPE_SELECT_OPTIONS = ['string', 'number', 'boolean', 'enum', 'array', 'object'] as const;

/** Element-type choices for an array field's `items` (no arrays-of-arrays UI). */
const ITEMS_TYPE_SELECT_OPTIONS = ['string', 'number', 'boolean', 'enum', 'object'] as const;
type ItemsType = 'string' | 'number' | 'boolean' | 'object';

/** Same per-type color coding the agents-manage-ui builder uses. */
const TYPE_ICONS: Record<
  (typeof TYPE_SELECT_OPTIONS)[number],
  { Icon: LucideIcon; className: string }
> = {
  string: { Icon: CaseSensitive, className: 'text-green-500' },
  number: { Icon: Hash, className: 'text-blue-500' },
  boolean: { Icon: ToggleLeft, className: 'text-orange-500' },
  enum: { Icon: ListChecks, className: 'text-yellow-500' },
  array: { Icon: Brackets, className: 'text-pink-500' },
  object: { Icon: Braces, className: 'text-purple-500' },
};

function TypeSelectItemLabel({ option }: { option: (typeof TYPE_SELECT_OPTIONS)[number] }) {
  const { Icon, className } = TYPE_ICONS[option];
  return (
    <span className="flex items-center gap-2">
      <Icon aria-hidden className={cn('size-3.5 shrink-0', className)} />
      {option}
    </span>
  );
}

/** Leading row icon for a field's presented type — the scan anchor. */
function RowTypeIcon({ option }: { option: (typeof TYPE_SELECT_OPTIONS)[number] }) {
  const { Icon, className } = TYPE_ICONS[option];
  return <Icon aria-hidden className={cn('size-4 shrink-0', className)} />;
}

/**
 * Deepest object level whose CHILDREN the editor renders (root = 0). The wire
 * caps `parentPath` at 8 segments; the UI stops well inside that.
 */
const MAX_NESTING_DEPTH = 4;

/**
 * Schema-ROOT keys the editor models (structurally or implicitly). Anything
 * else at the root — if/then, dependencies, additionalProperties, x-
 * extensions — is invisible to the per-field rows, so the editor surfaces a
 * top-of-list note naming them; the per-field preserved flag can't cover
 * keywords that don't belong to any field.
 */
const ROOT_MODELED_KEYWORDS = new Set(['$schema', 'type', 'properties', 'required']);

/**
 * The keywords the friendly rows model; anything else is preserved-but-flagged.
 * `properties`/`required` are modeled structurally — as the nested child rows.
 */
const MODELED_KEYWORDS = new Set([
  'type',
  'enum',
  'pattern',
  'format',
  'items',
  'description',
  'properties',
  'required',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringEnum(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  return value.every((entry) => typeof entry === 'string') ? (value as string[]) : null;
}

function hasUnmodeledKeywords(property: Record<string, unknown>): boolean {
  if (Object.keys(property).some((key) => !MODELED_KEYWORDS.has(key))) return true;
  const items = property.items;
  if (items !== undefined) {
    if (!isRecord(items)) return true;
    const modeledItemsKeys = new Set(['enum', 'type', 'properties', 'required', 'description']);
    if (Object.keys(items).some((key) => !modeledItemsKeys.has(key))) return true;
  }
  return false;
}

/** Per-field write handlers threaded through the recursion. */
interface FieldOps {
  save: (
    field: string,
    constraint: FrontmatterFieldConstraint,
    parentPath: readonly SchemaParentPathSegment[],
  ) => void;
  rename: (field: string, to: string, parentPath: readonly SchemaParentPathSegment[]) => void;
  remove: (field: string, parentPath: readonly SchemaParentPathSegment[]) => void;
}

/** Stable testid/key text for a path — `{items: true}` renders as `[]`. */
function pathKeyOf(parentPath: readonly SchemaParentPathSegment[], field: string): string {
  return [...parentPath.map((seg) => (typeof seg === 'string' ? seg : '[]')), field].join('.');
}

export function FrontmatterSchemaFieldEditor({ file }: { file: string }) {
  const { t } = useLingui();
  const { data } = useProjectLintConfig();

  const entry = data?.effective.plugins.frontmatter.schemas.find((s) => s.file === file);
  const schema = entry?.schema;
  const rootAdvancedKeywords = isRecord(schema)
    ? Object.keys(schema).filter((key) => !ROOT_MODELED_KEYWORDS.has(key))
    : [];

  const ops: FieldOps = {
    save: (field, constraint, parentPath) => {
      void (async () => {
        const result = await writeFrontmatterSchemaField(file, field, constraint, parentPath);
        if (result.ok) emitLintConfigChanged();
        else toast.error(result.errorDetail ?? t`Failed to save the schema field`);
      })();
    },
    rename: (field, to, parentPath) => {
      void (async () => {
        const result = await renameFrontmatterSchemaField(file, field, to, parentPath);
        if (result.ok) emitLintConfigChanged();
        else toast.error(result.errorDetail ?? t`Failed to rename the field`);
      })();
    },
    remove: (field, parentPath) => {
      void (async () => {
        const result = await removeFrontmatterSchemaField(file, field, parentPath);
        if (result.ok) emitLintConfigChanged();
        else toast.error(result.errorDetail ?? t`Failed to remove the field`);
      })();
    },
  };

  return (
    <div className="space-y-3" data-testid={`frontmatter-field-editor-${file}`}>
      {schema === undefined && (
        <p className="text-sm text-muted-foreground">
          <Trans>
            The schema file does not exist or failed to load — adding a field creates it.
          </Trans>
        </p>
      )}
      {rootAdvancedKeywords.length > 0 && (
        <p
          className="text-xs text-muted-foreground"
          data-testid={`frontmatter-schema-root-preserved-${file}`}
        >
          <Trans>
            This schema carries root-level advanced rules the editor does not show (
            {rootAdvancedKeywords.join(', ')}) — they still validate and survive every edit. Open
            the schema file to see them.
          </Trans>
        </p>
      )}
      <FieldList
        node={isRecord(schema) ? schema : {}}
        parentPath={[]}
        depth={0}
        addInputId={`frontmatter-add-field-${file}`}
        ops={ops}
      />
    </div>
  );
}

/** The rows for one object level (the schema root or a nested object field). */
function FieldList({
  node,
  parentPath,
  depth,
  addInputId,
  ops,
}: {
  node: Record<string, unknown>;
  parentPath: readonly SchemaParentPathSegment[];
  depth: number;
  addInputId: string;
  ops: FieldOps;
}) {
  const properties = isRecord(node.properties) ? node.properties : {};
  const required = Array.isArray(node.required)
    ? node.required.filter((r): r is string => typeof r === 'string')
    : [];

  return (
    <div className="space-y-2">
      {Object.entries(properties).map(([field, rawProperty]) => (
        <FieldRow
          key={field}
          field={field}
          property={isRecord(rawProperty) ? rawProperty : {}}
          isRequired={required.includes(field)}
          parentPath={parentPath}
          depth={depth}
          ops={ops}
        />
      ))}
      <AddFieldInput
        inputId={addInputId}
        onAdd={(name) => ops.save(name, { type: 'string' }, parentPath)}
      />
    </div>
  );
}

function FieldRow({
  field,
  property,
  isRequired,
  parentPath,
  depth,
  ops,
}: {
  field: string;
  property: Record<string, unknown>;
  isRequired: boolean;
  parentPath: readonly SchemaParentPathSegment[];
  depth: number;
  ops: FieldOps;
}) {
  const { t } = useLingui();
  // The user picked the `enum` pseudo-type on a field the schema already types
  // (or types nothing yet) — presentation only, since `enum` is a constraint
  // rather than a type and picking it must not rewrite what was declared.
  const [enumIntent, setEnumIntent] = useState(false);
  // Same buffer for the items-type select's enum choice.
  const [itemsEnumIntent, setItemsEnumIntent] = useState(false);

  const pathKey = pathKeyOf(parentPath, field);
  const type =
    typeof property.type === 'string' && (FIELD_TYPES as readonly string[]).includes(property.type)
      ? (property.type as FieldType)
      : undefined;
  const enumValues = stringEnum(property.enum);
  const items = isRecord(property.items) ? property.items : {};
  const itemsEnumValues = stringEnum(items.enum);
  const pattern = typeof property.pattern === 'string' ? property.pattern : '';
  const description = typeof property.description === 'string' ? property.description : '';
  const preserved = hasUnmodeledKeywords(property);
  // A declared type always wins: allowed values on a `string` field are a
  // constraint on that string, so entering them must not re-present the field
  // as an enum. The pseudo-type shows for a field the schema leaves untyped —
  // a bare `{enum: [...]}`, which is what "an enum" actually is on disk — or
  // while the user is picking it for one.
  const showAsEnum =
    type !== 'array' &&
    type !== 'object' &&
    enumValues !== null &&
    (enumIntent || (type === undefined && enumValues.length > 0));
  const showChildren = type === 'object' && depth < MAX_NESTING_DEPTH;
  const itemsType =
    typeof items.type === 'string' &&
    (ITEMS_TYPE_SELECT_OPTIONS as readonly string[]).includes(items.type)
      ? (items.type as ItemsType)
      : undefined;
  const showItemsAsEnum =
    itemsType !== 'object' &&
    itemsEnumValues !== null &&
    (itemsEnumIntent || (itemsType === undefined && itemsEnumValues.length > 0));
  const showItemChildren = type === 'array' && itemsType === 'object' && depth < MAX_NESTING_DEPTH;

  return (
    <div
      className="space-y-2 rounded-md border p-3"
      data-testid={`frontmatter-field-row-${pathKey}`}
    >
      <div className="flex items-center gap-2">
        {(showAsEnum || type !== undefined) && (
          <RowTypeIcon option={showAsEnum ? 'enum' : (type as FieldType)} />
        )}
        <CommitInput
          id={`frontmatter-field-name-${pathKey}`}
          initial={field}
          ariaLabel={t`Field name`}
          className="h-7 w-36 shrink-0 font-mono text-sm font-medium"
          onCommit={(next) => {
            if (next !== '' && next !== field) ops.rename(field, next, parentPath);
          }}
        />
        <CommitInput
          id={`frontmatter-field-description-${pathKey}`}
          initial={description}
          placeholder={t`Add description`}
          ariaLabel={t`Description for ${field}`}
          className="h-7 min-w-0 flex-1"
          onCommit={(next) =>
            ops.save(field, { description: next === '' ? null : next }, parentPath)
          }
        />
        <Label
          htmlFor={`frontmatter-field-required-${pathKey}`}
          className="shrink-0 text-xs text-muted-foreground"
        >
          <Trans>Required</Trans>
        </Label>
        <Switch
          id={`frontmatter-field-required-${pathKey}`}
          checked={isRequired}
          onCheckedChange={(next) => ops.save(field, { required: next }, parentPath)}
          data-testid={`frontmatter-field-required-${pathKey}`}
        />
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={() => ops.remove(field, parentPath)}
          aria-label={t`Remove field ${field}`}
          data-testid={`frontmatter-field-remove-${pathKey}`}
        >
          <Trash2 aria-hidden className="size-4" />
        </Button>
      </div>
      {preserved && (
        <p
          className="text-xs text-muted-foreground"
          data-testid={`frontmatter-field-preserved-${pathKey}`}
        >
          <Trans>
            This field carries additional schema keywords the editor does not show — they are
            preserved on save.
          </Trans>
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs" htmlFor={`frontmatter-field-type-${pathKey}`}>
            <Trans>Type</Trans>
          </Label>
          <Select
            value={showAsEnum ? 'enum' : (type ?? '')}
            onValueChange={(next) => {
              if (next === 'enum') {
                // Nothing to write: `enum` is not a type, and defaulting one
                // in is the conversion this select must not make.
                setEnumIntent(true);
                return;
              }
              setEnumIntent(false);
              // Allowed values survive only a move to `string` — the one
              // target that can still hold them, and the one this editor
              // exists to stop discarding. Every other type would keep a
              // vocabulary it can never satisfy: `{type: 'number', enum:
              // ['draft']}` compiles (the validator runs non-strict) and then
              // rejects every possible value, while the property panel keeps
              // offering those strings because it reads `enum` without
              // consulting `type`.
              const constraint: FrontmatterFieldConstraint =
                next !== 'string' && (enumValues?.length ?? 0) > 0
                  ? { type: next as FieldType, enum: null }
                  : { type: next as FieldType };
              ops.save(field, constraint, parentPath);
            }}
          >
            <SelectTrigger
              id={`frontmatter-field-type-${pathKey}`}
              data-testid={`frontmatter-field-type-${pathKey}`}
            >
              <SelectValue placeholder={t`any`} />
            </SelectTrigger>
            <SelectContent>
              {TYPE_SELECT_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  <TypeSelectItemLabel option={option} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor={`frontmatter-field-pattern-${pathKey}`}>
            <Trans>Pattern (regex)</Trans>
          </Label>
          <CommitInput
            id={`frontmatter-field-pattern-${pathKey}`}
            initial={pattern}
            onCommit={(next) => ops.save(field, { pattern: next === '' ? null : next }, parentPath)}
          />
        </div>
      </div>
      {type !== 'array' && type !== 'object' && enumValues !== null && (
        <div className="space-y-1">
          <Label className="text-xs" htmlFor={`frontmatter-field-enum-${pathKey}`}>
            <Trans>Allowed values (empty = any)</Trans>
          </Label>
          <TagPillInput
            id={`frontmatter-field-enum-${pathKey}`}
            value={enumValues}
            grammar="free-text"
            onChange={(next) =>
              ops.save(field, { enum: next.length === 0 ? null : next }, parentPath)
            }
            placeholder={t`Add value`}
            aria-label={t`Allowed values for ${field}`}
          />
        </div>
      )}
      {type === 'array' && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs" htmlFor={`frontmatter-field-items-type-${pathKey}`}>
              <Trans>Element type</Trans>
            </Label>
            <Select
              value={showItemsAsEnum ? 'enum' : (itemsType ?? '')}
              onValueChange={(next) => {
                if (next === 'enum') {
                  setItemsEnumIntent(true);
                  return;
                }
                setItemsEnumIntent(false);
                // Same rule one level down: only `string` elements can still
                // hold the values, so every other element type clears them.
                const constraint: FrontmatterFieldConstraint =
                  next !== 'string' && (itemsEnumValues?.length ?? 0) > 0
                    ? { itemsType: next as ItemsType, itemsEnum: null }
                    : { itemsType: next as ItemsType };
                ops.save(field, constraint, parentPath);
              }}
            >
              <SelectTrigger
                id={`frontmatter-field-items-type-${pathKey}`}
                data-testid={`frontmatter-field-items-type-${pathKey}`}
              >
                <SelectValue placeholder={t`any`} />
              </SelectTrigger>
              <SelectContent>
                {ITEMS_TYPE_SELECT_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    <TypeSelectItemLabel option={option} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
      {type === 'array' && itemsType !== 'object' && itemsEnumValues !== null && (
        <div className="space-y-1">
          <Label className="text-xs" htmlFor={`frontmatter-field-items-enum-${pathKey}`}>
            <Trans>Allowed element values (empty = any)</Trans>
          </Label>
          <TagPillInput
            id={`frontmatter-field-items-enum-${pathKey}`}
            value={itemsEnumValues}
            grammar="free-text"
            onChange={(next) =>
              ops.save(field, { itemsEnum: next.length === 0 ? null : next }, parentPath)
            }
            placeholder={t`Add value`}
            aria-label={t`Allowed element values for ${field}`}
          />
        </div>
      )}
      {showItemChildren && (
        <div
          className="ml-2 space-y-1 border-l pl-3 pt-1"
          data-testid={`frontmatter-field-item-children-${pathKey}`}
        >
          <p className="text-xs text-muted-foreground">
            <Trans>Element fields</Trans>
          </p>
          <FieldList
            node={items}
            parentPath={[...parentPath, field, { items: true }]}
            depth={depth + 1}
            addInputId={`frontmatter-add-field-${pathKey}.[]`}
            ops={ops}
          />
        </div>
      )}
      {showChildren && (
        <div
          className="ml-2 space-y-1 border-l pl-3 pt-1"
          data-testid={`frontmatter-field-children-${pathKey}`}
        >
          <p className="text-xs text-muted-foreground">
            <Trans>Nested fields</Trans>
          </p>
          <FieldList
            node={property}
            parentPath={[...parentPath, field]}
            depth={depth + 1}
            addInputId={`frontmatter-add-field-${pathKey}`}
            ops={ops}
          />
        </div>
      )}
    </div>
  );
}

/** Name input + Add button for one object level; owns its draft state. */
function AddFieldInput({ inputId, onAdd }: { inputId: string; onAdd: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1 space-y-1">
        <Label htmlFor={inputId} className="text-xs">
          <Trans>Add field</Trans>
        </Label>
        <Input
          id={inputId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="owner"
          data-testid={`${inputId}-input`}
        />
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={name.trim() === ''}
        onClick={() => {
          onAdd(name.trim());
          setName('');
        }}
        data-testid={`${inputId}-save`}
      >
        <Trans>Add</Trans>
      </Button>
    </div>
  );
}

/** Commit-on-blur/Enter buffer so a keystroke doesn't write the schema file. */
function CommitInput({
  id,
  initial,
  onCommit,
  placeholder,
  ariaLabel,
  className,
}: {
  id: string;
  initial: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(initial);
  const commit = () => {
    if (draft.trim() !== initial) onCommit(draft.trim());
  };
  return (
    <Input
      id={id}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className={className}
      data-testid={id}
    />
  );
}
