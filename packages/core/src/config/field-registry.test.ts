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
  function isObjectLike(schema: unknown): schema is { _zod: { def: { shape: unknown } } } {
    const def = (schema as { _zod?: { def?: { type?: string } } })._zod?.def;
    return def?.type === 'object' || def?.type === 'looseObject';
  }

  function unwrapToInner(schema: unknown): unknown {
    let cur = schema;
    while (cur) {
      const def = (cur as { _zod?: { def?: { type?: string; innerType?: unknown } } })._zod?.def;
      if (!def) return cur;
      if (def.type === 'object' || def.type === 'looseObject') return cur;
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
      'appearance.colorTheme',
      'appearance.colorThemeDark',
      'appearance.colorThemeEnabled',
      'appearance.colorThemeLight',
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
      'appearance.sidebar.pinnedGlobalSkills',
      'appearance.theme',
      'editor.previewTabs',
      'editor.wordWrap',
      'slides.enabled',
      'telemetry.skillInstallReports.enabled',
    ]);
  });

  test('project-strict fields cover autoSync.default + content.* + contentRules.* + lossCapture.* + telemetry.localSink.*', () => {
    const leaves: { path: string[]; schema: unknown }[] = [];
    walkLeaves(ConfigSchema, [], leaves);
    const projectStrict = leaves
      .filter((l) => getFieldMeta(l.schema)?.scope === 'project')
      .map((l) => l.path.join('.'))
      .sort();
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
      'contentRules.okf.enabled',
      'contentRules.okf.generate.index',
      'contentRules.okf.rules',
      'lossCapture.enabled',
      'lossCapture.maxBytes',
      'server.externalUrl',
      'server.port',
      'telemetry.localSink.attributeDenylist',
      'telemetry.localSink.enabled',
      'telemetry.localSink.logs.maxBytes',
      'telemetry.localSink.spans.maxBytes',
      'validation.fileTreeIndicators',
      'validation.links',
    ]);
  });

  test('project-local-strict fields cover autoSync.mode + autoSync.enabled + appearance.sidebar.* + linkPreviews.enabled + search.semantic.* + terminal.*', () => {
    const leaves: { path: string[]; schema: unknown }[] = [];
    walkLeaves(ConfigSchema, [], leaves);
    const projectLocalStrict = leaves
      .filter((l) => getFieldMeta(l.schema)?.scope === 'project-local')
      .map((l) => l.path.join('.'))
      .sort();
    expect(projectLocalStrict).toEqual([
      'appearance.sidebar.pinnedProjectSkills',
      'appearance.sidebar.showHiddenFiles',
      'appearance.sidebar.showOkFolders',
      'appearance.sidebar.showOnlyMarkdownFiles',
      'appearance.sidebar.showSkillGroups',
      'appearance.sidebar.showSkillsSection',
      'autoSync.enabled',
      'autoSync.mode',
      'autoSync.pullIntervalSeconds',
      'autoSync.pushIntervalSeconds',
      'autoSync.resumeMode',
      'linkPreviews.enabled',
      'search.semantic.baseUrl',
      'search.semantic.dimensions',
      'search.semantic.docTimeoutMs',
      'search.semantic.enabled',
      'search.semantic.maxBatchChars',
      'search.semantic.maxBatchSize',
      'search.semantic.model',
      'search.semantic.similarityFloor',
      'server.allowExternal',
      'server.bind',
      'server.idleShutdown',
      'server.openBrowser',
      'terminal.enabled',
      'terminal.shell',
    ]);
  });

  test('showOnlyMarkdownFiles description documents the .md/.mdx extension contract', () => {
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
    const leaves: { path: string[]; schema: unknown }[] = [];
    walkLeaves(ConfigSchema, [], leaves);
    const bootOnly = leaves
      .filter((l) => getFieldMeta(l.schema)?.reload === 'boot')
      .map((l) => l.path.join('.'))
      .sort();
    expect(bootOnly).toEqual([
      'content.dir',
      'server.allowExternal',
      'server.bind',
      'server.externalUrl',
      'server.openBrowser',
      'server.port',
    ]);
  });
});
