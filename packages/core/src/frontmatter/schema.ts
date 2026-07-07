/**
 * Frontmatter value schemas — single source of truth for value shapes accepted
 * across the browser-side `bindFrontmatterDoc` binding (used by the property
 * panel for direct CRDT writes to the YAML region of `Y.Text('source')`),
 * Observer B (source-mode YAML reconciliation), and disk-side YAML parsing on
 * file-watcher / load events.
 *
 * Five widget types: text, number, boolean, date, list. Date and text both
 * serialize to a YAML string; the distinction is metadata in a `types` map
 * rather than the value shape itself. ISO 8601 date strings are inferred as
 * `date` by `inferType`; consumers may override via the per-property `types`
 * map.
 */
import { z } from 'zod';

/**
 * Reserved top-level frontmatter key — the legacy single-string slot from the
 * predecessor schema. Rejected by every editor surface (panel add/rename,
 * binding patch/path ops) so the slot can't be re-introduced. Single source of
 * truth; do not re-declare locally.
 */
export const RESERVED_FRONTMATTER_KEY = 'frontmatter';

export const FRONTMATTER_TYPES = ['text', 'number', 'boolean', 'date', 'list', 'object'] as const;
export type FrontmatterType = (typeof FRONTMATTER_TYPES)[number];

export const FrontmatterTypeSchema = z.enum(FRONTMATTER_TYPES);

/**
 * Raw value shape — what `bindFrontmatterDoc.patch` accepts (RFC 7396 Merge
 * Patch values), what Observer B parses out of source-mode YAML, and what
 * `parseFrontmatterYaml` returns to disk-side readers. The value lives as
 * plain YAML inside the `---\n…\n---` region of `Y.Text('source')`; this
 * schema constrains the shape independent of CRDT representation.
 *
 * Recursive: a value may be a scalar (string / number / boolean), an array of
 * any values, or a nested mapping of string keys to any values. Top-level
 * scalar-array elements are coerced to string at parse time so a YAML list
 * of mixed scalars (`tags: [travel, 2026]`) surfaces uniformly as strings to
 * the property panel + tag indexer. Object array elements are NOT coerced —
 * `String({})` would yield `'[object Object]'` and corrupt nested data.
 *
 * The type is recursive; the schema uses `z.lazy` to express the cycle.
 * Consumers should bind to `FrontmatterValue` (the explicit TS recursive
 * type) rather than the schema's inferred output — `z.lazy` does not produce
 * a usable inferred type for recursive unions in zod@4.
 *
 * `null` is not a representable stored value — it is reserved as the RFC 7396
 * merge-patch delete sentinel (`FrontmatterPatchSchema`). Real Obsidian vaults
 * nonetheless parse to `null` for their empty-list / bare-key shapes, so the
 * read schema coerces those to empty values at the map boundary before
 * validation — see `coerceNullFrontmatter`.
 */
export type FrontmatterValue =
  | string
  | number
  | boolean
  | FrontmatterValue[]
  | { [key: string]: FrontmatterValue };

const FrontmatterScalarLeafSchema = z.union([z.string(), z.number(), z.boolean()]);

// Coercion asymmetry (intentional): the `z.ZodType<FrontmatterValue>` annotation
// admits `number`/`boolean` scalar elements at the type level, but the
// `.transform((v) => String(v))` below stringifies every scalar element at
// runtime — so `parse([42])` yields `['42']` while top-level `parse(42)` keeps
// `42`. Scalar-array elements surface uniformly as strings to the property
// panel + tag indexer; object/array elements pass through unchanged.
const FrontmatterArrayElementSchema: z.ZodType<FrontmatterValue> = z.lazy(() =>
  z.union([
    FrontmatterScalarLeafSchema.transform((v) => String(v)),
    z.record(z.string(), FrontmatterValueSchema),
    z.array(FrontmatterArrayElementSchema),
  ]),
);

export const FrontmatterValueSchema: z.ZodType<FrontmatterValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(FrontmatterArrayElementSchema),
    z.record(z.string(), FrontmatterValueSchema),
  ]),
);

/** Strict ISO 8601 date string (YYYY-MM-DD) — used to disambiguate text vs date. */
const ISO_8601_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isIsoDateString(value: unknown): value is string {
  return typeof value === 'string' && ISO_8601_DATE_RE.test(value);
}

/**
 * Infer the widget type from a raw value's shape. Used by the property panel
 * + `bindFrontmatterDoc` when a user adds a new property and the type isn't
 * explicitly set — value shape decides the widget class.
 *
 * Note: ISO 8601 strings infer as `date`; bare strings infer as `text`.
 * Values that should stay as plain text despite matching a date pattern must
 * be authored as quoted YAML strings.
 */
export function inferType(value: FrontmatterValue): FrontmatterType {
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'object' && value !== null) return 'object';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (isIsoDateString(value)) return 'date';
  return 'text';
}

