
import { describe, expect, test } from 'bun:test';
import type { InstallState, TargetData } from '@inkeep/open-knowledge-core';
import { KNOWN_TARGETS } from '@/lib/handoff/targets';

function targetById(id: TargetData['id']): TargetData {
  const found = KNOWN_TARGETS.find((t) => t.id === id);
  if (!found) throw new Error(`unknown target id: ${id}`);
  return found;
}

describe('OpenInAgentMenuItem module surface', () => {
  test('exports the component, helpers, and the OK desktop install URL', async () => {
    const mod = await import('./OpenInAgentMenuItem');
    expect(typeof mod.OpenInAgentMenuItem).toBe('function');
    expect(typeof mod.computeRowState).toBe('function');
    expect(typeof mod.computeRowHint).toBe('function');
    expect(typeof mod.OK_DESKTOP_INSTALL_URL).toBe('string');
    expect(mod.OK_DESKTOP_INSTALL_URL.startsWith('https://')).toBe(true);
  });

  test('OK_DESKTOP_INSTALL_URL points at the releases page, not the source README', async () => {
    const { OK_DESKTOP_INSTALL_URL } = await import('./OpenInAgentMenuItem');
    expect(OK_DESKTOP_INSTALL_URL).toContain('/releases');
  });
});

describe('computeRowHint — short inline status hint on the trigger row', () => {
  test('Cursor on web-host with probe=true → null (no hint, treated like any other installed target)', async () => {
    const { computeRowHint } = await import('./OpenInAgentMenuItem');
    const hint = computeRowHint({
      target: targetById('cursor'),
      installState: { installed: true, lastChecked: 1 },
      isElectronHost: false,
    });
    expect(hint).toBeNull();
  });

  test('Cursor on web-host with probe=false → "Not installed" (same as any other target)', async () => {
    const { computeRowHint } = await import('./OpenInAgentMenuItem');
    const hint = computeRowHint({
      target: targetById('cursor'),
      installState: { installed: false, lastChecked: 1 },
      isElectronHost: false,
    });
    expect(hint).toBe('Not installed');
  });

  test('pre-probe (installed:null) → "Detecting"', async () => {
    const { computeRowHint } = await import('./OpenInAgentMenuItem');
    const hint = computeRowHint({
      target: targetById('codex'),
      installState: { installed: null },
      isElectronHost: true,
    });
    expect(hint).toBe('Detecting');
  });

  test('installed:false → "Not installed"', async () => {
    const { computeRowHint } = await import('./OpenInAgentMenuItem');
    const hint = computeRowHint({
      target: targetById('claude-code'),
      installState: { installed: false, lastChecked: 1 },
      isElectronHost: true,
    });
    expect(hint).toBe('Not installed');
  });

  test('enabled row → null (no hint needed)', async () => {
    const { computeRowHint } = await import('./OpenInAgentMenuItem');
    const hint = computeRowHint({
      target: targetById('claude-cowork'),
      installState: { installed: true, lastChecked: 1 },
      isElectronHost: true,
    });
    expect(hint).toBeNull();
  });
});

describe('computeRowState — Cursor parity with other targets (no host short-circuit)', () => {
  test('Cursor on web-host with probe=true is enabled (no override)', async () => {
    const { computeRowState } = await import('./OpenInAgentMenuItem');
    const state = computeRowState({
      target: targetById('cursor'),
      installState: { installed: true, lastChecked: 1 },
      isElectronHost: false,
    });
    expect(state.enabled).toBe(true);
    expect(state.tooltip).toBeNull();
  });

  test('Cursor on web-host with probe=false uses the vendor install URL like every other target', async () => {
    const { computeRowState } = await import('./OpenInAgentMenuItem');
    const state = computeRowState({
      target: targetById('cursor'),
      installState: { installed: false },
      isElectronHost: false,
    });
    expect(state.tooltip?.installAction.label).toBe('Install Cursor →');
    expect(state.tooltip?.installAction.url).toBe('https://cursor.com/');
  });

  test('Cursor on Electron-host with installed:true is enabled', async () => {
    const { computeRowState } = await import('./OpenInAgentMenuItem');
    const state = computeRowState({
      target: targetById('cursor'),
      installState: { installed: true, lastChecked: 1 },
      isElectronHost: true,
    });
    expect(state.enabled).toBe(true);
    expect(state.tooltip).toBeNull();
  });
});

