import { describe, expect, it } from 'vitest';
import type { RenderedItem } from '@/lib/acp/thread-event-model';
import { transcriptItemId } from './transcript-item-id';

// transcriptItemId only reads `kind` and the id field, so fixtures stay minimal.
const msg = (messageId: string, role: 'user' | 'agent' | 'thought' = 'agent'): RenderedItem =>
  ({ kind: 'message', role, text: '', messageId }) as RenderedItem;
const tool = (toolCallId: string): RenderedItem =>
  ({ kind: 'tool_call', toolCallId }) as RenderedItem;
const notice = (): RenderedItem => ({ kind: 'notice', text: '', tone: 'info' }) as RenderedItem;

describe('transcriptItemId', () => {
  it('is unique across sibling messages that share the default messageId', () => {
    // The ordinary turn: a thought chunk then an agent chunk, both arriving with
    // no adapter messageId, so both key to 'default'.
    const items = [msg('default', 'thought'), msg('default', 'agent')];
    expect(new Set(items.map(transcriptItemId)).size).toBe(items.length);
  });

  it('is unique across a mixed append-only transcript', () => {
    const items: RenderedItem[] = [
      msg('default', 'user'),
      msg('default', 'agent'),
      tool('call-1'),
      msg('default', 'agent'),
      notice(),
      notice(),
    ];
    expect(new Set(items.map(transcriptItemId)).size).toBe(items.length);
  });

  it('is stable for a coalesced message re-rendered at the same index', () => {
    expect(transcriptItemId(msg('default'), 3)).toBe(transcriptItemId(msg('default'), 3));
  });
});
