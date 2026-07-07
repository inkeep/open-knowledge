import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { fieldRegistry, getFieldMeta } from './field-registry.ts';
import { ConfigSchema } from './schema.ts';

describe('fieldRegistry singleton', () => {
  test('is reachable via the public globalThis Symbol key', () => {
    const SINGLETON_KEY = Symbol.for('@inkeep/open-knowledge/field-registry');
    const fromGlobal = (globalThis as Record<symbol, unknown>)[SINGLETON_KEY];
    expect(fromGlobal).toBe(fieldRegistry as unknown as typeof fromGlobal);
  });

  test('two callers see the same registry instance', async () => {
    // Re-import the same module spec; ESM caching means the second import
    // resolves to the already-loaded module, but the Symbol-keyed singleton
    // would also dedupe across genuinely separate copies of the module.
    const reimport = await import('./field-registry.ts');
    expect(reimport.fieldRegistry).toBe(fieldRegistry);
  });
});

describe('getFieldMeta walker (descends innerType)', () => {
  test('finds metadata when no wrappers are attached', () => {
    const reg = z.registry<{ scope: string }>();
    const inner = z.string();
    inner.register(reg, { scope: 'user' });
    expect(reg.get(inner)).toEqual({ scope: 'user' });
  });

  test('descends through .default()', () => {
    const inner = z.string();
    fieldRegistry.add(inner, { scope: 'user', agentSettable: false });
    const wrapped = inner.default('localhost');
    expect(getFieldMeta(wrapped)).toEqual({ scope: 'user', agentSettable: false });
  });

  test('descends through .refine()', () => {
    const inner = z.string();
    fieldRegistry.add(inner, { scope: 'project', agentSettable: false });
    const wrapped = inner.refine(() => true).default('x');
    expect(getFieldMeta(wrapped)).toEqual({ scope: 'project', agentSettable: false });
  });

  test('descends through chained .optional().nullable().default()', () => {
    const inner = z.number();
    fieldRegistry.add(inner, { scope: 'project', agentSettable: true });
    const wrapped = inner.optional().nullable().default(42);
    expect(getFieldMeta(wrapped)).toEqual({ scope: 'project', agentSettable: true });
  });

  test('descends through z.array(...).min(...).default(...)', () => {
    const arr = z.array(z.string()).min(1);
    fieldRegistry.add(arr, { scope: 'either', agentSettable: true, defaultScope: 'project' });
    const wrapped = arr.default(['a']);
    expect(getFieldMeta(wrapped)).toEqual({
      scope: 'either',
      agentSettable: true,
      defaultScope: 'project',
    });
  });

  test('returns undefined for unregistered leaves', () => {
    const inner = z.string();
    expect(getFieldMeta(inner)).toBeUndefined();
    expect(getFieldMeta(inner.default('x'))).toBeUndefined();
  });

  test('returns undefined for non-schema inputs', () => {
    expect(getFieldMeta(undefined)).toBeUndefined();
    expect(getFieldMeta(null)).toBeUndefined();
    expect(getFieldMeta({})).toBeUndefined();
  });
});

