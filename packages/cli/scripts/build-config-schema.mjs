#!/usr/bin/env node
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

function pruneByScope(node, targetScope) {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((item) => pruneByScope(item, targetScope));

  const leafScope = node.scope;
  if (leafScope !== undefined && leafScope !== 'either' && leafScope !== targetScope) {
    return undefined;
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

writeSchema(resolve(versionedDir, 'config.project.schema.json'), projectSchema);
writeSchema(resolve(versionedDir, 'config.user.schema.json'), userSchema);
writeSchema(resolve(versionedDir, 'config.project-local.schema.json'), projectLocalSchema);

writeSchema(resolve(distDir, 'config-schema.json'), fullSchema);
writeSchema(resolve(distDir, 'config.project.schema.json'), projectSchema);
writeSchema(resolve(distDir, 'config.user.schema.json'), userSchema);
writeSchema(resolve(distDir, 'config.project-local.schema.json'), projectLocalSchema);
