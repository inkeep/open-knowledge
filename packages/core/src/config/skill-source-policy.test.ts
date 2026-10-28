import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mergeLayered } from './merge-layered.ts';
import { readConfigSafely } from './read-config-safely.ts';
import { ConfigSchema } from './schema.ts';
import { getLeafFieldMeta } from './schema-leaf.ts';
import { validatePatchScopes } from './validate-patch-scopes.ts';
import { resolveConfigPath, writeConfigPatch } from './write-config-patch.ts';

describe('website skill private-origin trust', () => {
  const origin = 'https://skills.example.com';
  const trusted = ConfigSchema.parse({ skills: { trustedPrivateOrigins: [origin] } });
  const defaults = ConfigSchema.parse({});
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'skill-trust-config-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function configFile(): string {
    const file = resolveConfigPath('user', home, home);
    mkdirSync(dirname(file), { recursive: true });
    return file;
  }

  test('reports each rejected entry with its location without erasing valid siblings', () => {
    const file = configFile();
    writeFileSync(
      file,
      `skills:\n  trustedPrivateOrigins:\n    - ${origin}\n    - https://user:fixture-secret@skills.example.com/path?token=fixture\n`,
    );
    const warnings: string[] = [];
    const result = readConfigSafely({
      absPath: file,
      sideline: false,
      warn: (value) => warnings.push(value),
    });
    expect(result.value.skills.trustedPrivateOrigins).toEqual([origin, null]);
    expect(result.diagnostics).toContainEqual({
      code: 'VALUE_FALLBACK',
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: ['skills', 'trustedPrivateOrigins', '1'],
          source: expect.objectContaining({ file, line: 4 }),
        }),
      ]),
    });
    expect(warnings.join('\n')).toContain('skills.trustedPrivateOrigins.1');
    expect(warnings.join('\n')).not.toContain('fixture-secret');
    expect(warnings.join('\n')).not.toContain('token=fixture');
  });

  test('preserves valid user trust when an unrelated config field is invalid', () => {
    const file = configFile();
    writeFileSync(
      file,
      `server:\n  port: invalid\nskills:\n  trustedPrivateOrigins: [${origin}]\n`,
    );
    const result = readConfigSafely({ absPath: file, sideline: false, warn: () => {} });
    expect(result.valid).toBe(false);
    expect(result.value.skills.trustedPrivateOrigins).toEqual([origin]);
  });

  test('explains that a non-array trust value discards the entire list', () => {
    const file = configFile();
    writeFileSync(file, `skills:\n  trustedPrivateOrigins: ${origin}\n`);
    const result = readConfigSafely({ absPath: file, sideline: false, warn: () => {} });
    expect(result.value.skills.trustedPrivateOrigins).toEqual([]);
    expect(result.diagnostics).toContainEqual({
      code: 'VALUE_FALLBACK',
      issues: [
        expect.objectContaining({
          path: ['skills', 'trustedPrivateOrigins'],
          message: expect.stringContaining('ignoring the trusted website origins list'),
        }),
      ],
    });
  });

  test('rejects an invalid user patch instead of acknowledging an unusable approval', async () => {
    const args = {
      cwd: home,
      scope: 'user' as const,
      homedirOverride: home,
      firstWriteHeader: null,
    };
    expect(
      (await writeConfigPatch({ ...args, patch: { skills: { trustedPrivateOrigins: [origin] } } }))
        .ok,
    ).toBe(true);
    const before = readFileSync(configFile(), 'utf8');
    const result = await writeConfigPatch({
      ...args,
      patch: { skills: { trustedPrivateOrigins: [origin, `${origin}/`] } },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'SCHEMA_INVALID' } });
    expect(readFileSync(configFile(), 'utf8')).toBe(before);
  });

  test('requires user trust rather than either project layer', () => {
    expect(defaults.skills.trustedPrivateOrigins).toEqual([]);
    expect(mergeLayered(defaults, trusted, trusted).skills.trustedPrivateOrigins).toEqual([]);
    expect(mergeLayered(trusted, defaults, defaults).skills.trustedPrivateOrigins).toEqual([
      origin,
    ]);
    for (const scope of ['project', 'project-local'] as const) {
      expect(
        validatePatchScopes({ skills: { trustedPrivateOrigins: [origin] } }, scope),
      ).toMatchObject({ code: 'SCOPE_VIOLATION' });
    }
    expect(validatePatchScopes({ skills: { trustedPrivateOrigins: [origin] } }, 'user')).toBeNull();
  });

  test('does not make the setting agent-settable', () => {
    expect(getLeafFieldMeta(ConfigSchema, ['skills', 'trustedPrivateOrigins'])).toMatchObject({
      scope: 'user',
      agentSettable: false,
    });
  });

  test.each([
    'http://skills.example.com',
    'https://*.example.com',
    'https://skills.example.com/',
    'https://skills.example.com/path',
    'https://skills.example.com?query',
    'https://skills.example.com#fragment',
    'https://user:password@skills.example.com',
    'https://skills.example.com:443',
    'not-a-url',
  ])('fails closed for a nonexact HTTPS origin: %s', (value) => {
    expect(
      ConfigSchema.parse({ skills: { trustedPrivateOrigins: [value] } }).skills
        .trustedPrivateOrigins,
    ).toEqual([null]);
  });

  test('allows exact origin ports without granting related hosts', () => {
    expect(
      ConfigSchema.parse({ skills: { trustedPrivateOrigins: ['https://skills.example.com:8443'] } })
        .skills.trustedPrivateOrigins,
    ).toEqual(['https://skills.example.com:8443']);
  });
});
