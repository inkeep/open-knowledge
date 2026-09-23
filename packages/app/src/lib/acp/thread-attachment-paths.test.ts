import { describe, expect, test } from 'vitest';
import { threadAttachmentPaths } from './thread-attachment-paths';
import type { RenderedItem } from './thread-event-model';

const user = (messageId: string, paths: readonly string[]): RenderedItem => ({
  kind: 'message',
  role: 'user',
  text: 'hi',
  messageId,
  attachments: paths.map((path) => ({ kind: 'file' as const, path, name: path })),
});

describe('threadAttachmentPaths', () => {
  test('lists what the user attached, most recent message first, without repeats', () => {
    const items: RenderedItem[] = [
      user('m1', ['notes.md', 'specs/a.md']),
      { kind: 'message', role: 'agent', text: 'ok' } as RenderedItem,
      user('m2', ['specs/a.md', 'plan.md']),
    ];

    expect(threadAttachmentPaths(items)).toEqual(['specs/a.md', 'plan.md', 'notes.md']);
  });

  test('a thread with no attachments yields nothing', () => {
    expect(threadAttachmentPaths([user('m1', [])])).toEqual([]);
  });

  test('only file and folder attachments carry a path; images and blobs are skipped', () => {
    const item: RenderedItem = {
      kind: 'message',
      role: 'user',
      text: 'hi',
      messageId: 'm1',
      attachments: [
        { kind: 'image', data: 'AAAA', mimeType: 'image/png', name: 'shot.png' },
        { kind: 'folder', path: 'specs', name: 'specs' },
        { kind: 'blob', data: 'AAAA', textPayload: true, mimeType: 'text/plain', name: 'x.txt' },
        { kind: 'file', path: 'plan.md', name: 'plan.md' },
      ],
    };

    expect(threadAttachmentPaths([item])).toEqual(['specs', 'plan.md']);
  });
});
