import { describe, expect, test } from 'bun:test';
import { KNOWN_TARGETS, VISIBLE_TARGETS } from './targets.ts';

describe('KNOWN_TARGETS', () => {
  test('has exactly five targets (four GUI + terminal-only OpenCode)', () => {
    expect(KNOWN_TARGETS.length).toBe(5);
  });

  test('ids cover the full HandoffTarget union', () => {
    const ids = new Set(KNOWN_TARGETS.map((t) => t.id));
    expect(ids).toEqual(new Set(['claude-cowork', 'claude-code', 'codex', 'cursor', 'opencode']));
  });

  test('opencode is terminal-only — no URL scheme', () => {
    const opencode = KNOWN_TARGETS.find((t) => t.id === 'opencode');
    expect(opencode?.schemes).toEqual([]);
  });

  test('claude-cowork + claude-code share the claude: scheme (single install state)', () => {
    const cowork = KNOWN_TARGETS.find((t) => t.id === 'claude-cowork');
    const code = KNOWN_TARGETS.find((t) => t.id === 'claude-code');
    expect(cowork?.schemes).toEqual(['claude:']);
    expect(code?.schemes).toEqual(['claude:']);
  });

  test('codex maps to codex: and cursor maps to cursor:', () => {
    const codex = KNOWN_TARGETS.find((t) => t.id === 'codex');
    const cursor = KNOWN_TARGETS.find((t) => t.id === 'cursor');
    expect(codex?.schemes).toEqual(['codex:']);
    expect(cursor?.schemes).toEqual(['cursor:']);
  });

  test('every target has an https install URL', () => {
    for (const t of KNOWN_TARGETS) {
      expect(t.installUrl.startsWith('https://')).toBe(true);
    }
  });

  test('displayNames match SPEC §7.2 (PQ4 DIRECTED)', () => {
    const byId = new Map(KNOWN_TARGETS.map((t) => [t.id, t.displayName]));
    expect(byId.get('claude-cowork')).toBe('Claude Cowork');
    expect(byId.get('claude-code')).toBe('Claude');
    expect(byId.get('codex')).toBe('Codex');
    expect(byId.get('cursor')).toBe('Cursor');
    expect(byId.get('opencode')).toBe('OpenCode');
  });
});

describe('VISIBLE_TARGETS (UI render allow-list)', () => {
  // VISIBLE_TARGETS is what every Open-in-Agent render surface iterates
  // (header dropdown, FileTree context submenu, command palette agent group,
  // empty-state "Create with <agent>" composer). Dispatch by ID still routes through
  // KNOWN_TARGETS so power users / deep links retain every target —
  // VISIBLE_TARGETS only governs what the UI exposes.
  test('hides claude-cowork from the UI', () => {
    const ids = new Set(VISIBLE_TARGETS.map((t) => t.id));
    expect(ids.has('claude-cowork')).toBe(false);
  });

  test('hides the terminal-only opencode target from the GUI deep-link list', () => {
    // OpenCode surfaces as a terminal-CLI launch row (TERMINAL_CLI_IDS), not a
    // GUI deep-link target, so it must not appear in VISIBLE_TARGETS.
    const ids = new Set(VISIBLE_TARGETS.map((t) => t.id));
    expect(ids.has('opencode')).toBe(false);
  });

  test('keeps the remaining three targets visible', () => {
    const ids = new Set(VISIBLE_TARGETS.map((t) => t.id));
    expect(ids).toEqual(new Set(['claude-code', 'codex', 'cursor']));
  });

  test('is a strict subset of KNOWN_TARGETS (data preserved, just filtered)', () => {
    for (const target of VISIBLE_TARGETS) {
      expect(KNOWN_TARGETS).toContain(target);
    }
    expect(VISIBLE_TARGETS.length).toBeLessThan(KNOWN_TARGETS.length);
  });
});
