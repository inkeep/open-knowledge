/**
 * Suppress the MCP first-launch consent dialog for suites that are not testing
 * it.
 *
 * The dialog is gated on `app.isPackaged`, so it never appears against a dev
 * build and always appears against a real DMG on a fresh HOME. It is a Radix
 * modal over the navigator, and its overlay swallows clicks aimed at the
 * launcher cards (`nav-open`, `nav-create-new`): the locator resolves, the
 * click is intercepted, and the test dies on a 30s timeout that reads like a
 * missing button rather than a modal in the way. That is invisible in the
 * source-based smoke run and only bites when the packaged gate runs a DMG.
 *
 * Seeding a completed marker is the app's own suppression path — the same one
 * `mcp-wiring.e2e.ts` exercises for its relaunch-idempotency case — so the
 * wiring subsystem still initializes and its IPC handlers stay registered.
 * `OK_RECLAIM_DISABLE=1` also silences the dialog but returns an inert handle
 * before any handler is registered, which leaves the renderer's readiness ping
 * unanswered and prints a spurious main-process error on every launch.
 *
 * Do NOT call this from a suite that asserts on the consent dialog: it would
 * make those assertions vacuous.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Marker the main process reads to decide whether consent already happened. */
export function mcpStatusMarkerPath(tmpHome: string): string {
  return join(tmpHome, '.ok', 'mcp-status.json');
}

/** Write a `configured: true` marker into `tmpHome` so the dialog stays closed. */
export function seedMcpConsentComplete(tmpHome: string): void {
  mkdirSync(join(tmpHome, '.ok'), { recursive: true });
  writeFileSync(
    mcpStatusMarkerPath(tmpHome),
    JSON.stringify({
      configured: true,
      configuredAt: new Date().toISOString(),
      editors: [],
      cliPath: '/usr/local/bin/ok',
    }),
  );
}
