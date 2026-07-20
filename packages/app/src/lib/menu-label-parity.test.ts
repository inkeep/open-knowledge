import { beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMAND_IDENTITIES, MENU_LABELS } from '@inkeep/open-knowledge-core';
import {
  PALETTE_COMMAND_LABELS,
  type PaletteLabelKey,
} from '@/components/command-palette-commands';
import { i18n } from '@/lib/i18n';

/**
 * Parity guard for the labels that appear in BOTH the native Electron menu and
 * the in-app renderer (the Cmd+K palette).
 *
 * The native menu (`packages/desktop/src/main/menu.ts`) reads `MENU_LABELS`
 * directly (via each command's registry `labelKey`). The palette maps the SAME
 * `labelKey` to a Lingui `msg` descriptor in `PALETTE_COMMAND_LABELS` — the
 * macro requires a string literal, so the renderer can't import the constants —
 * and those descriptors compile into this catalog. This file asserts three
 * things, so a drift the native menu can't observe at runtime (it has no i18n)
 * turns the suite red:
 *   1. every `MENU_LABELS` value is in the compiled catalog (the original guard);
 *   2. every registry command's palette `labelKey` (and Show/Hide toggle keys)
 *      has a descriptor in `PALETTE_COMMAND_LABELS` (completeness);
 *   3. every palette descriptor resolves to a string that is in the catalog and,
 *      where the key is also a `MENU_LABELS` key, equals the menu string.
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

describe('palette label map covers every registry labelKey (Phase 2b)', () => {
  for (const cmd of COMMAND_IDENTITIES) {
    if (!cmd.palette) continue;
    const keys = cmd.stateToggle
      ? [cmd.stateToggle.showKey, cmd.stateToggle.hideKey]
      : cmd.labelKey !== undefined
        ? [cmd.labelKey]
        : [];
    for (const key of keys) {
      it(`palette command "${cmd.id}" label key "${key}" has a descriptor`, () => {
        expect(key in PALETTE_COMMAND_LABELS).toBe(true);
      });
    }
  }
});

describe('every palette descriptor is in the catalog and agrees with MENU_LABELS', () => {
  for (const [key, descriptor] of Object.entries(PALETTE_COMMAND_LABELS)) {
    const paletteString = i18n._(descriptor);
    it(`palette label "${key}" resolves to a catalog string`, () => {
      expect(catalogStrings.has(paletteString)).toBe(true);
    });
    if (key in MENU_LABELS) {
      it(`palette label "${key}" equals MENU_LABELS.${key}`, () => {
        expect(paletteString).toBe(MENU_LABELS[key as keyof typeof MENU_LABELS]);
      });
    }
  }

  it('every palette label key is a MENU_LABELS key (no orphan palette labels)', () => {
    const orphans = (Object.keys(PALETTE_COMMAND_LABELS) as PaletteLabelKey[]).filter(
      (key) => !(key in MENU_LABELS),
    );
    expect(orphans).toEqual([]);
  });
});
