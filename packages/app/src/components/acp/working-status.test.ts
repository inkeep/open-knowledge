import { describe, expect, test } from 'vitest';
import type { RenderedItem, RenderedToolCall } from '@/lib/acp/thread-event-model';
import {
  activeToolKind,
  nextThinkingIndex,
  THINKING_HOLD_MS,
  thinkingHoldMs,
  thinkingStatusLines,
  workingStatusText,
} from './working-status';

function toolCall(toolKind: string, status: RenderedToolCall['status']): RenderedItem {
  return {
    kind: 'tool_call',
    toolCallId: `${toolKind}-${status}`,
    title: toolKind,
    toolKind,
    status,
    diffs: [],
    terminalIds: [],
    content: [],
    locations: [],
    rawInput: null,
  };
}

const message: RenderedItem = {
  kind: 'message',
  role: 'agent',
  text: 'hello',
  messageId: 'm1',
};

describe('activeToolKind', () => {
  test('finds nothing in an empty or message-only transcript', () => {
    expect(activeToolKind([])).toBeNull();
    expect(activeToolKind([message])).toBeNull();
  });

  test('reports the kind of a call that is running', () => {
    expect(activeToolKind([toolCall('read', 'in_progress')])).toBe('read');
  });

  test('counts an accepted-but-not-started call as in flight', () => {
    expect(activeToolKind([toolCall('search', 'pending')])).toBe('search');
  });

  test('ignores calls that already settled', () => {
    expect(activeToolKind([toolCall('read', 'completed')])).toBeNull();
    expect(activeToolKind([toolCall('edit', 'failed')])).toBeNull();
  });

  test('speaks for the most recent live call, not the first', () => {
    const items = [
      toolCall('read', 'completed'),
      toolCall('search', 'in_progress'),
      toolCall('edit', 'in_progress'),
    ];
    expect(activeToolKind(items)).toBe('edit');
  });

  test('looks past trailing messages to a still-running call', () => {
    expect(activeToolKind([toolCall('execute', 'in_progress'), message])).toBe('execute');
  });
});

describe('thinking rotation', () => {
  test('always lands on a different line', () => {
    const count = thinkingStatusLines().length;
    for (let current = 0; current < count; current++) {
      for (let step = 0; step < 40; step++) {
        const next = nextThinkingIndex(current, count, step / 40);
        expect(next).not.toBe(current);
        expect(next).toBeGreaterThanOrEqual(0);
        expect(next).toBeLessThan(count);
      }
    }
  });

  test('can reach every other line from any starting point', () => {
    const count = thinkingStatusLines().length;
    for (let current = 0; current < count; current++) {
      const reached = new Set<number>();
      for (let step = 0; step < 200; step++) {
        reached.add(nextThinkingIndex(current, count, step / 200));
      }
      expect(reached.size).toBe(count - 1);
    }
  });

  test('degenerates safely to a single line', () => {
    expect(nextThinkingIndex(0, 1, 0.99)).toBe(0);
  });

  test('holds within the configured range so the beat never sounds metronomic', () => {
    expect(thinkingHoldMs(0)).toBe(THINKING_HOLD_MS.min);
    expect(thinkingHoldMs(1)).toBe(THINKING_HOLD_MS.max);
    expect(thinkingHoldMs(0.5)).toBeGreaterThan(THINKING_HOLD_MS.min);
    expect(thinkingHoldMs(0.5)).toBeLessThan(THINKING_HOLD_MS.max);
  });
});

describe('thinkingStatusLines', () => {
  test('offers several distinct, non-empty phrases', () => {
    const lines = thinkingStatusLines();
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.trim()).not.toBe('');
    expect(new Set(lines).size).toBe(lines.length);
  });
});

describe('workingStatusText', () => {
  const KINDS = ['read', 'search', 'fetch', 'edit', 'delete', 'execute', 'think'];
  const LINE_COUNT = thinkingStatusLines().length;
  const EVERY_LINE = Array.from({ length: LINE_COUNT }, (_, i) => i);

  test('gives every known tool kind its own line', () => {
    const lines = KINDS.map((kind) => workingStatusText(kind, 0));
    for (const line of lines) expect(line.trim()).not.toBe('');
    expect(new Set(lines).size).toBe(KINDS.length);
  });

  test('a live tool call outranks the idle rotation', () => {
    for (const line of EVERY_LINE) {
      expect(workingStatusText('read', line)).toBe(workingStatusText('read', 0));
    }
  });

  test('walks the whole idle vocabulary as the rotation advances', () => {
    const shown = EVERY_LINE.map((line) => workingStatusText(null, line));
    expect(new Set(shown).size).toBe(LINE_COUNT);
  });

  test('renders a line for any index the rotation could hand it', () => {
    for (const index of [-1, 0, LINE_COUNT, LINE_COUNT * 3 + 1, 9_999]) {
      expect(workingStatusText(null, index).trim()).not.toBe('');
    }
  });

  test('falls back to the idle vocabulary for a tool kind it has no line for', () => {
    expect(workingStatusText('teleport', 2)).toBe(workingStatusText(null, 2));
  });

  test('never promises a time', () => {
    for (const line of EVERY_LINE) {
      for (const kind of [null, ...KINDS]) {
        expect(workingStatusText(kind, line)).not.toMatch(/almost|nearly|second|soon|%/i);
      }
    }
  });
});
