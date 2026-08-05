import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMAND_IDENTITIES, NATIVE_MENU_LABELS } from '@inkeep/open-knowledge-core';
import { beforeAll, describe, expect, it, test } from 'vitest';
import { i18n } from '@/lib/i18n';
import { MENU_LABEL_TEXT_MESSAGES, NATIVE_MENU_MESSAGES } from '@/lib/native-menu-catalog';

/**
 * Parity guard for the labels the NATIVE menu renders and the renderer does
 * not: Electron's `role:` labels, the menu-bar titles, the recents submenus,
 * and the two context menus.
 *
 * The main process resolves each by hashing its English source to a message id
 * and looking that id up in the compiled catalog, so a string that never
 * reached the catalog silently renders English in every language. Extraction
 * only walks `packages/app/src`, which is why the descriptors in
 * `native-menu-catalog.ts` exist at all — this file proves they still say the
 * same thing as the constants main passes, and that the catalog carries them.
 *
 * Membership is checked by STRING VALUE, not by descriptor id: this package's
 * vitest config aliases the Lingui macros to an English-passthrough shim, so a
 * descriptor here has no real hashed id to look up. The desktop suite checks
 * the id side, against the same catalog, using the same hash main uses.
 */

/** Every message the compiled catalog carries, back in ICU source form. */
const catalogMessages = new Set<string>();

/**
 * Rebuild a compiled entry's source text. Lingui stores a plain message as a
 * bare string and an interpolated one as a token array — `"About {appName}"`
 * compiles to `["About ", ["appName"]]` — so a flat string sweep would never
 * find the four placeholder-bearing menu labels.
 */
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
      // Plurals and selects — not a shape any native-menu label uses.
      return null;
    }
  }
  return out;
}

/** Placeholder-bearing sources render an empty slot when no values are given,
 *  so the comparison substitutes the placeholder name back into itself. */
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
  // `menuLabelText` overrides the command's own `labelKey` for the native menu
  // and has no palette counterpart, so nothing else puts these in the catalog.
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
