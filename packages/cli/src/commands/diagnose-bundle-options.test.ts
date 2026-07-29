/**
 * Option wiring for `ok diagnose bundle`.
 *
 * The redaction switch is a Commander boolean-negation pair with two sharp
 * edges. Declaration order decides the default: a lone `--no-redact` defaults
 * `redact` to true, but declaring the positive form first suppresses that and
 * leaves it undefined. And a spelling Commander does not know is collected as
 * an unknown option, which `parse()` turns into a hard error whose "did you
 * mean" suggestion names the negated form — steering a user who asked for
 * redaction into an unredacted bundle.
 *
 * `parseOptions` is the classifier `parse()` consults for both, so the wiring
 * can be driven against the real command object without firing the action
 * handler (which would collect a bundle off the cwd).
 */

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
