import { describe, expect, it } from 'bun:test';
import { buildMcpConfigMigrateEvent } from './mcp-migrate-event.ts';

describe('buildMcpConfigMigrateEvent', () => {
  it('produces the unified event shape across the three emission surfaces', () => {
    const event = buildMcpConfigMigrateEvent({
      scope: 'project',
      surface: 'desktop-project-open',
      editorId: 'cursor',
      configPath: '/proj/.cursor/mcp.json',
      priorEntry: { command: 'npx', args: ['-y', 'foo', 'mcp'] },
    });
    expect(event).toEqual({
      event: 'mcp-config-migrate',
      scope: 'project',
      surface: 'desktop-project-open',
      editorId: 'cursor',
      configPath: '/proj/.cursor/mcp.json',
      priorCommand: 'npx',
      priorArgs: ['-y', 'foo', 'mcp'],
    });
  });

  it('truncates priorCommand to 200 chars', () => {
    const longCommand = 'a'.repeat(300);
    const event = buildMcpConfigMigrateEvent({
      scope: 'user',
      surface: 'cli-repair',
      editorId: 'claude',
      configPath: '/home/x/.claude.json',
      priorEntry: { command: longCommand, args: [] },
    });
    expect(typeof event.priorCommand).toBe('string');
    expect(event.priorCommand?.length).toBe(200);
  });

  it('truncates priorArgs to 10 entries and each string to 200 chars', () => {
    const fifteenLongArgs = Array.from({ length: 15 }, () => 'x'.repeat(300));
    const event = buildMcpConfigMigrateEvent({
      scope: 'user',
      surface: 'cli-repair',
      editorId: 'claude',
      configPath: '/home/x/.claude.json',
      priorEntry: { command: 'npx', args: fifteenLongArgs },
    });
    expect(event.priorArgs?.length).toBe(10);
    expect((event.priorArgs as string[])[0]?.length).toBe(200);
  });

  it('passes non-string args through unchanged (only string elements truncate)', () => {
    // A foreign config could theoretically carry numeric or object args.
    // The truncation guards against unbounded strings; numbers/objects
    // pass through so the event still surfaces the shape.
    const event = buildMcpConfigMigrateEvent({
      scope: 'user',
      surface: 'cli-repair',
      editorId: 'claude',
      configPath: '/x',
      priorEntry: { command: 'foo', args: [42, { obj: true }, 'short'] },
    });
    expect(event.priorArgs).toEqual([42, { obj: true }, 'short']);
  });

  it('returns null priorCommand when missing or non-string', () => {
    for (const entry of [{}, { command: 42 }, { command: null }, { command: { x: 1 } }]) {
      const event = buildMcpConfigMigrateEvent({
        scope: 'user',
        surface: 'cli-repair',
        editorId: 'claude',
        configPath: '/x',
        priorEntry: entry as Record<string, unknown>,
      });
      expect(event.priorCommand).toBeNull();
    }
  });

  it('returns null priorArgs when missing or non-array', () => {
    for (const entry of [{}, { args: 'oops' }, { args: { 0: 'mcp' } }]) {
      const event = buildMcpConfigMigrateEvent({
        scope: 'user',
        surface: 'cli-repair',
        editorId: 'claude',
        configPath: '/x',
        priorEntry: entry as Record<string, unknown>,
      });
      expect(event.priorArgs).toBeNull();
    }
  });
});
