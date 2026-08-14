import { describe, expect, test } from 'vitest';
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
    fieldRegistry.add(inner, { scope: 'user', agentSettable: false, reload: 'live' });
    const wrapped = inner.default('localhost');
    expect(getFieldMeta(wrapped)).toEqual({ scope: 'user', agentSettable: false, reload: 'live' });
  });

  test('descends through .refine()', () => {
    const inner = z.string();
    fieldRegistry.add(inner, { scope: 'project', agentSettable: false, reload: 'live' });
    const wrapped = inner.refine(() => true).default('x');
    expect(getFieldMeta(wrapped)).toEqual({
      scope: 'project',
      agentSettable: false,
      reload: 'live',
    });
  });

  test('descends through chained .optional().nullable().default()', () => {
    const inner = z.number();
    fieldRegistry.add(inner, { scope: 'project', agentSettable: true, reload: 'live' });
    const wrapped = inner.optional().nullable().default(42);
    expect(getFieldMeta(wrapped)).toEqual({
      scope: 'project',
      agentSettable: true,
      reload: 'live',
    });
  });

  test('descends through z.array(...).min(...).default(...)', () => {
    const arr = z.array(z.string()).min(1);
    fieldRegistry.add(arr, {
      scope: 'either',
      agentSettable: true,
      reload: 'live',
      defaultScope: 'project',
    });
    const wrapped = arr.default(['a']);
    expect(getFieldMeta(wrapped)).toEqual({
      scope: 'either',
      agentSettable: true,
      reload: 'live',
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

  test('user-strict fields cover agents.autoApproveOkTools + appearance.{colorTheme*,customTheme.*,language,preview.autoOpen,theme} + editor.{previewTabs,wordWrap} + slides.enabled', () => {
    const leaves: { path: string[]; schema: unknown }[] = [];
    walkLeaves(ConfigSchema, [], leaves);
    const userStrict = leaves
      .filter((l) => getFieldMeta(l.schema)?.scope === 'user')
      .map((l) => l.path.join('.'))
      .sort();
    expect(userStrict).toEqual([
      'agents.autoApproveOkTools',
      // One palette per light/dark mode, plus the single pre-pair palette they
      // superseded — still read as the seed for both slots on an older config.
      'appearance.colorTheme',
      'appearance.colorThemeDark',
      'appearance.colorThemeEnabled',
      'appearance.colorThemeLight',
      // The custom theme is a base16 scheme: sixteen palette slots plus the
      // three metadata fields an imported scheme carries.
      'appearance.customTheme.author',
      'appearance.customTheme.base00',
      'appearance.customTheme.base01',
      'appearance.customTheme.base02',
      'appearance.customTheme.base03',
      'appearance.customTheme.base04',
      'appearance.customTheme.base05',
      'appearance.customTheme.base06',
      'appearance.customTheme.base07',
      'appearance.customTheme.base08',
      'appearance.customTheme.base09',
      'appearance.customTheme.base0A',
      'appearance.customTheme.base0B',
      'appearance.customTheme.base0C',
      'appearance.customTheme.base0D',
      'appearance.customTheme.base0E',
      'appearance.customTheme.base0F',
      'appearance.customTheme.name',
      'appearance.customTheme.variant',
      'appearance.language',
      'appearance.preview.autoOpen',
      'appearance.theme',
      'editor.previewTabs',
      'editor.wordWrap',
      // The Slides plugin toggle — a personal preference like the Themes
      // toggle above, gating whether a `slides: true` doc offers the deck view.
      'slides.enabled',
      // The one `telemetry` leaf that leaves the machine. USER scope so a
      // repository cannot decide that its collaborators report to a third
      // party — its `localSink.*` siblings are project-scope and local-only.
      'telemetry.skillInstallReports.enabled',
    ]);
  });

  test('project-strict fields cover autoSync.default + content.* + contentRules.* + lossCapture.* + telemetry.localSink.*', () => {
    // `autoSync.default` is the committed seed for a machine's sync mode on
    // first open ('off'/'pull'/'full', or the legacy boolean, or null). Project
    // scope is the whole point — it travels with the repo so a maintainer
    // pre-answers the onboarding prompt for everyone. Its per-machine siblings
    // `autoSync.mode`/`autoSync.enabled` stay project-local so scopes never
    // collide.
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
    //
    // `lossCapture.*` controls the dedicated bridge loss-class ring harvested
    // by the same bundle. Project scope for the same reason as the telemetry
    // sink: rotation cap shared via the committed `config.yml`, and disabling
    // the ring is a whole-team decision for a sensitive workspace.
    //
    // `contentRules.*` is the project's markdown authoring standard — which
    // lint plugins run. Shared via the committed `config.yml` (the OK analog of
    // a checked-in `.markdownlint.json`). Each plugin's slice registers its own
    // leaves under `contentRules.<id>.*`.
    const leaves: { path: string[]; schema: unknown }[] = [];
    walkLeaves(ConfigSchema, [], leaves);
    const projectStrict = leaves
      .filter((l) => getFieldMeta(l.schema)?.scope === 'project')
      .map((l) => l.path.join('.'))
      .sort();
    // `remote.*` is the project's remote-access posture — the tunnel URL the
    // Host allowlist admits (armed only by `ok start --remote`) and the stable
    // port the tunnel targets. Project scope (committed) and never
    // agent-settable: an agent setting these would be widening its own
    // network exposure.
    expect(projectStrict).toEqual([
      'autoSync.default',
      'bridge.backgroundThrottle.enabled',
      'bridge.deferGuard.enabled',
      'bridge.fixedPoint.enabled',
      'bridge.flushOnHide.enabled',
      'bridge.lossDetector.enabled',
      'bridge.preDrain.enabled',
      'content.attachmentFolderPath',
      'content.dir',
      'contentRules.frontmatter.enabled',
      'contentRules.frontmatter.schemas',
      'contentRules.markdownlint.enabled',
      'lossCapture.enabled',
      'lossCapture.maxBytes',
      'remote.port',
      'remote.url',
      // `server.{port,externalUrl}` are the committed, reviewed shape of this
      // knowledge base's server — project scope, like the `remote.*` keys they
      // supersede. `server.bind` and the rest of the listener's consent/workflow
      // siblings are project-local (below).
      'server.externalUrl',
      'server.port',
      'server.publicUrl',
      'telemetry.localSink.attributeDenylist',
      'telemetry.localSink.enabled',
      'telemetry.localSink.logs.maxBytes',
      'telemetry.localSink.spans.maxBytes',
      // `validation.*` — the audit plane's non-plugin knobs (broken-link
      // posture + file-tree indicators), shared like `contentRules.*`.
      'validation.fileTreeIndicators',
      'validation.links',
    ]);
  });

  test('project-local-strict fields cover autoSync.mode + autoSync.enabled + appearance.sidebar.* + linkPreviews.enabled + search.semantic.* + terminal.enabled', () => {
    // Project-local fields are per-machine, per-project: each teammate's
    // choice never crosses the git boundary.
    // `<projectDir>/.ok/local/config.yml` is gitignored and never mirrored
    // to the public repo. `autoSync.mode` is the canonical per-machine sync
    // knob (its legacy sibling `autoSync.enabled` stays project-local too);
    // the `appearance.sidebar.*` toggles are per-machine view preferences
    // for what the file tree and sidebar show; `search.semantic.*` is the
    // per-machine opt-in for embeddings search — enabling it sends content to
    // a third-party provider (egress) and needs a local API key, so the choice
    // (and its non-secret provider knobs) is inherently per-machine.
    // `linkPreviews.enabled` is the per-machine opt-in for external link-hover
    // previews — enabling it sends the hovered URL to the destination site
    // (egress), so like semantic search the choice is inherently per-machine.
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
      'appearance.sidebar.showOkFolders',
      'appearance.sidebar.showOnlyMarkdownFiles',
      'appearance.sidebar.showSkillsSection',
      'autoSync.enabled',
      'autoSync.mode',
      'autoSync.resumeMode',
      'linkPreviews.enabled',
      'search.semantic.baseUrl',
      'search.semantic.dimensions',
      'search.semantic.enabled',
      'search.semantic.model',
      'search.semantic.similarityFloor',
      // `server.allowExternal` is exposure CONSENT — the `terminal.enabled`
      // posture: never inherited via clone, sync, or share, so a committed
      // `allowExternal: true` can never expose a future cloner's machine.
      // `server.bind` is per-machine for the same clone-safety reason: a
      // committed non-loopback bind must never break a teammate's local run.
      // `server.{openBrowser,idleShutdown}` are personal workflow, like the
      // sidebar toggles.
      'server.allowExternal',
      'server.bind',
      'server.idleShutdown',
      'server.openBrowser',
      'terminal.enabled',
    ]);
  });

  test('showOnlyMarkdownFiles description documents the .md/.mdx extension contract', () => {
    // "Markdown" canonically includes .mdx here; the registered description
    // is the single documented home for that contract (it is the source
    // injected into the published JSON schema).
    const leaves: { path: string[]; schema: unknown }[] = [];
    walkLeaves(ConfigSchema, [], leaves);
    const leaf = leaves.find(
      (l) => l.path.join('.') === 'appearance.sidebar.showOnlyMarkdownFiles',
    );
    expect(leaf).toBeDefined();
    const description = getFieldMeta(leaf?.schema)?.description ?? '';
    expect(description).toContain('.md');
    expect(description).toContain('.mdx');
  });

  test('every leaf declares a reload class', () => {
    const leaves: { path: string[]; schema: unknown }[] = [];
    walkLeaves(ConfigSchema, [], leaves);
    const missing = leaves
      .filter((l) => {
        const reload = getFieldMeta(l.schema)?.reload;
        return reload !== 'boot' && reload !== 'live';
      })
      .map((l) => l.path.join('.'));
    expect(missing).toEqual([]);
  });

  test("boot-only leaves are exactly content.dir + the listener/exposure keys — everything else is 'live'", () => {
    // `content.dir` re-roots the whole index (watcher, Y.Doc registry, link
    // graph); the `server.*` keys and the superseded `remote.*` aliases shape
    // the listener and its exposure — none can change under a running server.
    // `remote.*` are consumed at start via the alias-read in
    // `resolveServerRuntimeConfig`, so they carry the same 'boot' class as the
    // `server.*` successors they map onto. `server.idleShutdown` is the one
    // listener leaf that CAN re-arm live.
    const leaves: { path: string[]; schema: unknown }[] = [];
    walkLeaves(ConfigSchema, [], leaves);
    const bootOnly = leaves
      .filter((l) => getFieldMeta(l.schema)?.reload === 'boot')
      .map((l) => l.path.join('.'))
      .sort();
    expect(bootOnly).toEqual([
      'content.dir',
      'remote.port',
      'remote.url',
      'server.allowExternal',
      'server.bind',
      'server.externalUrl',
      'server.openBrowser',
      'server.port',
      'server.publicUrl',
    ]);
  });
});
