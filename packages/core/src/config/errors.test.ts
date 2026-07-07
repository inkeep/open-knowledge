import { describe, expect, test } from 'bun:test';
import {
  ConfigValidationErrorSchema,
  FieldScopeSchema,
  humanFormat,
  isKnownConfigError,
  KnownConfigValidationErrorSchema,
  WriteScopeSchema,
} from './errors.ts';

describe('ConfigValidationErrorSchema', () => {
  test('parses YAML_PARSE variant', () => {
    const parsed = ConfigValidationErrorSchema.parse({
      code: 'YAML_PARSE',
      detail: 'unexpected token at line 12',
    });
    expect(parsed.code).toBe('YAML_PARSE');
  });

  test('parses SCHEMA_INVALID with issues', () => {
    const parsed = ConfigValidationErrorSchema.parse({
      code: 'SCHEMA_INVALID',
      issues: [
        {
          path: ['mcp', 'tools', 'grep', 'maxResults'],
          message: 'Expected number, got string',
          issueCode: 'invalid_type',
        },
      ],
    });
    expect(parsed.code).toBe('SCHEMA_INVALID');
    if (parsed.code === 'SCHEMA_INVALID') {
      expect(parsed.issues).toHaveLength(1);
      expect(parsed.issues[0].path).toEqual(['mcp', 'tools', 'grep', 'maxResults']);
    }
  });

  test('parses NOT_AGENT_SETTABLE with path', () => {
    const parsed = ConfigValidationErrorSchema.parse({
      code: 'NOT_AGENT_SETTABLE',
      path: ['github', 'oauthAppClientId'],
    });
    expect(parsed.code).toBe('NOT_AGENT_SETTABLE');
    if (parsed.code === 'NOT_AGENT_SETTABLE') {
      expect(parsed.path).toEqual(['github', 'oauthAppClientId']);
    }
  });

  test('parses MIXED_SCOPE with paths array', () => {
    const parsed = ConfigValidationErrorSchema.parse({
      code: 'MIXED_SCOPE',
      paths: [
        { path: ['content', 'dir'], scope: 'project' },
        { path: ['mcp', 'tools', 'grep', 'maxResults'], scope: 'user' },
      ],
    });
    expect(parsed.code).toBe('MIXED_SCOPE');
  });

  test('forward-compat tail accepts unknown codes without throwing', () => {
    const parsed = ConfigValidationErrorSchema.parse({
      code: 'FUTURE_CODE_NOT_YET_KNOWN',
      message: 'something the future emitted',
      extraField: { nested: true },
    });
    expect(parsed.code).toBe('FUTURE_CODE_NOT_YET_KNOWN');
    expect(isKnownConfigError(parsed)).toBe(false);
  });

  test('isKnownConfigError narrows on every known literal', () => {
    for (const code of [
      'YAML_PARSE',
      'SCHEMA_INVALID',
      'SCOPE_VIOLATION',
      'NOT_AGENT_SETTABLE',
      'MIXED_SCOPE',
      'WRITE_ERROR',
      'OKIGNORE_INVALID',
      'UNKNOWN',
    ] as const) {
      expect(isKnownConfigError({ code, detail: 'x' } as never)).toBe(true);
    }
  });

  test('parses OKIGNORE_INVALID variant with detail and optional lineNumber', () => {
    const withLine = ConfigValidationErrorSchema.parse({
      code: 'OKIGNORE_INVALID',
      detail: 'empty pattern not allowed',
      lineNumber: 4,
    });
    expect(withLine.code).toBe('OKIGNORE_INVALID');
    if (withLine.code === 'OKIGNORE_INVALID') {
      expect(withLine.detail).toBe('empty pattern not allowed');
      expect(withLine.lineNumber).toBe(4);
    }

    const withoutLine = ConfigValidationErrorSchema.parse({
      code: 'OKIGNORE_INVALID',
      detail: 'body rejected',
    });
    expect(withoutLine.code).toBe('OKIGNORE_INVALID');
    if (withoutLine.code === 'OKIGNORE_INVALID') {
      expect(withoutLine.lineNumber).toBeUndefined();
    }
  });

  test('OKIGNORE_INVALID rejects non-positive lineNumber', () => {
    expect(
      KnownConfigValidationErrorSchema.safeParse({
        code: 'OKIGNORE_INVALID',
        detail: 'x',
        lineNumber: 0,
      }).success,
    ).toBe(false);
    expect(
      KnownConfigValidationErrorSchema.safeParse({
        code: 'OKIGNORE_INVALID',
        detail: 'x',
        lineNumber: -3,
      }).success,
    ).toBe(false);
  });

  test('KnownConfigValidationErrorSchema rejects unknown code', () => {
    const result = KnownConfigValidationErrorSchema.safeParse({
      code: 'NOT_A_KNOWN_CODE',
    });
    expect(result.success).toBe(false);
  });
});

