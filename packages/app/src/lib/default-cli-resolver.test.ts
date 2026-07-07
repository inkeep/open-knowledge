/**
 * Unit tests for the default-CLI resolver — the one deterministic function that
 * both the header/tab-strip "New chat" launch and the "Ask X" bubble use to
 * pick which CLI to start when the user has not (or has) set a sticky default.
 *
 * Resolution contract:
 *   1. sticky parses to a CLI (via parseStickyCliId) → it, unconditionally
 *      (an explicit pick is honored even when the CLI is KNOWN-absent);
 *   2. else the first KNOWN-installed CLI by priority (claude > codex > opencode > cursor);
 *   3. else 'claude'.
 */

import { describe, expect, test } from 'bun:test';
import { TERMINAL_CLI_IDS, type TerminalCli } from '@inkeep/open-knowledge-core';
import { resolveDefaultCli } from './default-cli-resolver';
import { TERMINAL_CLI_ID, terminalCliId } from './unified-agent-store';

/**
 * Build a FULLY-RESOLVED installed map (every CLI keyed to true/false), matching
 * what the desktop `resolveCliInstalledMap` probe returns — so an absent CLI is
 * explicit `false` (known not-on-PATH), NOT `undefined` (which the resolver
 * treats as still-unknown / cold-start). Pass `{}` for the cold-start case.
 */
function installedMap(clis: readonly TerminalCli[]): Record<TerminalCli, boolean> {
  return Object.fromEntries(TERMINAL_CLI_IDS.map((cli) => [cli, clis.includes(cli)])) as Record<
    TerminalCli,
    boolean
  >;
}

describe('resolveDefaultCli', () => {
  describe('sticky pick', () => {
    test('a sticky CLI that is installed wins, even over a higher-priority installed CLI', () => {
      // codex is sticky and installed; claude (higher priority) is also installed —
      // the explicit pick must beat the priority auto-pick.
      expect(resolveDefaultCli(terminalCliId('codex'), installedMap(['claude', 'codex']))).toBe(
        'codex',
      );
    });

    test('a sticky CLI that is NOT installed is still honored (respect the explicit pick)', () => {
      // cursor is sticky but not on PATH; codex/opencode ARE installed. The
      // explicit pick still wins — launching it surfaces the "Get Cursor" banner
      // rather than silently substituting an installed CLI the user didn't pick.
      expect(resolveDefaultCli(terminalCliId('cursor'), installedMap(['opencode', 'codex']))).toBe(
        'cursor',
      );
    });

    test('the legacy bare `terminal-cli` sentinel resolves to claude when installed', () => {
      expect(resolveDefaultCli(TERMINAL_CLI_ID, installedMap(['claude', 'codex']))).toBe('claude');
    });

    test('the legacy bare sentinel is honored (claude) even when claude is not installed', () => {
      // The bare sentinel is a real prior terminal pick (claude-only era), so it
      // is honored as an explicit claude pick rather than substituting opencode.
      expect(resolveDefaultCli(TERMINAL_CLI_ID, installedMap(['opencode']))).toBe('claude');
    });

    test('an app-target sticky (not a CLI sentinel) is ignored — New chat only launches CLIs', () => {
      // 'claude-code' is a HandoffTarget id, not a terminal-cli:<cli> sentinel;
      // parseStickyCliId returns null, so we fall through to first-installed.
      expect(resolveDefaultCli('claude-code', installedMap(['codex']))).toBe('codex');
    });
  });

  describe('priority auto-pick (no usable sticky)', () => {
    test('null sticky picks the highest-priority installed CLI', () => {
      expect(resolveDefaultCli(null, installedMap(['codex', 'opencode', 'cursor']))).toBe('codex');
    });

    test('respects the full priority order claude > codex > opencode > cursor', () => {
      expect(resolveDefaultCli(null, installedMap(['opencode', 'cursor']))).toBe('opencode');
      expect(resolveDefaultCli(null, installedMap(['cursor']))).toBe('cursor');
      expect(resolveDefaultCli(null, installedMap(['claude', 'codex', 'opencode', 'cursor']))).toBe(
        'claude',
      );
    });
  });

  describe('nothing installed', () => {
    test('empty install map + no sticky → claude (the install-nudge default)', () => {
      expect(resolveDefaultCli(null, {})).toBe('claude');
    });

    test('all-false install map → claude', () => {
      expect(
        resolveDefaultCli(null, { claude: false, codex: false, opencode: false, cursor: false }),
      ).toBe('claude');
    });

    test('a KNOWN-absent sticky CLI with nothing installed is still honored', () => {
      // Fully-resolved all-false map: codex is known not-on-PATH, but the explicit
      // pick still wins over the (empty) priority auto-pick — the launch then
      // surfaces the "Get Codex" missing-CLI banner.
      expect(resolveDefaultCli(terminalCliId('codex'), installedMap([]))).toBe('codex');
    });
  });

  describe('cold start (probe not yet resolved → unknown, not known-absent)', () => {
    test('a sticky CLI is honored against an empty/unknown map (not dropped to claude)', () => {
      // The header/tab-strip New chat can fire before the async login-shell probe
      // fills the map; the remembered pick must survive rather than silently
      // becoming claude — matching the Ask-X bubble.
      expect(resolveDefaultCli(terminalCliId('codex'), {})).toBe('codex');
    });

    test('no sticky + unknown map → claude (priority auto-pick needs a positive install)', () => {
      expect(resolveDefaultCli(null, {})).toBe('claude');
    });
  });
});
