import { describe, expect, test } from 'vitest';

import { isPermissiveMode } from './permissive-mode';

describe('isPermissiveMode', () => {
  // The id/name pairs below are the real `session/new` modes read out of the
  // shipped adapters (claude-agent-acp 0.63.0, codex-acp 1.1.7, gemini-cli
  // 0.52.0, cursor-agent 2026.07.23) — not their CLI flags, which differ.
  test.each([
    ['claude-agent-acp', 'bypassPermissions', 'Bypass Permissions'],
    ['claude-agent-acp', 'acceptEdits', 'Accept Edits'],
    // Codex's mode id is `agent-full-access`; `danger-full-access` is the
    // sandbox policy behind it and never reaches us as a mode.
    ['codex-acp', 'agent-full-access', 'Agent (full access)'],
    ['gemini-cli', 'yolo', 'YOLO'],
    ['gemini-cli', 'auto_edit', 'Auto Edit'],
    // goose names full autonomy exactly `auto` — matched as a whole word, so
    // an unrelated mode merely containing "auto" isn't dragged in with it.
    ['goose', 'auto', 'Auto'],
  ])('flags the real %s mode %s', (_adapter, id, name) => {
    expect(isPermissiveMode({ id, name })).toBe(true);
  });

  test.each([
    ['claude-agent-acp', 'default', 'Default'],
    ['claude-agent-acp', 'plan', 'Plan Mode'],
    ['codex-acp', 'read-only', 'Read-only'],
    // `agent` is Codex's AND Cursor's ordinary default — flagging it would put
    // a warning on the mode almost everyone runs.
    ['codex-acp', 'agent', 'Agent'],
    ['cursor-agent', 'agent', 'Agent'],
    ['cursor-agent', 'ask', 'Ask'],
    ['cursor-agent', 'plan', 'Plan'],
    ['gemini-cli', 'default', 'Default'],
    // Still prompts for the risky operations — flagging it would warn on
    // goose's recommended everyday mode.
    ['goose', 'smart_approve', 'Smart Approve'],
    ['goose', 'approve', 'Approve'],
    ['goose', 'chat', 'Chat'],
    // pi-acp puts reasoning effort on the modes surface, not permissions.
    ['pi-acp', 'xhigh', 'Thinking: xhigh'],
  ])('leaves the real %s mode %s alone', (_adapter, id, name) => {
    expect(isPermissiveMode({ id, name })).toBe(false);
  });

  // Not observed as mode ids, but this vocabulary is present in the shipped
  // binaries (opencode carries `unrestricted` / `autoApprove` / `dangerously`,
  // amp carries `dangerously`), so an agent surfacing one stays covered.
  test.each([
    ['dangerously-skip-permissions', 'Skip all permission checks'],
    ['full-auto', 'Full Auto'],
    ['auto_approve', 'Auto-approve tools'],
    ['no-confirm', 'Run without confirmation'],
    ['unrestricted', 'Unrestricted'],
  ])('flags %s on naming alone', (id, name) => {
    expect(isPermissiveMode({ id, name })).toBe(true);
  });

  test.each([
    ['code', 'Code'],
    ['architect', 'Architect'],
    ['edit', 'Edit'],
    ['workspace-write', 'Workspace write'],
    // "auto" flags only as a whole mode (goose), never as a substring.
    ['autocomplete', 'Autocomplete'],
    ['automation', 'Automation'],
  ])('leaves %s alone', (id, name) => {
    expect(isPermissiveMode({ id, name })).toBe(false);
  });

  test('matches on either the id or the name alone', () => {
    // Harnesses disagree about which half carries the meaning.
    expect(isPermissiveMode({ id: 'mode-3', name: 'Bypass permissions' })).toBe(true);
    expect(isPermissiveMode({ id: 'bypassPermissions', name: 'Fast' })).toBe(true);
  });

  test('name is optional', () => {
    expect(isPermissiveMode({ id: 'yolo' })).toBe(true);
    expect(isPermissiveMode({ id: 'plan' })).toBe(false);
  });
});
