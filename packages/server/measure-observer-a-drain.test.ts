import { describe, expect, test } from 'vitest';
import { parseDrainMeasurementArgs } from './measure-observer-a-drain.ts';

describe('measure-observer-a-drain argument parsing', () => {
  test('defaults cover all three carets at the S6 scale', () => {
    expect(parseDrainMeasurementArgs([])).toEqual({
      carets: ['start', 'middle', 'end'],
      fixtureMultiple: 3,
      keystrokes: 15,
    });
  });

  test('a caret list selects a subset in the order given', () => {
    expect(parseDrainMeasurementArgs(['--caret', 'end,start']).carets).toEqual(['end', 'start']);
  });

  test('fixture multiple and keystroke count are read as integers', () => {
    const args = parseDrainMeasurementArgs(['--fixture-multiple', '1', '--keystrokes', '4']);
    expect(args.fixtureMultiple).toBe(1);
    expect(args.keystrokes).toBe(4);
  });

  test('a misspelled flag is rejected rather than silently ignored', () => {
    expect(() => parseDrainMeasurementArgs(['--carets', 'start'])).toThrow(/unknown flag --carets/);
  });

  test('a misspelled flag in trailing position is reported as unknown, not as missing a value', () => {
    expect(() => parseDrainMeasurementArgs(['--carets'])).toThrow(/unknown flag --carets/);
  });

  test('a leading -- separator is normalized away', () => {
    expect(parseDrainMeasurementArgs(['--', '--caret', 'end']).carets).toEqual(['end']);
  });

  test('a -- separator anywhere but the leading position is rejected', () => {
    expect(() => parseDrainMeasurementArgs(['--', '--', '--caret', 'end'])).toThrow(
      /unknown flag --/,
    );
    expect(() => parseDrainMeasurementArgs(['--caret', 'end', '--'])).toThrow(/unknown flag --/);
  });

  test('a flag with no value is rejected rather than keeping the default', () => {
    expect(() => parseDrainMeasurementArgs(['--caret'])).toThrow(/--caret needs a value/);
    expect(() => parseDrainMeasurementArgs(['--keystrokes'])).toThrow(/--keystrokes needs a value/);
  });

  test('a non-decimal numeric literal is rejected rather than coerced', () => {
    expect(() => parseDrainMeasurementArgs(['--fixture-multiple', '0x10'])).toThrow(
      /--fixture-multiple/,
    );
    expect(() => parseDrainMeasurementArgs(['--keystrokes', '1e4'])).toThrow(/--keystrokes/);
  });

  test('a fractional count is rejected rather than truncated', () => {
    expect(() => parseDrainMeasurementArgs(['--fixture-multiple', '3.5'])).toThrow(
      /--fixture-multiple/,
    );
    expect(() => parseDrainMeasurementArgs(['--keystrokes', '2.5'])).toThrow(/--keystrokes/);
  });

  test('an unrecognized caret name is rejected even when a valid one accompanies it', () => {
    expect(() => parseDrainMeasurementArgs(['--caret', 'middleish'])).toThrow(/middleish/);
    expect(() => parseDrainMeasurementArgs(['--caret', 'start,middleish'])).toThrow(/middleish/);
  });

  test('a non-positive fixture multiple is rejected', () => {
    expect(() => parseDrainMeasurementArgs(['--fixture-multiple', '0'])).toThrow(
      /--fixture-multiple/,
    );
  });

  test('a non-positive keystroke count is rejected', () => {
    expect(() => parseDrainMeasurementArgs(['--keystrokes', 'x'])).toThrow(/--keystrokes/);
  });
});
