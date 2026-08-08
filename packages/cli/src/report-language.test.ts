/**
 * Tests for the CLI's default interface-language reader. Real disk fixtures
 * (no fs mocks) with an injected home and environment, so nothing here touches
 * the developer's own `~/.ok/global.yml` or `LANG`.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import { afterEach, describe, expect, test } from 'vitest';
import { defaultReadLanguage } from './report-language.ts';

const tmpDirs: string[] = [];

function makeHome(configBody?: string): string {
  const home = mkdtempSync(resolve(tmpdir(), 'ok-report-language-'));
  tmpDirs.push(home);
  if (configBody !== undefined) {
    const absPath = resolveConfigPath('user', home, home);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, configBody);
  }
  return home;
}

afterEach(() => {
  for (const d of tmpDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

describe('defaultReadLanguage', () => {
  test('reads an explicit choice unresolved, beside what it resolved to', () => {
    const home = makeHome('appearance:\n  language: es\n');

    const language = defaultReadLanguage({ home, env: { LANG: 'en_US.UTF-8' } });

    expect(language.preference).toBe('es');
    expect(language.locale).toBe('es');
    expect(language.source).toBe('explicit');
  });

  // The distinction the whole block exists for: 'system' resolving to English
  // and English being chosen are the same `locale` and opposite diagnoses.
  test("an unset preference reads as 'system' and resolves off the OS list", () => {
    const home = makeHome();

    const language = defaultReadLanguage({ home, env: { LANG: 'fr_FR.UTF-8' } });

    expect(language.preference).toBe('system');
    expect(language.locale).toBe('fr');
    expect(language.source).toBe('system');
    expect(language.systemLanguages).toEqual(['fr-FR']);
  });

  test('records the OS list that the system tier matched against', () => {
    const home = makeHome();

    const language = defaultReadLanguage({
      home,
      env: { LANG: 'en_US.UTF-8', LANGUAGE: 'pt_BR:es_ES' },
    });

    expect(language.systemLanguages).toEqual(['pt-BR', 'es-ES', 'en-US']);
  });

  test('an OK_LANG override is reported as the tier that decided', () => {
    const home = makeHome('appearance:\n  language: es\n');

    const language = defaultReadLanguage({ home, env: { OK_LANG: 'fr', LANG: 'en_US.UTF-8' } });

    expect(language.locale).toBe('fr');
    expect(language.source).toBe('override');
    // The stored choice is still what the user selected — the override says
    // why the app is not showing it, and erasing it here would hide that.
    expect(language.preference).toBe('es');
  });

  test('no locale signal at all lands on the fallback rather than throwing', () => {
    const home = makeHome();

    const language = defaultReadLanguage({ home, env: {} });

    expect(language.source).toBe('fallback');
    expect(language.locale).toBe('en');
  });

  // A config that no longer parses may be the very thing being reported, so the
  // capture must still produce a bundle.
  test('a corrupt user config degrades to system instead of failing the capture', () => {
    const home = makeHome('appearance: [this is not\n  valid: yaml\n');

    const language = defaultReadLanguage({ home, env: { LANG: 'en_US.UTF-8' } });

    expect(language.preference).toBe('system');
    expect(language.locale).toBe('en');
  });

  test('a language the schema does not know degrades rather than rejecting the read', () => {
    const home = makeHome('appearance:\n  language: kl\n');

    expect(() => defaultReadLanguage({ home, env: { LANG: 'en_US.UTF-8' } })).not.toThrow();
  });
});
