import { describe, expect, test } from 'vitest';

import {
  isDesktopTargetEnabled,
  isInAppAgentEnabled,
  isTerminalCliEnabled,
} from './agent-visibility';
import { desktopEnabledKey, inAppEnabledKey, terminalEnabledKey } from './enabled-agents';

describe('agent-visibility — in-app', () => {
  test('defaults to registered; override wins either way', () => {
    // No override: enabled iff registered. `supported: true` throughout.
    expect(isInAppAgentEnabled({}, 'registry', 'claude', true, true)).toBe(true);
    expect(isInAppAgentEnabled({}, 'registry', 'claude', false, true)).toBe(false);
    // Override false hides even a registered agent; override true shows an
    // unregistered one.
    const key = inAppEnabledKey('registry', 'claude');
    expect(isInAppAgentEnabled({ [key]: false }, 'registry', 'claude', true, true)).toBe(false);
    expect(isInAppAgentEnabled({ [key]: true }, 'registry', 'claude', false, true)).toBe(true);
  });

  test('supported: undefined fails open (catalog not yet hydrated)', () => {
    expect(isInAppAgentEnabled({}, 'registry', 'claude', true, undefined)).toBe(true);
  });

  test('supported: false force-hides regardless of override or registration', () => {
    const key = inAppEnabledKey('registry', 'cursor');
    // Registered → still hidden when unsupported.
    expect(isInAppAgentEnabled({}, 'registry', 'cursor', true, false)).toBe(false);
    // Even an explicit enable override cannot turn on an unsupported agent, so
    // the menus and the Settings toggle can never disagree.
    expect(isInAppAgentEnabled({ [key]: true }, 'registry', 'cursor', true, false)).toBe(false);
  });
});

describe('agent-visibility — terminal (fail-open default)', () => {
  test('Claude is not special-cased: hidden when the probe reports it absent', () => {
    // Unknown (undefined) → shown (fail-open); positively absent → hidden, same
    // as every other CLI. Claude no longer overrides install detection.
    expect(isTerminalCliEnabled({}, 'claude', {})).toBe(true);
    expect(isTerminalCliEnabled({}, 'claude', { claude: true })).toBe(true);
    expect(isTerminalCliEnabled({}, 'claude', { claude: false })).toBe(false);
  });

  test('other CLIs default enabled unless positively absent', () => {
    // Unknown (undefined) → shown (fail-open); positively absent → hidden.
    expect(isTerminalCliEnabled({}, 'codex', {})).toBe(true);
    expect(isTerminalCliEnabled({}, 'codex', { codex: true })).toBe(true);
    expect(isTerminalCliEnabled({}, 'codex', { codex: false })).toBe(false);
  });

  test('override wins over the fail-open default', () => {
    const key = terminalEnabledKey('codex');
    // Enable a positively-absent CLI; disable an otherwise-visible one.
    expect(isTerminalCliEnabled({ [key]: true }, 'codex', { codex: false })).toBe(true);
    expect(isTerminalCliEnabled({ [key]: false }, 'codex', { codex: true })).toBe(false);
    // Even Claude can be turned off explicitly.
    expect(isTerminalCliEnabled({ [terminalEnabledKey('claude')]: false }, 'claude', {})).toBe(
      false,
    );
  });
});

describe('agent-visibility — desktop (off by default)', () => {
  test('defaults to off regardless of install detection (opt-in)', () => {
    expect(isDesktopTargetEnabled({}, 'claude-code')).toBe(false);
    expect(isDesktopTargetEnabled({}, 'codex')).toBe(false);
  });

  test('override wins — an enabled target shows, disabled stays hidden', () => {
    const key = desktopEnabledKey('cursor');
    expect(isDesktopTargetEnabled({ [key]: true }, 'cursor')).toBe(true);
    expect(isDesktopTargetEnabled({ [key]: false }, 'cursor')).toBe(false);
  });
});
