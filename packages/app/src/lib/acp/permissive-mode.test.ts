import { describe, expect, test } from 'vitest';

import { isPermissiveMode } from './permissive-mode';

describe('isPermissiveMode', () => {
  test.each([
    ['claude-agent-acp', 'bypassPermissions', 'Bypass Permissions'],
    ['claude-agent-acp', 'acceptEdits', 'Accept Edits'],
    ['codex-acp', 'agent-full-access', 'Agent (full access)'],
    ['gemini-cli', 'yolo', 'YOLO'],
    ['gemini-cli', 'auto_edit', 'Auto Edit'],
    ['goose', 'auto', 'Auto'],
  ])('flags the real %s mode %s', (_adapter, id, name) => {
    expect(isPermissiveMode({ id, name })).toBe(true);
  });

  test.each([
    ['claude-agent-acp', 'default', 'Default'],
    ['claude-agent-acp', 'plan', 'Plan Mode'],
    ['codex-acp', 'read-only', 'Read-only'],
    ['codex-acp', 'agent', 'Agent'],
    ['cursor-agent', 'agent', 'Agent'],
    ['cursor-agent', 'ask', 'Ask'],
    ['cursor-agent', 'plan', 'Plan'],
    ['gemini-cli', 'default', 'Default'],
    ['goose', 'smart_approve', 'Smart Approve'],
    ['goose', 'approve', 'Approve'],
    ['goose', 'chat', 'Chat'],
    ['pi-acp', 'xhigh', 'Thinking: xhigh'],
  ])('leaves the real %s mode %s alone', (_adapter, id, name) => {
    expect(isPermissiveMode({ id, name })).toBe(false);
  });

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
    ['autocomplete', 'Autocomplete'],
    ['automation', 'Automation'],
  ])('leaves %s alone', (id, name) => {
    expect(isPermissiveMode({ id, name })).toBe(false);
  });

  test('matches on either the id or the name alone', () => {
    expect(isPermissiveMode({ id: 'mode-3', name: 'Bypass permissions' })).toBe(true);
    expect(isPermissiveMode({ id: 'bypassPermissions', name: 'Fast' })).toBe(true);
  });

  test('name is optional', () => {
    expect(isPermissiveMode({ id: 'yolo' })).toBe(true);
    expect(isPermissiveMode({ id: 'plan' })).toBe(false);
  });
});
