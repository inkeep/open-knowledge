import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { getSchema } from '@tiptap/core';
import { sharedExtensions } from '../src/extensions/shared.ts';
import { ACTIVE_MDAST_PLUGINS } from '../src/markdown/pipeline.ts';

const SCRIPT_URL = import.meta.url;
const SCRIPT_PATH = fileURLToPath(SCRIPT_URL);
const DEFAULT_OUT = new URL('../schema-snapshot.json', SCRIPT_URL).pathname;

const require = createRequire(SCRIPT_URL);

interface AttrSnapshot {
  hasDefault: boolean;
  default?: unknown;
  __nonSerializableDefault?: true;
}

interface NodeSnapshot {
  attrs: Record<string, AttrSnapshot>;
  content: string;
  marks: string;
  group: string;
  inline: boolean;
  atom: boolean;
  defining: boolean;
  isolating: boolean;
}

interface MarkSnapshot {
  attrs: Record<string, AttrSnapshot>;
  excludes: string;
  group: string;
  inclusive: boolean;
  spanning: boolean;
}

interface PluginSnapshot {
  name: string;
  version: string | null;
  hasOptions: boolean;
}

interface SchemaSnapshotV1 {
  version: 1;
  topNode: string;
  nodes: Record<string, NodeSnapshot>;
  marks: Record<string, MarkSnapshot>;
  activeMdastPlugins: PluginSnapshot[];
}

function captureAttr(attrSpec: unknown): AttrSnapshot {
  const spec = attrSpec as Record<string, unknown>;
  const hasDefault = 'default' in spec;
  if (!hasDefault) return { hasDefault: false };
  const value = spec.default;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { hasDefault: true, default: null, __nonSerializableDefault: true };
  }
  if (serialized === undefined) {
    return { hasDefault: true, default: null, __nonSerializableDefault: true };
  }
  return { hasDefault: true, default: JSON.parse(serialized) as unknown };
}

function captureSchema(): {
  topNode: string;
  nodes: Record<string, NodeSnapshot>;
  marks: Record<string, MarkSnapshot>;
} {
  const schema = getSchema(sharedExtensions);
  const nodes: Record<string, NodeSnapshot> = {};
  const marks: Record<string, MarkSnapshot> = {};

  for (const nodeName of Object.keys(schema.nodes).sort()) {
    const nodeType = schema.nodes[nodeName];
    if (!nodeType) continue;
    const spec = nodeType.spec;
    const attrs: Record<string, AttrSnapshot> = {};
    for (const attrName of Object.keys(spec.attrs ?? {}).sort()) {
      const attrSpec = spec.attrs?.[attrName];
      attrs[attrName] = captureAttr(attrSpec);
    }
    nodes[nodeName] = {
      attrs,
      content: spec.content ?? '',
      marks: spec.marks ?? '',
      group: spec.group ?? '',
      inline: !!spec.inline,
      atom: !!spec.atom,
      defining: !!spec.defining,
      isolating: !!spec.isolating,
    };
  }

  for (const markName of Object.keys(schema.marks).sort()) {
    const markType = schema.marks[markName];
    if (!markType) continue;
    const spec = markType.spec;
    const attrs: Record<string, AttrSnapshot> = {};
    for (const attrName of Object.keys(spec.attrs ?? {}).sort()) {
      const attrSpec = spec.attrs?.[attrName];
      attrs[attrName] = captureAttr(attrSpec);
    }
    marks[markName] = {
      attrs,
      excludes: typeof spec.excludes === 'string' ? spec.excludes : markName,
      group: spec.group ?? '',
      inclusive: spec.inclusive !== false,
      spanning: spec.spanning !== false,
    };
  }

  return { topNode: schema.topNodeType.name, nodes, marks };
}

function getPluginVersion(packageName: string): string | null {
  try {
    const pkg = require(`${packageName}/package.json`) as unknown;
    if (pkg && typeof pkg === 'object' && 'version' in pkg) {
      const ver = (pkg as { version: unknown }).version;
      return typeof ver === 'string' ? ver : null;
    }
    return null;
  } catch {
    return null;
  }
}

function captureActivePlugins(): PluginSnapshot[] {
  return ACTIVE_MDAST_PLUGINS.map((entry) => ({
    name: entry.name,
    version: getPluginVersion(entry.name),
    hasOptions: 'options' in entry && entry.options !== undefined,
  }));
}

function buildSnapshot(): SchemaSnapshotV1 {
  const { topNode, nodes, marks } = captureSchema();
  const activeMdastPlugins = captureActivePlugins();
  return {
    version: 1,
    topNode,
    nodes,
    marks,
    activeMdastPlugins,
  };
}

function serialize(snap: SchemaSnapshotV1): string {
  return `${JSON.stringify(snap, null, 2)}\n`;
}

function parseArgs(rawArgs: readonly string[]): {
  check: boolean;
  out: string;
} {
  let check = false;
  let out = DEFAULT_OUT;
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === '--check') {
      check = true;
    } else if (a === '--out') {
      const next = rawArgs[i + 1];
      if (!next) {
        process.stderr.write('--out requires a path argument\n');
        exit(2);
      }
      out = next;
      i++;
    }
  }
  return { check, out };
}

function main(): void {
  const userArgs = argv.slice(2);
  const { check, out } = parseArgs(userArgs);
  const snapshot = buildSnapshot();
  const serialized = serialize(snapshot);

  if (check) {
    if (!existsSync(out)) {
      process.stderr.write(
        `❌ schema-snapshot.json missing at ${out}\n` +
          `   Run: bun run schema:dump\n` +
          `   Then: git add ${out}\n`,
      );
      exit(1);
    }
    const committed = readFileSync(out, 'utf-8');
    if (committed !== serialized) {
      process.stderr.write(
        '❌ schema-snapshot.json drifted from current schema.\n' +
          '   Re-run:  bun run schema:dump\n' +
          `   Stage:   git add ${out}\n`,
      );
      exit(1);
    }
    process.stdout.write(`schema-snapshot.json fresh ✓ (${out})\n`);
    return;
  }

  writeFileSync(out, serialized);
  process.stdout.write(`Wrote ${out}\n`);
}

if (SCRIPT_PATH === fileURLToPath(`file://${argv[1] ?? ''}`)) {
  main();
}
