import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RE_LINT_FAILED_WARNING_PREFIX } from '@inkeep/open-knowledge-core';
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import { register as registerAudit } from './audit.ts';
import { register as registerConfig } from './config.ts';
import { registerAllTools } from './index.ts';
import { register as registerLint } from './lint.ts';
import { register as registerPalette } from './palette.ts';
import { register as registerSearch } from './search.ts';
import { AUDIT_WARNING_CAP, type ServerInstance } from './shared.ts';

const BASE_CONFIG: Config = ConfigSchema.parse({});

const legacyReLint = (message: string) => `${RE_LINT_FAILED_WARNING_PREFIX}${message}`;

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type AnyHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

interface Captured {
  cfg: {
    outputSchema?: Record<string, unknown>;
  };
  handler: AnyHandler;
}

function captureRegistration<TDeps>(
  register: (server: ServerInstance, deps: TDeps) => void,
  deps: TDeps,
): Captured {
  let captured: Captured | null = null;
  const server = {
    registerTool(_name: string, cfg: Captured['cfg'], handler: AnyHandler) {
      captured = { cfg, handler };
    },
    tool() {
      throw new Error('not used');
    },
  } as unknown as ServerInstance;
  register(server, deps);
  if (!captured) throw new Error('tool did not register');
  return captured;
}

function newProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'ok-output-strict-'));
  mkdirSync(join(cwd, '.ok'), { recursive: true });
  return cwd;
}

function compileOutputSchemaForClient(rawShape: unknown): Record<string, unknown> {
  const normalized = normalizeObjectSchema(rawShape);
  if (!normalized) {
    throw new Error('outputSchema did not normalize to an object schema');
  }
  return toJsonSchemaCompat(normalized, {
    strictUnions: true,
    pipeStrategy: 'output',
  }) as Record<string, unknown>;
}

describe('MCP outputSchema strictness — every registerTool+textPlusStructured tool must admit `text`', () => {
  function compileFromRegistration<TDeps>(
    register: (server: ServerInstance, deps: TDeps) => void,
    deps: TDeps,
  ): Record<string, unknown> {
    const captured = captureRegistration(register, deps);
    return compileOutputSchemaForClient(captured.cfg.outputSchema);
  }

  const cwd = newProject();
  const deps = { config: BASE_CONFIG, resolveCwd: async () => cwd };
  const depsWithServer = {
    config: BASE_CONFIG,
    resolveCwd: async () => cwd,
    serverUrl: undefined,
  };

  const cases: Array<{ name: string; build: () => Record<string, unknown> }> = [
    { name: 'config', build: () => compileFromRegistration(registerConfig, deps) },
    {
      name: 'palette',
      build: () => compileFromRegistration(registerPalette, deps),
    },
    { name: 'search', build: () => compileFromRegistration(registerSearch, depsWithServer) },
  ];

  for (const { name, build } of cases) {
    test(`${name}: outputSchema admits the auto-injected \`text\` field`, () => {
      const jsonSchema = build();
      const validator = new AjvJsonSchemaValidator();
      const probe = { text: 'mirror body' };
      const fn = validator.getValidator(jsonSchema);
      const result = fn(probe);
      if (!result.valid) {
        expect(result.errorMessage).not.toMatch(/additional propert/i);
      }
    });
  }
});

