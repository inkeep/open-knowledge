import type { Command } from 'commander';
import { describe, expect, test } from 'vitest';
import { diagnoseCommand } from './diagnose.ts';

function bundleCommand(): Command {
  const bundle = diagnoseCommand().commands.find((c) => c.name() === 'bundle');
  if (bundle === undefined) throw new Error('`bundle` subcommand missing from `ok diagnose`');
  return bundle;
}

function parse(argv: string[]): { redact: unknown; unknown: string[] } {
  const cmd = bundleCommand();
  const { unknown } = cmd.parseOptions(argv);
  return { redact: cmd.opts().redact, unknown };
}

describe('ok diagnose bundle — redaction switch', () => {
  test('redacts when neither spelling is passed', () => {
    expect(parse([])).toEqual({ redact: true, unknown: [] });
  });

  test('--no-redact opts out', () => {
    expect(parse(['--no-redact'])).toEqual({ redact: false, unknown: [] });
  });

  test('--redact is accepted and keeps redaction on', () => {
    expect(parse(['--redact'])).toEqual({ redact: true, unknown: [] });
  });

  test('--redact stays known when it follows another flag', () => {
    expect(parse(['--yes', '--redact'])).toEqual({ redact: true, unknown: [] });
  });

  test('the last spelling on the command line wins', () => {
    expect(parse(['--redact', '--no-redact']).redact).toBe(false);
    expect(parse(['--no-redact', '--redact']).redact).toBe(true);
  });

  test('both spellings are listed in --help', () => {
    const help = bundleCommand().helpInformation();
    expect(help).toMatch(/^\s+--redact\s+\S/m);
    expect(help).toMatch(/^\s+--no-redact\s+\S/m);
  });
});