describe('computeRowState — branch 1: pre-probe', () => {
  test.each([
    ['claude-cowork' as const, true],
    ['claude-code' as const, true],
    ['codex' as const, true],
    ['cursor' as const, true],
    ['claude-cowork' as const, false],
    ['claude-code' as const, false],
    ['codex' as const, false],
    ['cursor' as const, false],
  ])('row %s on isElectronHost=%s with installed:null is disabled with no tooltip', async (id, isElectronHost) => {
    const { computeRowState } = await import('./OpenInAgentMenuItem');
    const state = computeRowState({
      target: targetById(id),
      installState: { installed: null },
      isElectronHost,
    });
    expect(state.enabled).toBe(false);
    expect(state.tooltip).toBeNull();
  });
});

describe('computeRowState — branch 3: not installed → install affordance only', () => {
  test('Codex disabled tooltip — install affordance', async () => {
    const { computeRowState } = await import('./OpenInAgentMenuItem');
    const state = computeRowState({
      target: targetById('codex'),
      installState: { installed: false, lastChecked: 1 },
      isElectronHost: true,
    });
    expect(state.enabled).toBe(false);
    expect(state.tooltip?.message).toBe('Requires Codex Desktop.');
    expect(state.tooltip?.installAction.label).toBe('Install Codex Desktop →');
    expect(state.tooltip?.installAction.url).toBe('https://openai.com/codex');
  });

  test('Claude Cowork disabled tooltip — install affordance', async () => {
    const { computeRowState } = await import('./OpenInAgentMenuItem');
    const state = computeRowState({
      target: targetById('claude-cowork'),
      installState: { installed: false, lastChecked: 1 },
      isElectronHost: true,
    });
    expect(state.enabled).toBe(false);
    expect(state.tooltip?.message).toBe('Requires Claude Desktop.');
    expect(state.tooltip?.installAction.label).toBe('Install Claude Desktop →');
    expect(state.tooltip?.installAction.url).toBe('https://claude.com/download');
  });

  test('Claude disabled tooltip — install affordance', async () => {
    const { computeRowState } = await import('./OpenInAgentMenuItem');
    const state = computeRowState({
      target: targetById('claude-code'),
      installState: { installed: false, lastChecked: 1 },
      isElectronHost: true,
    });
    expect(state.enabled).toBe(false);
    expect(state.tooltip?.installAction.label).toBe('Install Claude Desktop →');
  });

  test('Cursor (Electron) disabled tooltip — install affordance', async () => {
    const { computeRowState } = await import('./OpenInAgentMenuItem');
    const state = computeRowState({
      target: targetById('cursor'),
      installState: { installed: false, lastChecked: 1 },
      isElectronHost: true,
    });
    expect(state.enabled).toBe(false);
    expect(state.tooltip?.message).toBe('Requires Cursor.');
    expect(state.tooltip?.installAction.label).toBe('Install Cursor →');
    expect(state.tooltip?.installAction.url).toBe('https://cursor.com/');
  });
});

describe('computeRowState — branch 4: installed → enabled', () => {
  test.each([
    ['claude-cowork' as const],
    ['claude-code' as const],
    ['codex' as const],
    ['cursor' as const],
  ])('row %s on Electron with installed:true is enabled, no tooltip', async (id) => {
    const { computeRowState } = await import('./OpenInAgentMenuItem');
    const state = computeRowState({
      target: targetById(id),
      installState: { installed: true, lastChecked: 1 },
      isElectronHost: true,
    });
    expect(state.enabled).toBe(true);
    expect(state.tooltip).toBeNull();
  });

  test.each([
    ['claude-cowork' as const],
    ['claude-code' as const],
    ['codex' as const],
  ])('row %s on web with installed:true is enabled', async (id) => {
    const { computeRowState } = await import('./OpenInAgentMenuItem');
    const state = computeRowState({
      target: targetById(id),
      installState: { installed: true, lastChecked: 1 },
      isElectronHost: false,
    });
    expect(state.enabled).toBe(true);
    expect(state.tooltip).toBeNull();
  });
});

describe('install-state cardinality used by the dropdown', () => {
  test('every KNOWN_TARGETS entry maps to one of the branches under any install state', async () => {
    const { computeRowState } = await import('./OpenInAgentMenuItem');
    const installStates: ReadonlyArray<InstallState> = [
      { installed: null },
      { installed: false, lastChecked: 1 },
      { installed: true, lastChecked: 1 },
    ];
    for (const target of KNOWN_TARGETS) {
      for (const isElectronHost of [true, false]) {
        for (const installState of installStates) {
          const state = computeRowState({ target, installState, isElectronHost });
          if (state.enabled) {
            expect(state.tooltip).toBeNull();
          } else {
            expect(state.tooltip === null || state.tooltip !== undefined).toBe(true);
          }
        }
      }
    }
  });
});