describe('MCP outputSchema strictness — auto-discovered registerTool sweep (no new tools may regress)', () => {
  interface RegisterToolCapture {
    name: string;
    outputSchema?: unknown;
  }

  function captureAllRegistrations(cwd: string): RegisterToolCapture[] {
    const captured: RegisterToolCapture[] = [];
    const server = {
      registerTool(name: string, cfg: { outputSchema?: unknown }, _handler: unknown) {
        captured.push({ name, outputSchema: cfg.outputSchema });
      },
      tool() {},
    } as unknown as ServerInstance;
    registerAllTools(server, {
      config: BASE_CONFIG,
      resolveCwd: async () => cwd,
      serverUrl: undefined,
    });
    return captured;
  }

  const KNOWN_REGISTER_TOOL_NAMES = new Set([
    'palette',
    'config',
    'preview_url',
    'resolve_conflict',
    'search',
    'share_link',
    'history',
    'checkpoint',
    'restore_version',
    'delete',
    'move',
    'conflicts',
    'exec',
    'edit',
    'write',
    'links',
    'audit',
    'lint',
  ]);

  test('every registerTool registration declares `text` in its outputSchema', () => {
    const cwd = newProject();
    const registrations = captureAllRegistrations(cwd);

    const capturedNames = new Set(registrations.map((r) => r.name));
    for (const name of KNOWN_REGISTER_TOOL_NAMES) {
      expect(capturedNames).toContain(name);
    }
    expect(registrations.length).toBeGreaterThanOrEqual(KNOWN_REGISTER_TOOL_NAMES.size);

    const missingSchema = registrations
      .filter((r) => KNOWN_REGISTER_TOOL_NAMES.has(r.name) && r.outputSchema === undefined)
      .map((r) => r.name);
    expect(missingSchema).toEqual([]);

    const offenders: Array<{ name: string; error: string }> = [];
    const validator = new AjvJsonSchemaValidator();
    for (const { name, outputSchema } of registrations) {
      if (outputSchema === undefined) continue;
      const jsonSchema = compileOutputSchemaForClient(outputSchema);
      const probe = fn(validator, jsonSchema);
      if (!probe.valid && /additional propert/i.test(probe.errorMessage ?? '')) {
        offenders.push({ name, error: probe.errorMessage ?? '' });
      }
    }
    expect(offenders).toEqual([]);
  });

  function fn(
    validator: AjvJsonSchemaValidator,
    jsonSchema: Record<string, unknown>,
  ): { valid: boolean; errorMessage?: string } {
    const validate = validator.getValidator(jsonSchema);
    const probe = { text: 'mirror body' };
    return validate(probe) as { valid: boolean; errorMessage?: string };
  }
});

