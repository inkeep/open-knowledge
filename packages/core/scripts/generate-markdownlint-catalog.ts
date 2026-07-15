/**
 * Regenerates `src/markdown/lint/rule-catalog.generated.ts` from the config
 * schema vendored in the installed markdownlint package. Run via:
 *
 *   bun run generate:lint-catalog   (packages/core)
 *
 * The schema is fully self-describing: one property per canonical rule
 * (`MD###`), byte-identical alias duplicates, tag toggles, and three meta
 * keys. Every property MUST classify into one of those buckets and every
 * description MUST match its grammar — anything else throws, so upstream
 * grammar drift fails regeneration (and the catalog drift test) loudly
 * instead of silently dropping rules.
 *
 * markdownlint's exports map has no `./schema` subpath, so the schema path is
 * derived from the resolvable main entry — never a hardcoded node_modules
 * path.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuleCatalogEntry, RuleOptionSpec } from '../src/markdown/lint/types.ts';

const CANONICAL_RULE_KEY_RE = /^MD\d+$/;
/**
 * Rule descriptions read `MD013/line-length : Line length : https://…`; a
 * rule with several aliases chains them (`MD025/single-title/single-h1 : …`).
 */
const RULE_DESCRIPTION_RE = /^(MD\d+)((?:\/[a-z0-9-]+)+) : (.+?) : (https:\/\/\S+)$/;
/** Tag descriptions read `whitespace : MD009, MD010, …`. */
const TAG_DESCRIPTION_RE = /^([a-z_]+) : (MD\d+(?:, MD\d+)*)$/;
const META_KEYS = new Set(['$schema', 'default', 'extends']);
const SEVERITY_ENUM = JSON.stringify(['error', 'warning']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(context: string, detail: string): never {
  throw new Error(
    `markdownlint catalog codegen: ${context}: ${detail} — the vendored schema's shape ` +
      'changed; update scripts/generate-markdownlint-catalog.ts to match it.',
  );
}

export function resolveMarkdownlintSchemaPath(): string {
  const require = createRequire(import.meta.url);
  return join(
    dirname(require.resolve('markdownlint')),
    '..',
    'schema',
    'markdownlint-config-schema.json',
  );
}

/** The `oneOf` options-object branch every rule schema carries. */
function requireRuleOptionsBranch(
  id: string,
  prop: Record<string, unknown>,
): Record<string, unknown> {
  const oneOf = prop.oneOf;
  if (!Array.isArray(oneOf) || oneOf.length !== 3) {
    fail(`rule "${id}"`, 'expected a 3-way oneOf (boolean | severity | options object)');
  }
  const [booleanBranch, severityBranch, objectBranch] = oneOf as unknown[];
  if (!isRecord(booleanBranch) || booleanBranch.type !== 'boolean') {
    fail(`rule "${id}"`, 'oneOf[0] is not the boolean branch');
  }
  if (!isRecord(severityBranch) || JSON.stringify(severityBranch.enum) !== SEVERITY_ENUM) {
    fail(`rule "${id}"`, 'oneOf[1] is not the ["error","warning"] severity branch');
  }
  if (
    !isRecord(objectBranch) ||
    objectBranch.type !== 'object' ||
    !isRecord(objectBranch.properties)
  ) {
    fail(`rule "${id}"`, 'oneOf[2] is not an options object with properties');
  }
  if (!('enabled' in objectBranch.properties) || !('severity' in objectBranch.properties)) {
    fail(`rule "${id}"`, 'options object is missing the enabled/severity keys');
  }
  return objectBranch.properties;
}

function requireTagShape(tag: string, prop: Record<string, unknown>): void {
  const oneOf = prop.oneOf;
  if (!Array.isArray(oneOf) || oneOf.length !== 2) {
    fail(`tag "${tag}"`, 'expected a 2-way oneOf (boolean | severity)');
  }
  const [booleanBranch, severityBranch] = oneOf as unknown[];
  if (!isRecord(booleanBranch) || booleanBranch.type !== 'boolean') {
    fail(`tag "${tag}"`, 'oneOf[0] is not the boolean branch');
  }
  if (!isRecord(severityBranch) || JSON.stringify(severityBranch.enum) !== SEVERITY_ENUM) {
    fail(`tag "${tag}"`, 'oneOf[1] is not the ["error","warning"] severity branch');
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function requireOptionalBoolean(value: unknown, context: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') fail(context, `expected a boolean, got ${JSON.stringify(value)}`);
  return value;
}

function requireOptionalNumber(value: unknown, context: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number') fail(context, `expected a number, got ${JSON.stringify(value)}`);
  return value;
}

function requireOptionalString(value: unknown, context: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(context, `expected a string, got ${JSON.stringify(value)}`);
  return value;
}

function requireOptionalStringArray(value: unknown, context: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!isStringArray(value)) fail(context, `expected a string array, got ${JSON.stringify(value)}`);
  return value;
}

function buildOptionSpec(ruleId: string, key: string, spec: unknown): RuleOptionSpec {
  const context = `rule "${ruleId}" option "${key}"`;
  if (!isRecord(spec)) fail(context, 'expected an object schema');
  const description = spec.description;
  if (typeof description !== 'string' || description.length === 0) {
    fail(context, 'missing a string description');
  }
  const unsupported = (): RuleOptionSpec =>
    spec.default === undefined
      ? { key, type: 'unsupported', description }
      : { key, type: 'unsupported', description, default: spec.default };
  const type = spec.type;
  // Type unions (e.g. integer|array) and any shape outside the widget
  // vocabulary deliberately classify as `unsupported` (read-only in the GUI)
  // rather than failing — only self-inconsistency is an error.
  if (Array.isArray(type)) return unsupported();
  switch (type) {
    case 'boolean': {
      const def = requireOptionalBoolean(spec.default, `${context} default`);
      return def === undefined
        ? { key, type: 'boolean', description }
        : { key, type: 'boolean', description, default: def };
    }
    case 'integer': {
      const def = requireOptionalNumber(spec.default, `${context} default`);
      const minimum = requireOptionalNumber(spec.minimum, `${context} minimum`);
      const maximum = requireOptionalNumber(spec.maximum, `${context} maximum`);
      return {
        key,
        type: 'integer',
        description,
        ...(def !== undefined ? { default: def } : {}),
        ...(minimum !== undefined ? { minimum } : {}),
        ...(maximum !== undefined ? { maximum } : {}),
      };
    }
    case 'string': {
      const def = requireOptionalString(spec.default, `${context} default`);
      const enumValues = spec.enum;
      if (enumValues === undefined) {
        return def === undefined
          ? { key, type: 'string', description }
          : { key, type: 'string', description, default: def };
      }
      if (!isStringArray(enumValues) || enumValues.length === 0) {
        fail(context, 'enum option values are not a non-empty string array');
      }
      return {
        key,
        type: 'enum',
        enum: enumValues,
        description,
        ...(def !== undefined ? { default: def } : {}),
      };
    }
    case 'array': {
      if (!isRecord(spec.items) || spec.items.type !== 'string') return unsupported();
      const def = requireOptionalStringArray(spec.default, `${context} default`);
      return def === undefined
        ? { key, type: 'string-array', description }
        : { key, type: 'string-array', description, default: def };
    }
    default: {
      return unsupported();
    }
  }
}

function buildRuleEntry(id: string, prop: unknown, tags: readonly string[]): RuleCatalogEntry {
  if (!isRecord(prop) || typeof prop.description !== 'string') {
    fail(`rule "${id}"`, 'missing a string description');
  }
  const match = prop.description.match(RULE_DESCRIPTION_RE);
  if (!match) {
    fail(
      `rule "${id}"`,
      `description does not match "MDnnn/alias : Name : url": ${JSON.stringify(prop.description)}`,
    );
  }
  const [, descriptionId, aliasChain, name, docUrl] = match;
  if (descriptionId !== id) {
    fail(`rule "${id}"`, `description names a different rule id ${JSON.stringify(descriptionId)}`);
  }
  const aliases = aliasChain.slice(1).split('/');
  const alias = aliases[0];
  const optionProps = requireRuleOptionsBranch(id, prop);
  const options: RuleOptionSpec[] = [];
  for (const [key, spec] of Object.entries(optionProps)) {
    if (key === 'enabled' || key === 'severity') continue;
    options.push(buildOptionSpec(id, key, spec));
  }
  return { id, alias, aliases, name, docUrl, tags, options };
}

/**
 * Parse the vendored markdownlint config schema into catalog entries.
 * Deterministic over a given schema (property order is preserved), so the
 * drift test can deep-equal a fresh parse against the checked-in module.
 */
export function buildMarkdownlintRuleCatalog(schema: unknown): RuleCatalogEntry[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    fail('schema root', 'expected an object with a `properties` record');
  }
  const properties = schema.properties;
  const canonicalIds = new Set(
    Object.keys(properties).filter((key) => CANONICAL_RULE_KEY_RE.test(key)),
  );

  const ruleTags = new Map<string, string[]>();
  for (const [key, prop] of Object.entries(properties)) {
    if (CANONICAL_RULE_KEY_RE.test(key) || META_KEYS.has(key)) continue;
    if (!isRecord(prop) || typeof prop.description !== 'string') {
      fail(`property "${key}"`, 'missing a string description');
    }
    const ruleMatch = prop.description.match(RULE_DESCRIPTION_RE);
    if (ruleMatch) {
      // Alias-keyed duplicate. Skipping it is only safe while it stays
      // byte-identical to its canonical rule, so verify that.
      const id = ruleMatch[1];
      const canonical = properties[id];
      if (!canonicalIds.has(id) || canonical === undefined) {
        fail(`alias "${key}"`, `references unknown rule ${JSON.stringify(id)}`);
      }
      if (JSON.stringify(prop) !== JSON.stringify(canonical)) {
        fail(
          `alias "${key}"`,
          `differs from its canonical rule "${id}" — skipping it would lose data`,
        );
      }
      continue;
    }
    const tagMatch = prop.description.match(TAG_DESCRIPTION_RE);
    if (!tagMatch) {
      fail(
        `property "${key}"`,
        'description matches neither the rule grammar ("MDnnn/alias : Name : url") nor the tag ' +
          `grammar ("tag : MDnnn, …"): ${JSON.stringify(prop.description)}`,
      );
    }
    requireTagShape(key, prop);
    for (const id of tagMatch[2].split(', ')) {
      if (!canonicalIds.has(id)) {
        fail(`tag "${key}"`, `references unknown rule ${JSON.stringify(id)}`);
      }
      const tags = ruleTags.get(id) ?? [];
      tags.push(tagMatch[1]);
      ruleTags.set(id, tags);
    }
  }

  const entries: RuleCatalogEntry[] = [];
  for (const [key, prop] of Object.entries(properties)) {
    if (!CANONICAL_RULE_KEY_RE.test(key)) continue;
    entries.push(buildRuleEntry(key, prop, ruleTags.get(key) ?? []));
  }
  return entries;
}

export function renderRuleCatalogModule(catalog: readonly RuleCatalogEntry[]): string {
  const lines: string[] = [
    '/**',
    ' * GENERATED FILE — do not edit by hand. Regenerated by',
    ' * `bun run generate:lint-catalog` (packages/core) from the config schema',
    ' * vendored in the installed markdownlint package; the catalog drift test',
    ' * fails when this file is stale.',
    ' */',
    "import type { RuleCatalogEntry } from './types.ts';",
    '',
    'export const MARKDOWNLINT_RULE_CATALOG: readonly RuleCatalogEntry[] = [',
  ];
  for (const entry of catalog) {
    lines.push('  {');
    lines.push(`    id: ${JSON.stringify(entry.id)},`);
    lines.push(`    alias: ${JSON.stringify(entry.alias)},`);
    lines.push(`    aliases: ${JSON.stringify(entry.aliases)},`);
    lines.push(`    name: ${JSON.stringify(entry.name)},`);
    lines.push(`    docUrl: ${JSON.stringify(entry.docUrl)},`);
    lines.push(`    tags: ${JSON.stringify(entry.tags)},`);
    if (entry.options.length === 0) {
      lines.push('    options: [],');
    } else {
      lines.push('    options: [');
      for (const option of entry.options) {
        const fields = [
          `key: ${JSON.stringify(option.key)}`,
          `type: ${JSON.stringify(option.type)}`,
          `description: ${JSON.stringify(option.description)}`,
        ];
        if (option.type === 'enum') fields.push(`enum: ${JSON.stringify(option.enum)}`);
        if (option.default !== undefined) fields.push(`default: ${JSON.stringify(option.default)}`);
        if (option.type === 'integer') {
          if (option.minimum !== undefined)
            fields.push(`minimum: ${JSON.stringify(option.minimum)}`);
          if (option.maximum !== undefined)
            fields.push(`maximum: ${JSON.stringify(option.maximum)}`);
        }
        lines.push(`      { ${fields.join(', ')} },`);
      }
      lines.push('    ],');
    }
    lines.push('  },');
  }
  lines.push('];');
  lines.push('');
  return lines.join('\n');
}

if (import.meta.main) {
  const schemaPath = resolveMarkdownlintSchemaPath();
  const schema: unknown = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const catalog = buildMarkdownlintRuleCatalog(schema);
  const outputPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../src/markdown/lint/rule-catalog.generated.ts',
  );
  writeFileSync(outputPath, renderRuleCatalogModule(catalog), 'utf8');
  console.log(`lint-catalog: wrote ${catalog.length} rules to ${outputPath}`);
}
