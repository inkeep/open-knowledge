import { beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MENU_LABELS } from '@inkeep/open-knowledge-core';

/**
 * Parity guard for the file/tree labels that appear in BOTH the native Electron
 * menu and the in-app renderer menus.
 *
 * The native menu (`packages/desktop/src/main/menu.ts`) reads `MENU_LABELS`
 * directly. The renderer wraps the SAME strings in Lingui `<Trans>` / t``
 * macros — which require string literals, so the renderer can't import the
 * constants — and those macros compile into this catalog. If a renderer label
 * drifts from a shared constant (e.g. a casing change on one surface only), its
 * value disappears from the catalog and this test fails, catching a divergence
 * the native menu can't observe at runtime (it has no i18n).
 */
function collectStrings(node: unknown, out: Set<string>): void {
  if (typeof node === 'string') {
    out.add(node);
  } else if (Array.isArray(node)) {
    for (const child of node) collectStrings(child, out);
  } else if (node && typeof node === 'object') {
    for (const child of Object.values(node)) collectStrings(child, out);
  }
}

const catalogStrings = new Set<string>();

// Read the compiled catalog in a hook (not module scope) so a missing/unparseable
// catalog surfaces as a clear hook failure rather than an opaque module-load error
// that masks the per-label assertions.
beforeAll(() => {
  const catalog = JSON.parse(
    readFileSync(join(import.meta.dir, '..', 'locales', 'en', 'messages.json'), 'utf8'),
  ) as { messages: Record<string, unknown> };
  collectStrings(catalog.messages, catalogStrings);
});

describe('shared menu labels stay in sync between the native menu and the renderer', () => {
  for (const [key, label] of Object.entries(MENU_LABELS)) {
    it(`renderer catalog contains MENU_LABELS.${key} ("${label}")`, () => {
      expect(catalogStrings.has(label)).toBe(true);
    });
  }
});