describe('audit and lint emitted coverage validates against the client schema', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const cases = [
    {
      name: 'audit',
      register: registerAudit,
      args: {},
      payload: {
        files: [],
        fileCount: 1,
        errorCount: 0,
        warningCount: 0,
        warnings: [],
        ran: ['markdownlint', 'links'],
      },
    },
    {
      name: 'lint project',
      register: registerLint,
      args: {},
      payload: {
        files: [],
        fileCount: 1,
        errorCount: 0,
        warningCount: 0,
        warnings: [],
        ran: ['markdownlint'],
      },
    },
    {
      name: 'lint document',
      register: registerLint,
      args: { document: 'notes' },
      payload: { file: 'notes.md', diagnostics: [], warnings: [], ran: ['frontmatter'] },
    },
    {
      name: 'lint fix',
      register: registerLint,
      args: { document: 'notes', fix: true },
      payload: {
        file: 'notes.md',
        fixedCount: 0,
        diagnostics: [],
        errorCount: 0,
        warningCount: 0,
        warnings: [],
        ran: [],
      },
    },
  ] as const;

  for (const testCase of cases) {
    test(`${testCase.name}: actual structuredContent admits ran`, async () => {
      const cwd = newProject();
      const captured = captureRegistration(testCase.register, {
        config: BASE_CONFIG,
        resolveCwd: async () => cwd,
        serverUrl: 'http://127.0.0.1:31337',
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json(testCase.payload)),
      );

      const result = await captured.handler(testCase.args);
      expect(result.structuredContent?.ran).toEqual(testCase.payload.ran);
      const validator = new AjvJsonSchemaValidator();
      const validate = validator.getValidator(
        compileOutputSchemaForClient(captured.cfg.outputSchema),
      );
      const validation = validate(result.structuredContent) as {
        valid: boolean;
        errorMessage?: string;
      };
      expect(validation.valid, validation.errorMessage).toBe(true);
    });
  }

  test('audit text distinguishes clean, findings, empty selection, and degradation', async () => {
    const captured = captureRegistration(registerAudit, {
      config: BASE_CONFIG,
      resolveCwd: async () => newProject(),
      serverUrl: 'http://127.0.0.1:31337',
    });
    const call = async (payload: Record<string, unknown>): Promise<string> => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json(payload)),
      );
      const result = await captured.handler({});
      return result.content[0]?.text ?? '';
    };
    const base = { fileCount: 1, errorCount: 0, warningCount: 0, warnings: [] };

    expect(await call({ ...base, files: [], ran: ['links'] })).toContain(
      'No problems across 1 document.\nChecks run: links.',
    );

    const findings = await call({
      ...base,
      files: [{ file: 'notes.md', diagnostics: [warningDiagnostic('links')] }],
      warningCount: 1,
      ran: ['links'],
    });
    expect(findings.endsWith('Checks run: links.')).toBe(true);

    expect(await call({ ...base, files: [], ran: [] })).toContain(
      'No problems across 1 document.\nNo checks ran.',
    );

    const degraded = await call({
      ...base,
      files: [],
      ran: ['links'],
      warnings: ['source family "links" validation failed: unavailable'],
    });
    expect(degraded).toContain('No problems found across 1 document');
    expect(degraded).toContain('Checks run: links.');
    expect(degraded).toContain('source family "links" validation failed: unavailable');
  });

  test('lint text distinguishes clean, findings, empty selection, fix, and degradation', async () => {
    const captured = captureRegistration(registerLint, {
      config: BASE_CONFIG,
      resolveCwd: async () => newProject(),
      serverUrl: 'http://127.0.0.1:31337',
    });
    const call = async (
      args: Record<string, unknown>,
      payload: Record<string, unknown>,
    ): Promise<string> => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json(payload)),
      );
      const result = await captured.handler(args);
      return result.content[0]?.text ?? '';
    };

    expect(
      await call(
        { document: 'notes' },
        { file: 'notes.md', diagnostics: [], warnings: [], ran: ['frontmatter'] },
      ),
    ).toContain('No problems in notes.md.\nChecks run: frontmatter.');

    const findings = await call(
      { document: 'notes' },
      {
        file: 'notes.md',
        diagnostics: [warningDiagnostic('frontmatter')],
        warnings: [],
        ran: ['frontmatter'],
      },
    );
    expect(findings.endsWith('Checks run: frontmatter.')).toBe(true);

    expect(
      await call(
        {},
        {
          files: [],
          fileCount: 1,
          errorCount: 0,
          warningCount: 0,
          warnings: [],
          ran: [],
        },
      ),
    ).toContain('No problems across 1 document.\nNo checks ran.');

    expect(
      await call(
        { document: 'notes', fix: true },
        {
          file: 'notes.md',
          fixedCount: 0,
          diagnostics: [],
          errorCount: 0,
          warningCount: 0,
          ran: [],
        },
      ),
    ).toContain('No auto-fixable problems in notes.md.\nNo checks ran.');

    const degraded = await call(
      { document: 'notes' },
      {
        file: 'notes.md',
        diagnostics: [],
        ran: ['frontmatter'],
        warnings: ['source "frontmatter" lint failed on "notes.md": unavailable'],
      },
    );
    expect(degraded).toContain(
      'No problems found in notes.md, but the lint could not fully complete.\nChecks run: frontmatter.',
    );
    expect(degraded).toContain('Lint incomplete — 1 warning (findings may be partial):');
    expect(degraded).toContain('source "frontmatter" lint failed');

    const degradedAudit = await call(
      {},
      {
        files: [],
        fileCount: 3,
        errorCount: 0,
        warningCount: 0,
        ran: ['markdownlint'],
        warnings: ['source "markdownlint" lint failed on 3 documents (first: "a.md"): boom'],
      },
    );
    expect(degradedAudit).toContain(
      'No problems found across 3 documents, but the lint could not fully complete.\nChecks run: markdownlint.',
    );

    const degradedFix = await call(
      { document: 'notes', fix: true },
      {
        file: 'notes.md',
        fixedCount: 0,
        diagnostics: [],
        errorCount: 0,
        warningCount: 0,
        ran: ['markdownlint'],
        warnings: ['source "markdownlint" fix failed on "notes.md": boom'],
      },
    );
    expect(degradedFix).toContain(
      'No auto-fixable problems in notes.md, but the lint could not fully complete.',
    );
  });

  test('diagnosticsArePreFix drives the fix header, renders the bare reason once, and drops the remaining-problems footer', async () => {
    const captured = captureRegistration(registerLint, {
      config: BASE_CONFIG,
      resolveCwd: async () => newProject(),
      serverUrl: 'http://127.0.0.1:31337',
    });
    const reLint = legacyReLint('boom');
    const fixPayload = (
      warnings: string[],
      diagnosticsArePreFix?: boolean,
    ): Record<string, unknown> => ({
      file: 'notes.md',
      fixedCount: diagnosticsArePreFix ? 0 : 1,
      diagnostics: [warningDiagnostic('markdownlint')],
      errorCount: 0,
      warningCount: 1,
      ran: ['markdownlint'],
      warnings,
      ...(diagnosticsArePreFix === undefined ? {} : { diagnosticsArePreFix }),
    });
    const call = async (warnings: string[], diagnosticsArePreFix?: boolean) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json(fixPayload(warnings, diagnosticsArePreFix))),
      );
      return captured.handler({ document: 'notes', fix: true });
    };

    const result = await call([reLint], true);

    expect(result.structuredContent).not.toHaveProperty('warnings');
    expect(result.structuredContent).toMatchObject({
      diagnosticsArePreFix: true,
      reLintFailure: { reason: 're-lint-threw', message: 'boom' },
    });
    const text = result.content[0]?.text ?? '';
    expect(text.split('\n')[0]).toBe(
      'Applied auto-fixes to notes.md, but re-lint failed (boom); the fix landed — problems below are the pre-fix set, re-run `lint` to confirm.',
    );
    expect(text).not.toContain(RE_LINT_FAILED_WARNING_PREFIX);
    expect(text).not.toContain('problem remain');

    const legacyOnly = await (async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({
            file: 'notes.md',
            fixedCount: 0,
            diagnostics: [warningDiagnostic('markdownlint')],
            errorCount: 0,
            warningCount: 1,
            ran: ['markdownlint'],
            warning: reLint,
          }),
        ),
      );
      return captured.handler({ document: 'notes', fix: true });
    })();
    const legacyText = legacyOnly.content[0]?.text ?? '';
    expect(legacyText.split('\n')[0]).toBe(
      'Applied auto-fixes to notes.md, but re-lint failed (boom); the fix landed — problems below are the pre-fix set, re-run `lint` to confirm.',
    );
    expect(legacyText).not.toContain('problem remain');
    expect(legacyOnly.structuredContent).not.toHaveProperty('warnings');
    expect(legacyOnly.structuredContent).toMatchObject({
      diagnosticsArePreFix: true,
      reLintFailure: { reason: 're-lint-threw', message: 'boom' },
    });

    const ordinary = await call(['source "markdownlint" lint failed on "notes.md": boom']);
    const ordinaryStructured = ordinary.structuredContent as { diagnosticsArePreFix?: boolean };
    expect(ordinaryStructured.diagnosticsArePreFix).toBeUndefined();
    const ordinaryText = ordinary.content[0]?.text ?? '';
    expect(ordinaryText.split('\n')[0]).toBe('Fixed 1 problem in notes.md.');
    expect(ordinaryText).toContain('1 problem remain');

    const validator = new AjvJsonSchemaValidator();
    const validate = validator.getValidator(
      compileOutputSchemaForClient(captured.cfg.outputSchema),
    );
    const validation = validate(result.structuredContent) as {
      valid: boolean;
      errorMessage?: string;
    };
    expect(validation.valid, validation.errorMessage).toBe(true);
  });

  test('the pre-fix signal survives a server that sends only the prefix or only the boolean', async () => {
    const captured = captureRegistration(registerLint, {
      config: BASE_CONFIG,
      resolveCwd: async () => newProject(),
      serverUrl: 'http://127.0.0.1:31337',
    });
    const call = async (extra: Record<string, unknown>) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({
            file: 'notes.md',
            fixedCount: 0,
            diagnostics: [warningDiagnostic('markdownlint')],
            errorCount: 0,
            warningCount: 1,
            ran: ['markdownlint'],
            ...extra,
          }),
        ),
      );
      return captured.handler({ document: 'notes', fix: true });
    };

    const prefixOnly = await call({ warnings: [legacyReLint('boom')] });
    expect(
      (prefixOnly.structuredContent as { diagnosticsArePreFix?: boolean }).diagnosticsArePreFix,
    ).toBe(true);
    expect(prefixOnly.structuredContent).not.toHaveProperty('warnings');
    expect(prefixOnly.structuredContent).toHaveProperty('reLintFailure', {
      reason: 're-lint-threw',
      message: 'boom',
    });
    const prefixText = prefixOnly.content[0]?.text ?? '';
    expect(prefixText.split('\n')[0]).toBe(
      'Applied auto-fixes to notes.md, but re-lint failed (boom); the fix landed — problems below are the pre-fix set, re-run `lint` to confirm.',
    );
    expect(prefixText).not.toContain(RE_LINT_FAILED_WARNING_PREFIX);
    expect(prefixText).not.toContain('problem remain');

    const booleanOnly = await call({ diagnosticsArePreFix: true });
    expect(booleanOnly.structuredContent).toHaveProperty('diagnosticsArePreFix', true);
    expect(booleanOnly.structuredContent).not.toHaveProperty('reLintFailure');
    expect((booleanOnly.content[0]?.text ?? '').split('\n')[0]).toBe(
      'Applied auto-fixes to notes.md, but re-lint failed; the fix landed — problems below are the pre-fix set, re-run `lint` to confirm.',
    );
  });

  test.each(['boom', ' \tboom\n '])(
    'reLintFailure alone marks diagnostics as pre-fix and carries its message in both outputs (%j)',
    async (message) => {
      const captured = captureRegistration(registerLint, {
        config: BASE_CONFIG,
        resolveCwd: async () => newProject(),
        serverUrl: 'http://127.0.0.1:31337',
      });
      const diagnostics = [warningDiagnostic('markdownlint')];
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({
            file: 'notes.md',
            fixedCount: 0,
            diagnostics,
            ran: ['markdownlint'],
            reLintFailure: { reason: 'source-went-blind', message },
          }),
        ),
      );

      const result = await captured.handler({ document: 'notes', fix: true });
      const text = result.content[0]?.text ?? '';
      expect(text.split('\n')[0]).toBe(
        'Applied auto-fixes to notes.md, but re-lint failed (boom); the fix landed — problems below are the pre-fix set, re-run `lint` to confirm.',
      );
      expect(text.match(/boom/g)).toHaveLength(1);
      expect(text).not.toContain('problem remain');
      expect(result.structuredContent).toMatchObject({
        files: [{ file: 'notes.md', diagnostics }],
        fixedCount: 0,
        errorCount: 0,
        warningCount: 1,
        diagnosticsArePreFix: true,
        reLintFailure: { reason: 'source-went-blind', message: 'boom' },
      });
      expect(result.structuredContent).not.toHaveProperty('warnings');
      expect(result.structuredContent).not.toHaveProperty('warning');
      const validate = new AjvJsonSchemaValidator().getValidator(
        compileOutputSchemaForClient(captured.cfg.outputSchema),
      );
      const validation = validate(result.structuredContent);
      expect(validation.valid, validation.errorMessage).toBe(true);
    },
  );

  test.each([{}, { reason: 're-lint-threw', message: '   ' }])(
    'a malformed typed reLintFailure (%j) falls through to the legacy prefixed warning without throwing',
    async (reLintFailure) => {
      const captured = captureRegistration(registerLint, {
        config: BASE_CONFIG,
        resolveCwd: async () => newProject(),
        serverUrl: 'http://127.0.0.1:31337',
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({
            file: 'notes.md',
            fixedCount: 0,
            diagnostics: [warningDiagnostic('markdownlint')],
            ran: ['markdownlint'],
            warnings: [legacyReLint('legacy reason')],
            reLintFailure,
          }),
        ),
      );

      const result = await captured.handler({ document: 'notes', fix: true });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        diagnosticsArePreFix: true,
        reLintFailure: { reason: 're-lint-threw', message: 'legacy reason' },
      });
      expect(result.structuredContent).not.toHaveProperty('warnings');
      const text = result.content[0]?.text ?? '';
      expect(text.split('\n')[0]).toContain('re-lint failed (legacy reason);');
      expect(text).not.toContain(RE_LINT_FAILED_WARNING_PREFIX);
      const validate = new AjvJsonSchemaValidator().getValidator(
        compileOutputSchemaForClient(captured.cfg.outputSchema),
      );
      const validation = validate(result.structuredContent);
      expect(validation.valid, validation.errorMessage).toBe(true);
    },
  );

  test.each([
    { reLintFailure: undefined, reason: 're-lint-threw', message: 'plural reason' },
    {
      reLintFailure: { reason: 'source-went-blind', message: '  typed reason  ' },
      reason: 'source-went-blind',
      message: 'typed reason',
    },
  ])(
    'fix output keeps ordinary warnings and normalizes legacy failures to $message',
    async ({ reLintFailure, reason, message }) => {
      const captured = captureRegistration(registerLint, {
        config: BASE_CONFIG,
        resolveCwd: async () => newProject(),
        serverUrl: 'http://127.0.0.1:31337',
      });
      const warnings = [
        'source "markdownlint" fix failed on "notes.md": unavailable',
        'frontmatter schema unavailable',
      ];
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({
            file: 'notes.md',
            fixedCount: 0,
            diagnostics: [warningDiagnostic('markdownlint')],
            warnings: [
              warnings[0],
              legacyReLint('plural reason'),
              warnings[1],
              legacyReLint('another legacy reason'),
            ],
            warning: legacyReLint('singular reason'),
            reLintFailure,
          }),
        ),
      );

      const result = await captured.handler({ document: 'notes', fix: true });
      expect(result.structuredContent).toMatchObject({
        warnings,
        diagnosticsArePreFix: true,
        reLintFailure: { reason, message },
      });
      const text = result.content[0]?.text ?? '';
      expect(text.split('\n')[0]).toContain(`re-lint failed (${message});`);
      expect(text).toContain('Lint incomplete — 2 warnings (findings may be partial):');
      for (const warning of warnings) expect(text).toContain(warning);
      expect(text).not.toContain(RE_LINT_FAILED_WARNING_PREFIX);
      expect(text).not.toContain('another legacy reason');
      expect(text).not.toContain('singular reason');
      expect(text).not.toContain('problem remain');
    },
  );

  test('an older server that sends the same prefixed string in warning and warnings renders it once', async () => {
    const captured = captureRegistration(registerLint, {
      config: BASE_CONFIG,
      resolveCwd: async () => newProject(),
      serverUrl: 'http://127.0.0.1:31337',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          file: 'notes.md',
          fixedCount: 0,
          diagnostics: [warningDiagnostic('markdownlint')],
          ran: ['markdownlint'],
          warning: legacyReLint('same'),
          warnings: [legacyReLint('same')],
        }),
      ),
    );

    const result = await captured.handler({ document: 'notes', fix: true });

    expect(result.structuredContent).not.toHaveProperty('warnings');
    expect(result.structuredContent).toMatchObject({
      diagnosticsArePreFix: true,
      reLintFailure: { reason: 're-lint-threw', message: 'same' },
    });
    const text = result.content[0]?.text ?? '';
    expect(text.split('\n')[0]).toBe(
      'Applied auto-fixes to notes.md, but re-lint failed (same); the fix landed — problems below are the pre-fix set, re-run `lint` to confirm.',
    );
    expect(text.match(/same/g)).toHaveLength(1);
    expect(text).not.toContain(RE_LINT_FAILED_WARNING_PREFIX);
  });

  test('a reason an older or newer server does not share normalizes to the closed discriminant', async () => {
    const captured = captureRegistration(registerLint, {
      config: BASE_CONFIG,
      resolveCwd: async () => newProject(),
      serverUrl: 'http://127.0.0.1:31337',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          file: 'notes.md',
          fixedCount: 0,
          diagnostics: [warningDiagnostic('markdownlint')],
          ran: ['markdownlint'],
          reLintFailure: { reason: 'a-reason-from-the-future', message: 'still readable' },
        }),
      ),
    );

    const result = await captured.handler({ document: 'notes', fix: true });

    expect(result.structuredContent).toMatchObject({
      diagnosticsArePreFix: true,
      reLintFailure: { reason: 're-lint-threw', message: 'still readable' },
    });
    const validate = new AjvJsonSchemaValidator().getValidator(
      compileOutputSchemaForClient(captured.cfg.outputSchema),
    );
    const validation = validate(result.structuredContent);
    expect(validation.valid, validation.errorMessage).toBe(true);
  });

  test('lint audit caps the warning channel the way audit does', async () => {
    const captured = captureRegistration(registerLint, {
      config: BASE_CONFIG,
      resolveCwd: async () => newProject(),
      serverUrl: 'http://127.0.0.1:31337',
    });
    const warnings = Array.from({ length: AUDIT_WARNING_CAP + 5 }, (_, i) =>
      i === AUDIT_WARNING_CAP + 4 ? 'validator "lint" failed: EACCES' : `warning ${i}`,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          files: [],
          fileCount: 1,
          errorCount: 0,
          warningCount: 0,
          ran: ['markdownlint'],
          warnings,
        }),
      ),
    );

    const result = await captured.handler({});

    const structured = result.structuredContent as {
      warnings?: string[];
      omittedWarningCount?: number;
    };
    expect(structured.warnings).toHaveLength(AUDIT_WARNING_CAP);
    expect(structured.warnings?.[0]).toBe('validator "lint" failed: EACCES');
    expect(structured.omittedWarningCount).toBe(5);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('… and 5 more warnings');

    const validator = new AjvJsonSchemaValidator();
    const validate = validator.getValidator(
      compileOutputSchemaForClient(captured.cfg.outputSchema),
    );
    const validation = validate(result.structuredContent) as {
      valid: boolean;
      errorMessage?: string;
    };
    expect(validation.valid, validation.errorMessage).toBe(true);
  });

  function warningDiagnostic(source: string): Record<string, unknown> {
    return {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 'warning',
      source,
      code: 'test',
      message: 'problem',
    };
  }
});

