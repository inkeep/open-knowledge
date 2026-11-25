import type { Command } from 'commander';
import { supervisionFormats } from './supervision-formats.ts';
import { type JsonWriterDeps, writeJsonDocument } from './supervision-json-output.ts';
import { type V1Document, v1ExitCode } from './supervision-json-v1.ts';

export function writeV1Document(document: V1Document, deps: JsonWriterDeps = {}): boolean {
  return writeJsonDocument(document, () => v1ExitCode(document.result.kind), deps);
}

export function addV1FormatOption(command: Command, legacyJson = false): Command {
  return supervisionFormats.addFormatOption(command, legacyJson);
}
