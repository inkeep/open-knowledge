import type { ServerResponse } from 'node:http';
import { describe, expect, test, vi } from 'vitest';
import {
  classifyParseError,
  FrontmatterMalformedError,
  frontmatterRefusalDetail,
  logFrontmatterRefusal,
  respondFrontmatterMalformed,
} from './frontmatter-malformed-error.ts';

describe('classifyParseError — bounded-cardinality refusal class', () => {
  test('top-level non-mapping bucket', () => {
    expect(classifyParseError('top-level value is not a mapping')).toBe('non-mapping-top-level');
  });

  test('schema rejection at a path', () => {
    expect(classifyParseError('value at "metadata" failed schema: Invalid input')).toBe(
      'schema-rejection',
    );
    expect(classifyParseError('value at "" failed schema: Expected string')).toBe(
      'schema-rejection',
    );
  });

  test('schema rejection at root', () => {
    expect(classifyParseError('schema validation failed: Invalid input')).toBe('schema-rejection');
  });

  test('parse threw — bytes failed yaml@2 parse', () => {
    expect(classifyParseError('parse threw: Unexpected token')).toBe('yaml-parse-error');
  });

  test('toJS threw — pathological document', () => {
    expect(classifyParseError('toJS threw: circular reference')).toBe('yaml-parse-error');
  });

  test('yaml@2 free-form line/column message — unquoted-colon class (PRD-6781)', () => {
    expect(
      classifyParseError('Nested mappings are not allowed in compact mappings at line 2, column 7'),
    ).toBe('yaml-parse-error');
    expect(classifyParseError('Map keys must be unique at line 4, column 1')).toBe(
      'yaml-parse-error',
    );
  });

  test('unknown fallback for the sentinel string', () => {
    expect(classifyParseError('unknown YAML parse error')).toBe('unknown');
  });

  test('unknown fallback for the empty string', () => {
    expect(classifyParseError('')).toBe('unknown');
  });

  test('classification is a bounded-cardinality enum (no path/byte content leaks)', () => {
    const classes = new Set<string>();
    for (const sample of [
      'top-level value is not a mapping',
      'value at "metadata.version" failed schema: Invalid',
      'value at "a.b.c.d.e.f.g.h" failed schema: Invalid',
      'schema validation failed: Invalid',
      'parse threw: anything',
      'toJS threw: anything',
      'Nested mappings are not allowed in compact mappings at line 9999, column 9999',
      'unknown YAML parse error',
      '',
    ]) {
      classes.add(classifyParseError(sample));
    }
    expect(classes.size).toBeLessThanOrEqual(4);
    for (const c of classes) {
      expect([
        'yaml-parse-error',
        'non-mapping-top-level',
        'schema-rejection',
        'unknown',
      ]).toContain(c);
    }
  });

  // `byte-0-promotion` is deliberately absent from the list above: the
  // classifier reads parser messages, and that refusal never parsed anything.
  // Its class rides on the error instead — pinned in the block below.
});

/** Minimal `ServerResponse` double — captures status + body, nothing else. */
function captureRes(): { res: ServerResponse; read: () => { status: number; body: string } } {
  const captured = { status: 0, body: '' };
  const res = {
    writeHead(status: number) {
      captured.status = status;
    },
    end(body?: string) {
      captured.body = body ?? '';
    },
  } as unknown as ServerResponse;
  return { res, read: () => captured };
}

describe('respondFrontmatterMalformed — throw-site class and hint win over prose-sniffing', () => {
  test('a byte-0 promotion refusal is NOT counted as a yaml parse error', () => {
    // The whole point of the `class` label is that a spike in
    // `yaml-parse-error` means the parser or schema regressed. Placement
    // refusals landing in that bucket would make the signal unreadable — and
    // they would, since the classifier falls through to it for any non-empty
    // prose. This fails if the `err.refusalClass ??` short-circuit is removed.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { res, read } = captureRes();
      respondFrontmatterMalformed(
        res,
        new FrontmatterMalformedError({
          file: 'doc.md',
          parseError: "the payload's leading `---` fence pair would land at byte 0",
          refusalClass: 'byte-0-promotion',
          hint: 'Start the payload with a blank line.',
        }),
        'agent-write-md',
      );

      const event = JSON.parse(warn.mock.calls.at(-1)?.[0] as string);
      expect(event.event).toBe('frontmatter-malformed-write-refused');
      expect(event.class).toBe('byte-0-promotion');
      // Confirms the bucket it would have landed in without the explicit class.
      expect(
        classifyParseError("the payload's leading `---` fence pair would land at byte 0"),
      ).toBe('yaml-parse-error');

      // The hint replaces the YAML-quoting advice rather than stacking on it.
      const body = JSON.parse(read().body);
      expect(body.detail).toContain('Start the payload with a blank line.');
      expect(body.detail).not.toContain('Quote string values');
    } finally {
      warn.mockRestore();
    }
  });

  test('a real YAML failure still classifies from the parser message and keeps the default hint', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { res, read } = captureRes();
      respondFrontmatterMalformed(
        res,
        new FrontmatterMalformedError({
          file: 'doc.md',
          parseError: 'top-level value is not a mapping',
        }),
        'agent-write-md',
      );

      expect(JSON.parse(warn.mock.calls.at(-1)?.[0] as string).class).toBe('non-mapping-top-level');
      expect(JSON.parse(read().body).detail).toContain('Quote string values');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('logFrontmatterRefusal / frontmatterRefusalDetail — the batch surface agrees', () => {
  // `agent-write-batch` builds a per-entry error object instead of an HTTP
  // response, so it cannot call `respondFrontmatterMalformed` — it calls these
  // two directly. Reading `err.parseError` there instead is what made byte-0
  // promotion refusals count as YAML parse errors on that path alone, so this
  // pins that both surfaces resolve the class and the detail identically.
  test('a promotion refusal keeps its class and hint on the batch path', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const err = new FrontmatterMalformedError({
        file: 'doc.md',
        parseError: "the payload's leading `---` fence pair would land at byte 0",
        refusalClass: 'byte-0-promotion',
        hint: 'Start the payload with a blank line.',
      });

      logFrontmatterRefusal(err, 'agent-write-batch');
      const event = JSON.parse(warn.mock.calls.at(-1)?.[0] as string);
      expect(event.event).toBe('frontmatter-malformed-write-refused');
      expect(event.handler).toBe('agent-write-batch');
      expect(event.class).toBe('byte-0-promotion');

      expect(frontmatterRefusalDetail(err)).toContain('Start the payload with a blank line.');
      expect(frontmatterRefusalDetail(err)).not.toContain('Quote string values');
    } finally {
      warn.mockRestore();
    }
  });

  test('a YAML failure still classifies from the parser message on the batch path', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const err = new FrontmatterMalformedError({
        file: 'doc.md',
        parseError: 'top-level value is not a mapping',
      });
      logFrontmatterRefusal(err, 'agent-write-batch');
      expect(JSON.parse(warn.mock.calls.at(-1)?.[0] as string).class).toBe('non-mapping-top-level');
      expect(frontmatterRefusalDetail(err)).toContain('Quote string values');
    } finally {
      warn.mockRestore();
    }
  });
});
