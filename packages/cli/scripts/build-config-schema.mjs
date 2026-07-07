#!/usr/bin/env bun
/**
 * Emit per-scope JSON Schemas from `ConfigSchema` for IDE intellisense.
 *
 * Schema versioning is **independent** of the npm package version. The
 * artifact directory is `dist/schemas/v<CONFIG_SCHEMA_MAJOR>/…`; the magic
 * comment URL pins to `@latest` of the package + the schema-major path. As
 * a result, additive changes (new optional fields, new enum values) reach
 * existing users automatically — their YAML's `$schema=…/v0/…` URL stays
 * valid, and unpkg's `@latest` redirect surfaces the newest schema. A
 * schema-major bump (v0 → v1) is reserved for breaking changes and emits
 * to a new directory; the old directory keeps shipping for legacy YAMLs.
 *
 * Files emitted (per major):
 *   - `dist/schemas/v<N>/config.project.schema.json` — project-valid
 *     fields (scope: 'project' or 'either')
 *   - `dist/schemas/v<N>/config.user.schema.json`      — user-valid fields
 *     (scope: 'user' or 'either')
 *   - `dist/schemas/v<N>/config.project-local.schema.json` — project-local
 *     fields (scope: 'project-local' or 'either'); IDE autocomplete inside
 *     `<projectDir>/.ok/local/config.yml` only surfaces these.
 *
 * Also emitted at the dist root (back-compat aliases for pre-versioning
 * magic comments still in the wild):
 *   - `dist/config-schema.json`           — full schema, every field
 *   - `dist/config.project.schema.json` — same as v<current>/project
 *   - `dist/config.user.schema.json`      — same as v<current>/user
 *   - `dist/config.project-local.schema.json` — same as v<current>/project-local
 *
 * `ok init`'s scaffolded project `config.yml` magic-comment points at the
 * versioned project schema; `writeConfigPatch`'s lazy first-write of
 * `~/.ok/global.yml` points at the versioned user schema.
 * Each file's autocomplete then surfaces only the fields that are valid
 * AT that scope — an `appearance.theme` typed in project YAML squiggles,
 * a `content.dir` typed in user YAML squiggles.
 *
 * `io: 'input'` (not `'output'`) is load-bearing: the IDE must show the user
 * what they TYPE (every defaulted field optional), not what the runtime
 * resolves (every defaulted field required). The CI test in
 * `src/config/json-schema-equivalence.test.ts` guards this contract.
 *
 * `metadata: fieldRegistry` flows the per-field `scope` / `agentSettable` /
 * `defaultScope` annotations into the JSON Schema as custom keys. JSON
 * Schema draft-07 ignores unknown keywords; the keys ride along for any
 * future consumer that wants to introspect them.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_SCHEMA_MAJOR_PATH, ConfigSchema, fieldRegistry } from '@inkeep/open-knowledge-core';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '..', 'dist');
const versionedDir = resolve(distDir, 'schemas', CONFIG_SCHEMA_MAJOR_PATH);

const fullSchema = z.toJSONSchema(ConfigSchema, {
  io: 'input',
  target: 'draft-7',
  metadata: fieldRegistry,
});

mkdirSync(distDir, { recursive: true });
mkdirSync(versionedDir, { recursive: true });

/**
 * Recursively prune properties that don't apply at `targetScope`.
 *
 * - A leaf with no `scope` keyword → kept (nothing to filter).
 * - A leaf with `scope: 'either'` → kept everywhere.
 * - A leaf with `scope: 'user'` → kept only in the user schema.
 * - A leaf with `scope: 'project'` → kept only in the project schema.
 * - A leaf with `scope: 'project-local'` → kept only in the project-local schema.
 * - An object with `properties` is walked; if EVERY child property is
 *   pruned, the parent object itself is pruned (no dangling empty
 *   sections in the IDE autocomplete).
 *
 * Defaults are preserved as-is — JSON Schema's `default` keyword lets the
 * IDE show the runtime default when hovering, even though the field is
 * optional in the input view.
 */
function pruneByScope(node, targetScope) {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((item) => pruneByScope(item, targetScope));

  const leafScope = node.scope;
  if (leafScope !== undefined && leafScope !== 'either' && leafScope !== targetScope) {
    return undefined; // signals to caller to drop this property
  }

  const out = { ...node };
  if (out.properties && typeof out.properties === 'object') {
    const newProps = {};
    let kept = 0;
    for (const [key, value] of Object.entries(out.properties)) {
      const filtered = pruneByScope(value, targetScope);
      if (filtered !== undefined) {
        newProps[key] = filtered;
        kept += 1;
      }
    }
    if (kept === 0 && leafScope === undefined) {
      // No descendants survived; drop the object itself unless it has its
      // own `scope` registered (which we'd already have honored above).
      return undefined;
    }
    out.properties = newProps;
    if (Array.isArray(out.required)) {
      out.required = out.required.filter((k) => k in newProps);
      if (out.required.length === 0) delete out.required;
    }
  }
  return out;
}

const writeSchema = (path, schema) => {
  writeFileSync(path, `${JSON.stringify(schema, null, 2)}\n`, 'utf-8');
  console.log(`[build:schema] wrote ${path} (${JSON.stringify(schema).length} bytes)`);
};

const projectSchema = pruneByScope(fullSchema, 'project');
const userSchema = pruneByScope(fullSchema, 'user');
const projectLocalSchema = pruneByScope(fullSchema, 'project-local');

// Versioned (canonical) — the URLs `ok init` and `writeConfigPatch`
// scaffold point here. Bump CONFIG_SCHEMA_MAJOR + emit to a new dir
// for breaking changes; keep emitting old majors forever.
writeSchema(resolve(versionedDir, 'config.project.schema.json'), projectSchema);
writeSchema(resolve(versionedDir, 'config.user.schema.json'), userSchema);
writeSchema(resolve(versionedDir, 'config.project-local.schema.json'), projectLocalSchema);

// Back-compat aliases at dist root — pre-versioning magic comments
// point here. Removing these would break existing `~/.ok/
// config.yml` files that never re-pinned to a versioned URL.
writeSchema(resolve(distDir, 'config-schema.json'), fullSchema);
writeSchema(resolve(distDir, 'config.project.schema.json'), projectSchema);
writeSchema(resolve(distDir, 'config.user.schema.json'), userSchema);
writeSchema(resolve(distDir, 'config.project-local.schema.json'), projectLocalSchema);
