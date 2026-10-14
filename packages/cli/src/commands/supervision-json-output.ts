import { writeSync } from 'node:fs';

export interface JsonWriterDeps {
  write?: (bytes: Uint8Array, offset: number) => number;
  diagnostic?: (message: string) => void;
  setExitCode?: (code: 0 | 1) => void;
}

export function writeJsonDocument(
  document: unknown,
  exitCode: 0 | 1 | (() => 0 | 1),
  deps: JsonWriterDeps = {},
): boolean {
  const write =
    deps.write ?? ((bytes, offset) => writeSync(1, bytes, offset, bytes.length - offset));
  const diagnostic = deps.diagnostic ?? ((message) => console.error(message));
  const setExitCode = deps.setExitCode ?? ((code) => (process.exitCode = code));

  try {
    const serialized = JSON.stringify(document);
    if (typeof serialized !== 'string') throw new Error('Document serialization returned no JSON');
    const bytes = Buffer.from(`${serialized}\n`, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = write(bytes, offset);
      if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset) {
        throw new Error('Document write did not advance');
      }
      offset += written;
    }
    setExitCode(typeof exitCode === 'function' ? exitCode() : exitCode);
    return true;
  } catch (error) {
    diagnostic(
      `Could not write supervision JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    setExitCode(1);
    return false;
  }
}
