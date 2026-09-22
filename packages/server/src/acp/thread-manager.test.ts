import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PromptCapabilities } from '@agentclientprotocol/sdk';
import { describe, expect, test } from 'vitest';
import { deliversSkillInline, inlineSkillBlock } from './thread-manager.ts';

describe('project skill delivery policy', () => {
  test.each([
    ['registry', 'gemini', true],
    ['custom', 'gemini', false],
    ['registry', 'codex-acp', false],
    ['custom', 'codex-acp', false],
    ['registry', 'other-agent', false],
  ] as const)('%s agent %s uses inline delivery: %s', (source, id, expected) => {
    expect(deliversSkillInline({ source, id })).toBe(expected);
  });
});

describe('inline project skill blocks', () => {
  const skillPath = resolve('project with spaces', '.ok', 'local', 'skill #1', 'SKILL.md');
  const text = '# OpenKnowledge\n\nUse the project tools before editing markdown.\n';

  test('an embedded resource preserves the skill text and native file path', () => {
    const block = inlineSkillBlock(skillPath, text, { embeddedContext: true });
    expect(block.type).toBe('resource');
    if (block.type !== 'resource') throw new Error('expected an embedded resource');
    expect(block.resource.mimeType).toBe('text/markdown');
    expect(block.resource).toHaveProperty('text', text);
    expect(fileURLToPath(block.resource.uri)).toBe(skillPath);
    expect(block.resource.uri).toContain('%20');
    expect(block.resource.uri).toContain('%23');
  });

  test.each<PromptCapabilities | null | undefined>([
    undefined,
    null,
    {},
    { embeddedContext: false },
  ])('without embedded resource support (%j), delivers readable text', (capabilities) => {
    const block = inlineSkillBlock(skillPath, text, capabilities);
    expect(block.type).toBe('text');
    if (block.type !== 'text') throw new Error('expected a text block');
    expect(block.text).toContain(text);
    expect(block.text).toContain('SKILL.md');
    expect(block.text).not.toContain(skillPath);
  });
});