describe('ConfigSchema coverage (NR3 — every leaf has fieldRegistry metadata)', () => {
  // Walks ConfigSchema's structural shape and asserts that every leaf field
  // (scalar, array-leaf, enum) has a `fieldRegistry` entry. Catches the
  // load-bearing declaration-order rule: `.register()` MUST come BEFORE
  // `.default()` / `.optional()` / `.nullable()`. Only ONE `fieldRegistry`
  // per process, so misregistration here is unrecoverable.
  function isObjectLike(schema: unknown): schema is { _zod: { def: { shape: unknown } } } {
    const def = (schema as { _zod?: { def?: { type?: string } } })._zod?.def;
    return def?.type === 'object' || def?.type === 'looseObject';
  }

  function unwrapToInner(schema: unknown): unknown {
    let cur = schema;
    while (cur) {
      const def = (cur as { _zod?: { def?: { type?: string; innerType?: unknown } } })._zod?.def;
      if (!def) return cur;
      // Stop at object/looseObject — they're walkable, not leaves.
      if (def.type === 'object' || def.type === 'looseObject') return cur;
      // Descend wrappers.
      if (def.innerType !== undefined) {
        cur = def.innerType;
        continue;
      }
      return cur;
    }
    return cur;
  }

  function walkLeaves(
    schema: unknown,
    path: string[],
    leaves: { path: string[]; schema: unknown }[],
  ) {
    const inner = unwrapToInner(schema);
    if (isObjectLike(inner)) {
      const shape = (inner as { _zod: { def: { shape: Record<string, unknown> } } })._zod.def.shape;
      for (const [key, child] of Object.entries(shape)) {
        walkLeaves(child, [...path, key], leaves);
      }
      return;
    }
    leaves.push({ path, schema });
  }

  test('every leaf in ConfigSchema has fieldRegistry metadata', () => {
    const leaves: { path: string[]; schema: unknown }[] = [];
    walkLeaves(ConfigSchema, [], leaves);
    expect(leaves.length).toBeGreaterThan(0);
    const missing = leaves.filter((l) => getFieldMeta(l.schema) === undefined);
    if (missing.length > 0) {
      const lines = missing.map((m) => `  - ${m.path.join('.')}`).join('\n');
      throw new Error(
        `ConfigSchema leaves missing fieldRegistry entry (declaration order bug? .register() must come BEFORE .default()/.optional()/.nullable()):\n${lines}`,
      );
    }
  });

  test('no fields are agent-settable in the current schema', () => {
    // The two MCP-tool tuning fields that used to be agent-settable were
    // removed alongside the rest of the either-scope surface; their values
    // now live as constants in `@inkeep/open-knowledge-core`. Re-introduce
    // an entry here when an agent-tunable field actually returns.
    const leaves: { path: string[]; schema: unknown }[] = [];
    walkLeaves(ConfigSchema, [], leaves);
    const allowlisted = leaves
      .filter((l) => getFieldMeta(l.schema)?.agentSettable === true)
      .map((l) => l.path.join('.'))
      .sort();
    expect(allowlisted).toEqual([]);
  });

  test('user-strict fields cover appearance.preview.autoOpen + appearance.theme + editor.wordWrap', () => {
    const leaves: { path: string[]; schema: unknown }[] = [];
    walkLeaves(ConfigSchema, [], leaves);
    const userStrict = leaves
      .filter((l) => getFieldMeta(l.schema)?.scope === 'user')
      .map((l) => l.path.join('.'))
      .sort();
    expect(userStrict).toEqual([
      'appearance.preview.autoOpen',
      'appearance.theme',
      'editor.wordWrap',
    ]);
  });

  test('project-strict fields cover autoSync.default + content.* + telemetry.localSink.*', () => {
    // `autoSync.default` is the committed seed for a machine's
    // `autoSync.enabled` on first open (true/false/null). Project scope is the
    // whole point — it travels with the repo so a maintainer pre-answers the
    // onboarding prompt for everyone. Its sibling `autoSync.enabled` stays
    // project-local (per-machine) so the two never collide on scope.
    //
    // `content.dir` names the root of this project's knowledge graph — it is
    // project-shared (committed `config.yml`), so a user-global override
    // doesn't make sense for it.
    //
    // `content.attachmentFolderPath` is project-shared: all collaborators use
    // the same asset-placement convention (e.g. 'attachments/' mirror of Obsidian
    // vaults) so assets land consistently regardless of who made the edit.
    //
    // `telemetry.localSink.*` controls the local file sink used by
    // `ok diagnose bundle`. Project scope keeps the rotation/denylist
    // defaults shared across collaborators in the committed `config.yml`;
    // disabling the sink is also a project-level decision (sensitive
    // workspaces opt out across the whole team).
    const leaves: { path: string[]; schema: unknown }[] = [];
    walkLeaves(ConfigSchema, [], leaves);
    const projectStrict = leaves
      .filter((l) => getFieldMeta(l.schema)?.scope === 'project')
      .map((l) => l.path.join('.'))
      .sort();
    expect(projectStrict).toEqual([
      'autoSync.default',
      'content.attachmentFolderPath',
      'content.dir',
      'telemetry.localSink.attributeDenylist',
      'telemetry.localSink.enabled',
      'telemetry.localSink.logs.maxBytes',
      'telemetry.localSink.spans.maxBytes',
    ]);
  });

  test('project-local-strict fields cover autoSync.enabled + appearance.sidebar.* + search.semantic.* + terminal.enabled', () => {
    // Project-local fields are per-machine, per-project: each teammate's
    // choice never crosses the git boundary.
    // `<projectDir>/.ok/local/config.yml` is gitignored and never mirrored
    // to the public repo. `autoSync.enabled` controls per-machine sync;
    // the `appearance.sidebar.*` toggles are per-machine view preferences
    // for hidden / ignored files in the file tree; `search.semantic.*` is the
    // per-machine opt-in for embeddings search — enabling it sends content to
    // a third-party provider (egress) and needs a local API key, so the choice
    // (and its non-secret provider knobs) is inherently per-machine.
    // `terminal.enabled` gates the in-app real OS shell: a full-privilege
    // capability consented per-machine, never inherited via a clone.
    const leaves: { path: string[]; schema: unknown }[] = [];
    walkLeaves(ConfigSchema, [], leaves);
    const projectLocalStrict = leaves
      .filter((l) => getFieldMeta(l.schema)?.scope === 'project-local')
      .map((l) => l.path.join('.'))
      .sort();
    expect(projectLocalStrict).toEqual([
      'appearance.sidebar.showHiddenFiles',
      'autoSync.enabled',
      'search.semantic.baseUrl',
      'search.semantic.dimensions',
      'search.semantic.enabled',
      'search.semantic.model',
      'search.semantic.similarityFloor',
      'terminal.enabled',
    ]);
  });
});