describe('move outputSchema admits the cross-level skill-move payloads (CORR-1)', () => {
  function moveOutputJsonSchema(): Record<string, unknown> {
    const cwd = newProject();
    const captured: Array<{ name: string; outputSchema?: unknown }> = [];
    const server = {
      registerTool(name: string, cfg: { outputSchema?: unknown }) {
        captured.push({ name, outputSchema: cfg.outputSchema });
      },
      tool() {},
    } as unknown as ServerInstance;
    registerAllTools(server, {
      config: BASE_CONFIG,
      resolveCwd: async () => cwd,
      serverUrl: undefined,
    });
    const move = captured.find((r) => r.name === 'move');
    if (!move?.outputSchema) throw new Error('move tool did not register an outputSchema');
    return compileOutputSchemaForClient(move.outputSchema);
  }

  const crossScopeSuccess = {
    ok: true,
    kind: 'skill',
    committed: false,
    crossScope: true,
    text: 'Moved skill "trip-log" (Project) → "trip-log" (Global). …',
  };
  const crossScopePartialFailure = {
    ok: false,
    kind: 'skill',
    error: 'source delete failed',
    bothScopes: true,
    text: 'Partially moved skill … exists in BOTH levels …',
  };

  for (const [label, payload] of [
    ['cross-level success', crossScopeSuccess],
    ['cross-level partial-failure (both levels)', crossScopePartialFailure],
  ] as const) {
    test(`${label} structuredContent validates against the compiled move schema`, () => {
      const validator = new AjvJsonSchemaValidator();
      const validate = validator.getValidator(moveOutputJsonSchema());
      const result = validate(payload) as { valid: boolean; errorMessage?: string };
      expect(result.valid).toBe(true);
      if (!result.valid) {
        expect(result.errorMessage).not.toMatch(/additional propert/i);
      }
    });
  }
});

