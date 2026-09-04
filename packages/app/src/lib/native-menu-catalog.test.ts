import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMAND_IDENTITIES, NATIVE_MENU_LABELS } from '@inkeep/open-knowledge-core';
import { beforeAll, describe, expect, it, test } from 'vitest';
import { i18n } from '@/lib/i18n';
import { MENU_LABEL_TEXT_MESSAGES, NATIVE_MENU_MESSAGES } from '@/lib/native-menu-catalog';

const catalogMessages = new Set<string>();

function sourceFormOf(compiled: unknown): string | null {
  if (typeof compiled === 'string') return compiled;
  if (!Array.isArray(compiled)) return null;
  let out = '';
  for (const token of compiled) {
    if (typeof token === 'string') {
      out += token;
    } else if (Array.isArray(token) && typeof token[0] === 'string' && token.length === 1) {
      out += `{${token[0]}}`;
    } else {
      return null;
    }
  }
  return out;
}

const SELF_VALUES = { appName: '{appName}', word: '{word}' };

beforeAll(() => {
  i18n.activate('en');
  const compiled = JSON.parse(
    readFileSync(join(import.meta.dir, '..', 'locales', 'en', 'messages.json'), 'utf8'),
  ) as { messages: Record<string, unknown> };
  for (const entry of Object.values(compiled.messages)) {
    const source = sourceFormOf(entry);
    if (source !== null) catalogMessages.add(source);
  }
});

describe('every native-menu descriptor matches its shared constant', () => {
  test('the compiled catalog was actually read', () => {
    expect(catalogMessages.size).toBeGreaterThan(2000);
  });

  for (const [key, source] of Object.entries(NATIVE_MENU_LABELS)) {
    it(`NATIVE_MENU_MESSAGES.${key} resolves to "${source}"`, () => {
      const descriptor = NATIVE_MENU_MESSAGES[key as keyof typeof NATIVE_MENU_MESSAGES];
      expect(descriptor).toBeDefined();
      expect(i18n._(descriptor, SELF_VALUES)).toBe(source);
    });

    it(`the catalog carries NATIVE_MENU_LABELS.${key}`, () => {
      expect(
        catalogMessages.has(source),
        `Run \`pnpm run i18n\` — "${source}" is not in the compiled catalog, so the native menu ` +
          'renders it in English in every language.',
      ).toBe(true);
    });
  }

  test('no descriptor exists without a constant behind it', () => {
    const orphans = Object.keys(NATIVE_MENU_MESSAGES).filter((key) => !(key in NATIVE_MENU_LABELS));
    expect(orphans).toEqual([]);
  });
});

describe('registry menu-only labels reach the catalog too', () => {
  const registryLabels = [
    ...new Set(
      COMMAND_IDENTITIES.flatMap(
        (cmd) =>
          cmd.menu
            ?.map((placement) => placement.menuLabelText)
            .filter((text): text is string => text !== undefined) ?? [],
      ),
    ),
  ].sort();

  test('the registry declares some, so this suite is not vacuous', () => {
    expect(registryLabels.length).toBeGreaterThan(0);
  });

  test('the declared descriptors cover exactly the registry values', () => {
    const declared = MENU_LABEL_TEXT_MESSAGES.map((descriptor) => i18n._(descriptor)).sort();
    expect(
      declared,
      'MENU_LABEL_TEXT_MESSAGES must mirror every `menuLabelText` in the command registry — a ' +
        'value with no descriptor never reaches the catalog and ships English in every language.',
    ).toEqual(registryLabels);
  });

  for (const label of registryLabels) {
    it(`the catalog carries the menuLabelText "${label}"`, () => {
      expect(catalogMessages.has(label)).toBe(true);
    });
  }
});
