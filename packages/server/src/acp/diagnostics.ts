import { scrubSecrets } from '@inkeep/open-knowledge-core';

export const ACQUISITION_DETAIL_MAX_CHARS = 16_000;

export function redactDiagnostic(text: string): string {
  return scrubSecrets(text.replace(/(https?:\/\/)[^\s/]+@/gi, '$1***@'));
}

export function createDiagnosticStderrCapture(consume: (line: string) => void): {
  write: (chunk: string) => void;
  end: () => void;
} {
  let pending = '';
  let dropping = false;
  const flush = (): void => {
    if (dropping) consume('[oversized diagnostic line omitted]');
    else if (pending !== '') consume(redactDiagnostic(pending));
    pending = '';
    dropping = false;
  };
  return {
    write(chunk) {
      for (const [index, part] of chunk.split('\n').entries()) {
        if (index > 0) flush();
        if (dropping) continue;
        if (pending.length + part.length > ACQUISITION_DETAIL_MAX_CHARS) {
          pending = '';
          dropping = true;
        } else {
          pending += part;
        }
      }
    },
    end: flush,
  };
}
