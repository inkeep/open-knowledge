import { describe, expect, test } from 'vitest';
import { consumeAuthEventStream } from './auth-event-stream';

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('consumeAuthEventStream', () => {
  test('fires onSuccess when a complete event arrives with a trailing newline', async () => {
    const seen: string[] = [];
    const terminated = await consumeAuthEventStream(
      streamFromChunks([
        '{"type":"verification","user_code":"ABCD-1234"}\n',
        '{"type":"complete","host":"github.com","login":"alice"}\n',
      ]),
      (line) => {
        seen.push(line);
        const event = JSON.parse(line) as { type: string };
        return event.type === 'complete' ? 'terminal' : 'continue';
      },
    );
    expect(terminated).toBe(true);
    expect(seen).toHaveLength(2);
    expect(JSON.parse(seen[1]).login).toBe('alice');
  });

  test('fires onSuccess when a terminal event arrives WITHOUT a trailing newline', async () => {
    let completed: string | null = null;
    const terminated = await consumeAuthEventStream(
      streamFromChunks([
        '{"type":"verification","user_code":"ABCD-1234"}\n',
        '{"type":"complete","host":"github.com","login":"bob"}',
      ]),
      (line) => {
        const event = JSON.parse(line) as { type: string; login?: string };
        if (event.type === 'complete') {
          completed = event.login ?? null;
          return 'terminal';
        }
        return 'continue';
      },
    );
    expect(terminated).toBe(true);
    expect(completed).toBe('bob');
  });

  test('returns false when the stream closes without a terminal event', async () => {
    const terminated = await consumeAuthEventStream(
      streamFromChunks(['{"type":"verification","user_code":"ABCD-1234"}\n']),
      (line) => {
        const event = JSON.parse(line) as { type: string };
        return event.type === 'complete' || event.type === 'error' ? 'terminal' : 'continue';
      },
    );
    expect(terminated).toBe(false);
  });

  test('handles lines split across chunks', async () => {
    let completed: string | null = null;
    const terminated = await consumeAuthEventStream(
      streamFromChunks(['{"type":"comp', 'lete","host":"github.com","login":"ca', 'rol"}\n']),
      (line) => {
        const event = JSON.parse(line) as { type: string; login?: string };
        if (event.type === 'complete') {
          completed = event.login ?? null;
          return 'terminal';
        }
        return 'continue';
      },
    );
    expect(terminated).toBe(true);
    expect(completed).toBe('carol');
  });

  test('ignores malformed JSON lines and empty lines', async () => {
    const seen: string[] = [];
    const terminated = await consumeAuthEventStream(
      streamFromChunks(['\n\nnot-json\n{"type":"complete","login":"dave"}\n']),
      (line) => {
        seen.push(line);
        try {
          const event = JSON.parse(line) as { type: string };
          return event.type === 'complete' ? 'terminal' : 'continue';
        } catch {
          return 'continue';
        }
      },
    );
    expect(terminated).toBe(true);
    expect(seen).toEqual(['not-json', '{"type":"complete","login":"dave"}']);
  });

  test('early return skips remaining lines in the same chunk', async () => {
    const seen: string[] = [];
    const terminated = await consumeAuthEventStream(
      streamFromChunks(['{"type":"complete","login":"x"}\n{"type":"verification"}\n']),
      (line) => {
        seen.push(line);
        const event = JSON.parse(line) as { type: string };
        return event.type === 'complete' ? 'terminal' : 'continue';
      },
    );
    expect(terminated).toBe(true);
    expect(seen).toHaveLength(1);
  });
});
