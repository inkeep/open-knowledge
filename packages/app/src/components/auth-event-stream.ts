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
