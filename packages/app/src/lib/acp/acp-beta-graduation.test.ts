import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_LOCALES } from '@inkeep/open-knowledge-core';
import { describe, expect, it } from 'vitest';
import { messageOrigins } from '../../../scripts/lingui-message-origins.mjs';

const APP_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const LOCALES_DIR = fileURLToPath(new URL('../../locales', import.meta.url));

const LOCALES: readonly string[] = [...SUPPORTED_LOCALES].sort();

function readPo(locale: string): string {
  return readFileSync(join(LOCALES_DIR, locale, 'messages.po'), 'utf8');
}

function hasMsgid(po: string, id: string): boolean {
  return po.split('\n\n').some((block) => block.split('\n').includes(`msgid "${id}"`));
}

function sourceFilesMentioning(text: string): string[] {
  const srcDir = join(APP_ROOT, 'src');
  return readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
    .filter((path) => /\.tsx?$/.test(path) && !/\.(test|e2e|stories)\./.test(path))
    .map((path) => `src/${path.replaceAll('\\', '/')}`)
    .filter((path) => readFileSync(join(APP_ROOT, path), 'utf8').includes(text));
}

describe('ACP feature-Beta graduation — localization catalogs', () => {
  it('covers every shipped locale, so a single-locale leftover cannot hide', () => {
    expect(LOCALES).toContain('en');
    expect(LOCALES.length).toBeGreaterThanOrEqual(13);
    expect(
      readdirSync(LOCALES_DIR)
        .filter((name) => LOCALES.includes(name))
        .sort(),
    ).toEqual(LOCALES);
  });

  it('drops the "In app (beta)" accessible name from every locale', () => {
    const offenders = LOCALES.filter((locale) => hasMsgid(readPo(locale), 'In app (beta)'));
    expect(offenders).toEqual([]);
  });

  it('drops it from the compiled catalogs the app actually loads', () => {
    const offenders = LOCALES.filter((locale) =>
      readFileSync(join(LOCALES_DIR, locale, 'messages.json'), 'utf8').includes('In app (beta)'),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps the plain "In app" group name in every locale', () => {
    const missing = LOCALES.filter((locale) => !hasMsgid(readPo(locale), 'In app'));
    expect(missing).toEqual([]);
  });

  it('leaves the unrelated Beta vocabulary intact', async () => {
    const en = readPo('en');
    const origins = await messageOrigins(APP_ROOT, sourceFilesMentioning('Beta'));
    expect([...(origins.get('Beta') ?? [])]).toEqual([
      'src/components/settings/PluginBetaBadge.tsx',
    ]);
    expect(hasMsgid(en, 'BETA')).toBe(true);
    expect(hasMsgid(en, 'Beta channel')).toBe(true);
  });
});