describe('humanFormat', () => {
  test('YAML_PARSE renders detail', () => {
    expect(humanFormat({ code: 'YAML_PARSE', detail: 'bad indentation' })).toContain(
      'bad indentation',
    );
  });

  test('SCHEMA_INVALID renders one line per issue with path joined by .', () => {
    const out = humanFormat({
      code: 'SCHEMA_INVALID',
      issues: [
        {
          path: ['mcp', 'tools', 'grep', 'maxResults'],
          message: 'Expected number',
          issueCode: 'invalid_type',
        },
        {
          path: ['appearance', 'theme'],
          message: 'Invalid enum value',
          issueCode: 'invalid_enum_value',
        },
      ],
    });
    expect(out).toContain('mcp.tools.grep.maxResults: Expected number');
    expect(out).toContain('appearance.theme: Invalid enum value');
  });

  test('SCHEMA_INVALID with empty issues falls back to generic message', () => {
    expect(humanFormat({ code: 'SCHEMA_INVALID', issues: [] })).toBe('Invalid configuration.');
  });

  test('SCHEMA_INVALID renders root path as <root>', () => {
    expect(
      humanFormat({
        code: 'SCHEMA_INVALID',
        issues: [{ path: [], message: 'must be object', issueCode: 'invalid_type' }],
      }),
    ).toContain('<root>: must be object');
  });

  test('NOT_AGENT_SETTABLE renders path', () => {
    expect(
      humanFormat({ code: 'NOT_AGENT_SETTABLE', path: ['github', 'oauthAppClientId'] }),
    ).toContain('github.oauthAppClientId');
  });

  test('SCOPE_VIOLATION renders both scopes', () => {
    const out = humanFormat({
      code: 'SCOPE_VIOLATION',
      path: ['appearance', 'theme'],
      expectedScope: 'user',
      actualScope: 'project',
    });
    expect(out).toContain('appearance.theme');
    expect(out).toContain('project');
    expect(out).toContain('user');
    // Names the file to edit and how to fix.
    expect(out).toContain('~/.ok/global.yml');
    expect(out).toContain('.ok/config.yml');
    expect(out).toContain('Move it to ~/.ok/global.yml');
  });

  test('MIXED_SCOPE summarizes per-path scope assignments with target files', () => {
    const out = humanFormat({
      code: 'MIXED_SCOPE',
      paths: [
        { path: ['content', 'dir'], scope: 'project' },
        { path: ['mcp', 'tools', 'grep', 'maxResults'], scope: 'user' },
      ],
    });
    expect(out).toContain('content.dir → .ok/config.yml (project)');
    expect(out).toContain('mcp.tools.grep.maxResults → ~/.ok/global.yml (user)');
    expect(out).toContain('one file at a time');
  });

  test('UNKNOWN with message renders message; without message renders generic', () => {
    expect(humanFormat({ code: 'UNKNOWN', message: 'boom' })).toBe('boom');
    expect(humanFormat({ code: 'UNKNOWN' })).toBe('Unknown error.');
  });

  test('OKIGNORE_INVALID renders with line number when present', () => {
    const out = humanFormat({
      code: 'OKIGNORE_INVALID',
      detail: 'whitespace-only line',
      lineNumber: 7,
    });
    expect(out).toContain('line 7');
    expect(out).toContain('whitespace-only line');
  });

  test('OKIGNORE_INVALID renders without line number when absent', () => {
    const out = humanFormat({ code: 'OKIGNORE_INVALID', detail: 'body rejected' });
    expect(out).toContain('body rejected');
    expect(out).not.toContain('line ');
  });

  test('forward-compat tail uses message or generic with code', () => {
    expect(humanFormat({ code: 'FUTURE', message: 'hi' })).toBe('hi');
    expect(humanFormat({ code: 'FUTURE' })).toContain('FUTURE');
  });
});

describe('FieldScopeSchema / WriteScopeSchema — project-local', () => {
  test('FieldScopeSchema accepts project-local', () => {
    expect(FieldScopeSchema.parse('project-local')).toBe('project-local');
    // Existing values still parse.
    expect(FieldScopeSchema.parse('user')).toBe('user');
    expect(FieldScopeSchema.parse('project')).toBe('project');
    expect(FieldScopeSchema.parse('either')).toBe('either');
  });

  test('FieldScopeSchema rejects unknown scope values', () => {
    expect(FieldScopeSchema.safeParse('global').success).toBe(false);
  });

  test('WriteScopeSchema accepts project-local', () => {
    expect(WriteScopeSchema.parse('project-local')).toBe('project-local');
    expect(WriteScopeSchema.parse('user')).toBe('user');
    expect(WriteScopeSchema.parse('project')).toBe('project');
  });

  test('WriteScopeSchema rejects "either" (FieldScope-only)', () => {
    expect(WriteScopeSchema.safeParse('either').success).toBe(false);
  });

  test('SCOPE_VIOLATION accepts project-local in expectedScope and actualScope', () => {
    const expectedLocal = ConfigValidationErrorSchema.parse({
      code: 'SCOPE_VIOLATION',
      path: ['autoSync', 'enabled'],
      expectedScope: 'project-local',
      actualScope: 'project',
    });
    expect(expectedLocal.code).toBe('SCOPE_VIOLATION');

    const actualLocal = ConfigValidationErrorSchema.parse({
      code: 'SCOPE_VIOLATION',
      path: ['appearance', 'theme'],
      expectedScope: 'user',
      actualScope: 'project-local',
    });
    expect(actualLocal.code).toBe('SCOPE_VIOLATION');
  });

  test('MIXED_SCOPE accepts project-local entries', () => {
    const parsed = ConfigValidationErrorSchema.parse({
      code: 'MIXED_SCOPE',
      paths: [
        { path: ['autoSync', 'enabled'], scope: 'project-local' },
        { path: ['content', 'dir'], scope: 'project' },
      ],
    });
    expect(parsed.code).toBe('MIXED_SCOPE');
  });

  test('humanFormat renders SCOPE_VIOLATION with project-local in both positions', () => {
    expect(
      humanFormat({
        code: 'SCOPE_VIOLATION',
        path: ['autoSync', 'enabled'],
        expectedScope: 'project-local',
        actualScope: 'project',
      }),
    ).toContain('project-local');

    expect(
      humanFormat({
        code: 'SCOPE_VIOLATION',
        path: ['appearance', 'theme'],
        expectedScope: 'user',
        actualScope: 'project-local',
      }),
    ).toContain('project-local');
  });
});
