import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decideSingleFileTarget,
  hasMarkdownExtension,
  isFileishTarget,
  scanRootArgv,
} from './single-file-dispatch.ts';

const SUBCOMMANDS = new Set([
  'start',
  'init',
  'mcp',
  'ui',
  'open',
  'ps',
  'status',
  'stop',
  'clean',
]);

/** Test predicate: markdown extension OR one of an explicit existing-file set. */
function isFileishWith(existing: Set<string>): (t: string) => boolean {
  return (t) => hasMarkdownExtension(t) || existing.has(t);
}

describe('scanRootArgv', () => {
  test('collects positional operands, strips global options', () => {
    expect(scanRootArgv(['notes.md']).operands).toEqual(['notes.md']);
    expect(scanRootArgv(['--no-color', 'notes.md']).operands).toEqual(['notes.md']);
    expect(scanRootArgv(['--log-level', 'debug', 'notes.md']).operands).toEqual(['notes.md']);
    expect(scanRootArgv(['--log-level=debug', 'notes.md']).operands).toEqual(['notes.md']);
    expect(scanRootArgv(['open', 'doc']).operands).toEqual(['open', 'doc']);
  });

  test('extracts --cwd (space + equals form), consuming its value', () => {
    expect(scanRootArgv(['--cwd', '/foo', 'notes.md']).cwd).toBe('/foo');
    expect(scanRootArgv(['--cwd=/bar', 'notes.md']).cwd).toBe('/bar');
    // The --cwd value token is not mistaken for an operand.
    expect(scanRootArgv(['--cwd', '/foo', 'notes.md']).operands).toEqual(['notes.md']);
  });

  test('help/version flags short-circuit to terminal (passthrough to Commander)', () => {
    expect(scanRootArgv(['--help']).sawTerminalFlag).toBe(true);
    expect(scanRootArgv(['-h']).sawTerminalFlag).toBe(true);
    expect(scanRootArgv(['--version']).sawTerminalFlag).toBe(true);
    expect(scanRootArgv(['-V']).sawTerminalFlag).toBe(true);
    expect(scanRootArgv(['notes.md']).sawTerminalFlag).toBe(false);
  });
});

describe('decideSingleFileTarget', () => {
  const opts = (existing: string[] = []) => ({
    knownSubcommands: SUBCOMMANDS,
    isFileish: isFileishWith(new Set(existing)),
  });

  test('a .md / .mdx operand routes to single-file open', () => {
    expect(decideSingleFileTarget(['notes.md'], opts())).toBe('notes.md');
    expect(decideSingleFileTarget(['./a/b.mdx'], opts())).toBe('./a/b.mdx');
  });

  test('an existing file (no markdown ext) routes to single-file open', () => {
    expect(decideSingleFileTarget(['README'], opts(['README']))).toBe('README');
  });

  test('a known subcommand is left for Commander (passthrough)', () => {
    expect(decideSingleFileTarget(['start'], opts())).toBeNull();
    expect(decideSingleFileTarget(['init'], opts())).toBeNull();
    // Even an existing file whose NAME equals a subcommand → the subcommand
    // wins (escape via `ok open ./start`).
    expect(decideSingleFileTarget(['start'], opts(['start']))).toBeNull();
  });

  test('`ok open <file>` (fileish 2nd operand) routes to single-file open of that file', () => {
    expect(decideSingleFileTarget(['open', 'notes.md'], opts())).toBe('notes.md');
    expect(decideSingleFileTarget(['open', './start'], opts(['./start']))).toBe('./start');
  });

  test('`ok open <ext-less doc>` is left to the existing `ok open` subcommand', () => {
    // `specs/foo/SPEC` is neither a markdown filename nor an existing file →
    // the existing ext-less project-doc contract is untouched.
    expect(decideSingleFileTarget(['open', 'specs/foo/SPEC'], opts())).toBeNull();
  });

  test('no operand → passthrough', () => {
    expect(decideSingleFileTarget([], opts())).toBeNull();
  });

  test('a non-fileish first operand → passthrough (Commander reports unknown command)', () => {
    expect(decideSingleFileTarget(['totally-unknown'], opts())).toBeNull();
  });
});

describe('hasMarkdownExtension', () => {
  test('matches .md / .mdx case-insensitively only at the end', () => {
    expect(hasMarkdownExtension('notes.md')).toBe(true);
    expect(hasMarkdownExtension('notes.MDX')).toBe(true);
    expect(hasMarkdownExtension('notes.markdown')).toBe(false);
    expect(hasMarkdownExtension('md')).toBe(false);
    expect(hasMarkdownExtension('a.md.txt')).toBe(false);
  });
});

describe('isFileishTarget (fs-backed predicate)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ok-fileish-'));
    writeFileSync(join(dir, 'note.md'), '# note');
    writeFileSync(join(dir, 'data.json'), '{}');
    mkdirSync(join(dir, 'a-folder'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('a markdown-extension token is fileish (even if it does not exist)', () => {
    expect(isFileishTarget(join(dir, 'missing.md'), 'missing.md')).toBe(true);
  });

  test('an existing regular file is fileish', () => {
    expect(isFileishTarget(join(dir, 'data.json'), 'data.json')).toBe(true);
    expect(isFileishTarget(join(dir, 'note.md'), 'note.md')).toBe(true);
  });

  test('an existing DIRECTORY is NOT fileish — so `ok open <folder>` falls through to the open command', () => {
    expect(isFileishTarget(join(dir, 'a-folder'), 'a-folder')).toBe(false);
  });

  test('a non-existent non-markdown token is not fileish', () => {
    expect(isFileishTarget(join(dir, 'nope'), 'nope')).toBe(false);
  });
});