describe('share_link outputSchema admits emitted success and error payloads', () => {
  function shareLinkOutputJsonSchema(): Record<string, unknown> {
    const cwd = newProject();
    const captured: Array<{ name: string; outputSchema?: unknown }> = [];
    const server = {
      registerTool(name: string, cfg: { outputSchema?: unknown }) {
        captured.push({ name, outputSchema: cfg.outputSchema });
      },
      tool() {},
    } as unknown as ServerInstance;
    registerAllTools(server, {
      config: BASE_CONFIG,
      resolveCwd: async () => cwd,
      serverUrl: undefined,
    });
    const shareLink = captured.find((r) => r.name === 'share_link');
    if (!shareLink?.outputSchema) {
      throw new Error('share_link tool did not register an outputSchema');
    }
    return compileOutputSchemaForClient(shareLink.outputSchema);
  }

  const base = {
    ok: true,
    shareUrl: 'https://openknowledge.ai/d/enc',
    sharedUrl: 'https://github.com/o/r/blob/main/notes.md',
    branch: 'main',
    resolvedKind: 'doc',
    previewUrl: null,
  };
  const withFreshness = {
    ...base,
    freshness: 'stale',
    text: 'This doc has unpushed changes. Recipients will see the last pushed version.\n\nShare link for doc `notes` on branch `main`:\nhttps://openknowledge.ai/d/enc',
  };
  const withoutFreshness = {
    ...base,
    text: 'Share link for doc `notes` on branch `main`:\nhttps://openknowledge.ai/d/enc',
  };
  const withEmptyFreshness = {
    ...base,
    sharedUrl: 'https://github.com/o/r/tree/main/hollow',
    resolvedKind: 'folder',
    freshness: 'empty',
    text: "Git can't track this folder — it's empty or contains only ignored files. The link won't work until you add a tracked document.\n\nShare link for folder `hollow` on branch `main`:\nhttps://openknowledge.ai/d/enc",
  };
  const withUnsupportedUrlError = {
    ok: false,
    error: 'unsupported-share-url',
    message:
      'The GitHub URL cannot be represented by the share-link format. Use a canonical DNS GitHub host and a shorter repository path.',
    text: 'Error: The GitHub URL cannot be represented by the share-link format. Use a canonical DNS GitHub host and a shorter repository path.',
  };

  for (const [label, payload] of [
    ['success with freshness', withFreshness],
    ['success without freshness (happy-path passthrough)', withoutFreshness],
    ['success with the empty-folder verdict', withEmptyFreshness],
    ['unsupported share URL error', withUnsupportedUrlError],
  ] as const) {
    test(`${label} structuredContent validates against the compiled share_link schema`, () => {
      const validator = new AjvJsonSchemaValidator();
      const validate = validator.getValidator(shareLinkOutputJsonSchema());
      const result = validate(payload) as { valid: boolean; errorMessage?: string };
      expect(result.valid).toBe(true);
      if (!result.valid) {
        expect(result.errorMessage).not.toMatch(/additional propert/i);
      }
    });
  }
});
