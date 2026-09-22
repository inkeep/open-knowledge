import { writeSync } from 'node:fs';
import { type Command, Option } from 'commander';
import { type V1Document, v1ExitCode } from './supervision-json-v1.ts';

interface V1WriterDeps {
  write?: (bytes: Uint8Array, offset: number) => number;
  diagnostic?: (message: string) => void;
  setExitCode?: (code: 0 | 1) => void;
}

export function writeV1Document(document: V1Document, deps: V1WriterDeps = {}): boolean {
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
    setExitCode(v1ExitCode(document.result.kind));
    return true;
  } catch (error) {
    diagnostic(
      `Could not write supervision JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    setExitCode(1);
    return false;
  }
}

export function addV1FormatOption(command: Command, legacyJson = false): Command {
  const option = new Option(
    '--format <value>',
    'Emit the versioned supervision JSON document',
  ).choices(['json-v1']);
  if (legacyJson) option.conflicts('json');
  return command.addOption(option);
}
