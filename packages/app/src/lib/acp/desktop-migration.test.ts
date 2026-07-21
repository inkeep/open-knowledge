import type { InstallState } from '@inkeep/open-knowledge-core';
import { beforeEach, describe, expect, test } from 'vitest';
import { VISIBLE_TARGETS } from '@/lib/handoff/targets';
import { desktopTargetsToMigrate, isExistingLauncherUser } from './desktop-migration';

const backing = new Map<string, string>();
if (typeof globalThis.localStorage === 'undefined') {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
    clear: () => backing.clear(),
  };
}

const firstTargetId = VISIBLE_TARGETS[0].id;
const secondTargetId = VISIBLE_TARGETS[1].id;

function states(entries: Record<string, boolean | null>): Record<string, InstallState> {
  return Object.fromEntries(
    Object.entries(entries).map(([id, installed]) => [id, { installed } as InstallState]),
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('isExistingLauncherUser', () => {
  test('false on a fresh install (no prior launcher keys)', () => {
    expect(isExistingLauncherUser()).toBe(false);
  });

  test('true when a legacy preferred-agent pick exists', () => {
    localStorage.setItem('ok-preferred-agent-v1', 'claude-code');
    expect(isExistingLauncherUser()).toBe(true);
  });

  test('true when the unified sticky pick exists', () => {
    localStorage.setItem('ok-ask-ai-agent-v2', 'codex');
    expect(isExistingLauncherUser()).toBe(true);
  });

  test('the feature-added seed keys do NOT count as prior launcher use', () => {
    // A brand-new user gets these written by the in-app seed; they must not
    // trip the migration into treating a fresh install as existing.
    localStorage.setItem('ok-acp-default-agents-seeded-v1', '1');
    localStorage.setItem('ok-acp-registered-agents-v1', '{}');
    expect(isExistingLauncherUser()).toBe(false);
  });
});

describe('desktopTargetsToMigrate', () => {
  test('null while the probe is unresolved (every entry undefined/null)', () => {
    expect(desktopTargetsToMigrate({})).toBeNull();
    expect(desktopTargetsToMigrate(states({ [firstTargetId]: null }))).toBeNull();
  });

  test('null while ANY target is still unresolved (waits for every probe)', () => {
    // The migration is one-shot: committing on a partially-resolved probe would
    // permanently skip whichever target had not landed yet.
    const nearlyResolved = Object.fromEntries(VISIBLE_TARGETS.map((t) => [t.id, false]));
    nearlyResolved[firstTargetId] = true;
    delete nearlyResolved[secondTargetId]; // one probe still pending
    expect(desktopTargetsToMigrate(states(nearlyResolved))).toBeNull();
  });

  test('returns only the installed targets once every probe resolves', () => {
    const allResolved = Object.fromEntries(VISIBLE_TARGETS.map((t) => [t.id, false]));
    allResolved[firstTargetId] = true;
    const result = desktopTargetsToMigrate(states(allResolved));
    expect(result).toEqual([firstTargetId]);
  });

  test('resolves to an empty list when nothing is installed', () => {
    const allFalse = Object.fromEntries(VISIBLE_TARGETS.map((t) => [t.id, false]));
    expect(desktopTargetsToMigrate(states(allFalse))).toEqual([]);
  });
});
