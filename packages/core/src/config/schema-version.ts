/**
 * JSON Schema artifact version — independent of the npm package version.
 *
 * Bumped ONLY for breaking schema changes:
 *   - Removed top-level sections or leaf fields
 *   - Narrowed value spaces (e.g., enum → single literal, larger → smaller
 *     range, optional → required)
 *   - Type changes on existing fields
 *   - New REQUIRED fields (additions of optional fields are NOT breaking)
 *
 * Within a major (e.g., v0):
 *   - New optional fields, new enum values, new sections — all fine
 *   - New `description` / `examples` keywords — fine
 *   - These reach existing users automatically because their YAML's
 *     `$schema=…/v0/…` URL keeps resolving to the latest published v0
 *     schema (`@latest` npm tag + same path).
 *
 * On a major bump:
 *   - Increment this constant + emit to a new directory (`dist/schemas/v1/…`)
 *   - Keep emitting `dist/schemas/v0/…` for legacy YAMLs that still point
 *     at it — old users never lose their autocomplete
 *   - Provide `ok config migrate` codemods to re-pin URLs to the new major
 *
 * The npm package's MAJOR.MINOR can move independently. A CLI release that
 * only adds optional config fields ships v0 schemas + new fields, and
 * existing users see those fields appear in their IDE without re-pinning.
 */
export const CONFIG_SCHEMA_MAJOR = 0;

/** Path segment used in published artifact URLs — `v0`, `v1`, … */
export const CONFIG_SCHEMA_MAJOR_PATH = `v${CONFIG_SCHEMA_MAJOR}`;
