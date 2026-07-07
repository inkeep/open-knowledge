/**
 * consumeAuthEventStream — NDJSON reader for /api/local-op/auth/login.
 *
 * Drives a `ReadableStream<Uint8Array>` through a line-delimited JSON parser
 * and invokes `processLine` for each non-empty line. Returns `true` when a
 * terminal event (`complete` | `error`) fired, `false` when the stream ended
 * without one.
 *
 * Critical property (regression guard): on `done=true`, any trailing bytes
 * held by the incremental decoder are flushed and the final line is processed
 * — even without a terminating newline. Without this step, a `{type:'complete'}`
 * payload delivered as the last chunk without a trailing `\n` would be dropped,
 * leaving the device-flow modal frozen at "Waiting for authorization…".
 */
export async function consumeAuthEventStream(
  stream: ReadableStream<Uint8Array>,
  processLine: (line: string) => 'terminal' | 'continue',
): Promise<boolean> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      if (buffer.trim() && processLine(buffer) === 'terminal') return true;
      return false;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      if (processLine(line) === 'terminal') return true;
    }
  }
}