/**
 * Coerce the `null` shapes that real Obsidian vaults produce into the empty
 * values the read schema admits, BEFORE `FrontmatterMapSchema` validation.
 *
 * Obsidian writes an empty tag/alias list as `tags:\n- ` — a one-element block
 * sequence whose only item is null — and a bare `tags:` as a null scalar; these
 * dominate real vaults. The read schema deliberately excludes `null` as a
 * stored value (it's reserved as the RFC 7396 merge-patch delete sentinel; see
 * `FrontmatterPatchSchema`), so without this coercion a single empty list
 * rejects the WHOLE map and the property panel can read or edit nothing on the
 * file.
 *
 * Coercion (matching Obsidian's "empty means empty" intuition):
 *   - `null` as a mapping value (bare key) → `''` (key stays visible + editable)
 *   - `null` as a sequence element         → dropped (`[null]` → `[]`)
 *
 * Only the parsed JS view is rewritten. The yaml@2 `Document` (CST) that the
 * write path mutates is untouched, so a file is not rewritten on disk until
 * the user actually edits one of its properties.
 */
function coerceNullFrontmatter(value: unknown): unknown {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const element of value) {
      if (element === null) continue;
      out.push(coerceNullFrontmatter(element));
    }
    return out;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = child === null ? '' : coerceNullFrontmatter(child);
    }
    return out;
  }
  return value;
}

/**
 * Map shape for an entire frontmatter block — `parseFrontmatterYaml` and
 * `readFmMap` return this; `bindFrontmatterDoc.patch` accepts
 * `Record<string, FrontmatterValue | null>` (null = delete, per RFC 7396
 * Merge Patch).
 *
 * `z.preprocess(coerceNullFrontmatter, …)` is the single read-path boundary
 * where Obsidian's `null` empty-list / bare-key shapes become empty values —
 * every structured reader of this schema (`parseFmRegion` for the panel
 * binding, `parseFrontmatterYaml` for disk load/store + the agent-write gate
 * + the tag indexer) inherits the coercion, so they cannot drift apart. (The
 * Observer A/B bridge treats the FM region as opaque source bytes via
 * `stripFrontmatter`/`prependFrontmatter`, so it never reaches this schema.)
 */
export const FrontmatterMapSchema = z.preprocess(
  coerceNullFrontmatter,
  z.record(z.string(), FrontmatterValueSchema),
);
// Hand-written rather than `z.infer<typeof FrontmatterMapSchema>`: zod@4's
// `z.infer` over the `z.lazy` recursive `FrontmatterValueSchema` collapses to
// `never` if the schema's explicit `z.ZodType<FrontmatterValue>` annotation is
// ever loosened — a silent type collapse that only errors at distant callsites.
// Same shape, immune to the footgun.
export type FrontmatterMap = Record<string, FrontmatterValue>;

export const FrontmatterPatchSchema = z.record(
  z.string(),
  z.union([FrontmatterValueSchema, z.null()]),
);
// Hand-written for the same reason as `FrontmatterMap` above (z.lazy infer footgun).
export type FrontmatterPatch = Record<string, FrontmatterValue | null>;

/**
 * The semantic "empty value" predicate that drives the JSON Merge Patch
 * drop-on-empty rule (`mergePatch` deletes keys whose patch value reduces
 * to empty). Shared with the UI so the property-add affordance can gate
 * commits *before* sending an empty write that the server would silently
 * drop.
 *
 * Parameter type widens to `FrontmatterValue | null` because RFC 7396
 * patch values use `null` as a delete sentinel (see `FrontmatterPatch`
 * above); callers passing a raw patch value rely on the union widening.
 *
 * Numeric `0` and boolean `false` are NOT empty — they are valid stored
 * values. Use this helper instead of a loose `!value` check, which would
 * reject `0` / `false` and corrupt the contract.
 *
 * An empty object `{}` is intentionally NOT empty: ObjectWidget's add flow
 * seeds a new nested map as `{}` and then populates it, and RFC 7396 uses
 * `null` (not `{}`) as the delete sentinel — so `{}` must survive the gate.
 */
export function isFrontmatterValueEmpty(value: FrontmatterValue | null): boolean {
  if (value === null) return true;
  if (typeof value === 'string' && value === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

/**
 * Structural deep-equality for frontmatter values. Now that `FrontmatterValue`
 * is recursive (nested objects + arrays of objects), reference equality is not
 * enough: two structurally-identical values parsed from the same YAML on
 * consecutive observer events are distinct JS references. Used by the binding's
 * snapshot-change gate (to suppress spurious listener dispatch on body
 * keystrokes that don't touch the FM region) and by the property-panel widgets
 * (to skip no-op commits). Recurses into both object properties and array
 * elements.
 */
export function frontmatterValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!frontmatterValuesEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.hasOwn(b, key)) return false;
      if (
        !frontmatterValuesEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        )
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}
