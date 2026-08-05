import { describe, expect, test } from 'vitest';
import { parseThreadClientFrame } from './thread-protocol.ts';

describe('parseThreadClientFrame', () => {
  test('rejects non-JSON, non-object, and unknown ops', () => {
    expect(parseThreadClientFrame('not json')).toBeNull();
    expect(parseThreadClientFrame('42')).toBeNull();
    expect(parseThreadClientFrame('null')).toBeNull();
    expect(parseThreadClientFrame(JSON.stringify({ op: 'reboot' }))).toBeNull();
  });

  test('create requires reqId and a well-formed agent ref', () => {
    expect(
      parseThreadClientFrame(
        JSON.stringify({ op: 'create', reqId: 'r1', agent: { source: 'registry', id: 'gemini' } }),
      ),
    ).toMatchObject({ op: 'create', reqId: 'r1' });
    expect(
      parseThreadClientFrame(
        JSON.stringify({ op: 'create', agent: { source: 'registry', id: 'x' } }),
      ),
    ).toBeNull();
    expect(
      parseThreadClientFrame(
        JSON.stringify({ op: 'create', reqId: 'r1', agent: { source: 'ftp', id: 'x' } }),
      ),
    ).toBeNull();
    expect(
      parseThreadClientFrame(
        JSON.stringify({ op: 'create', reqId: 'r1', agent: { source: 'custom' } }),
      ),
    ).toBeNull();
  });

  test('prompt requires threadId, reqId, and string content (empty ok)', () => {
    expect(
      parseThreadClientFrame(
        JSON.stringify({ op: 'prompt', threadId: 't', reqId: 'r', content: '' }),
      ),
    ).toMatchObject({ op: 'prompt' });
    expect(
      parseThreadClientFrame(JSON.stringify({ op: 'prompt', threadId: 't', reqId: 'r' })),
    ).toBeNull();
  });

  test('steer requires threadId, reqId, and NON-empty content', () => {
    expect(
      parseThreadClientFrame(
        JSON.stringify({ op: 'steer', threadId: 't', reqId: 'r', content: 'do this instead' }),
      ),
    ).toMatchObject({ op: 'steer', threadId: 't', reqId: 'r', content: 'do this instead' });
    // Unlike `prompt`, empty content is refused — a steer cancels a turn.
    expect(
      parseThreadClientFrame(
        JSON.stringify({ op: 'steer', threadId: 't', reqId: 'r', content: '' }),
      ),
    ).toBeNull();
    expect(
      parseThreadClientFrame(JSON.stringify({ op: 'steer', threadId: 't', reqId: 'r' })),
    ).toBeNull();
    expect(
      parseThreadClientFrame(JSON.stringify({ op: 'steer', threadId: 't', content: 'x' })),
    ).toBeNull();
    expect(
      parseThreadClientFrame(JSON.stringify({ op: 'steer', reqId: 'r', content: 'x' })),
    ).toBeNull();
    expect(
      parseThreadClientFrame(
        JSON.stringify({ op: 'steer', threadId: 't', reqId: 'r', content: 7 }),
      ),
    ).toBeNull();
  });

  test('queue_edit requires threadId, id, and non-empty content', () => {
    expect(
      parseThreadClientFrame(
        JSON.stringify({ op: 'queue_edit', threadId: 't', id: 'q1', content: 'new text' }),
      ),
    ).toMatchObject({ op: 'queue_edit', threadId: 't', id: 'q1', content: 'new text' });
    expect(
      parseThreadClientFrame(
        JSON.stringify({ op: 'queue_edit', threadId: 't', id: 'q1', content: '' }),
      ),
    ).toBeNull();
    expect(
      parseThreadClientFrame(JSON.stringify({ op: 'queue_edit', threadId: 't', content: 'x' })),
    ).toBeNull();
    expect(
      parseThreadClientFrame(JSON.stringify({ op: 'queue_edit', id: 'q1', content: 'x' })),
    ).toBeNull();
  });

  test('queue_edit carries an optional reqId, which must be a non-empty string', () => {
    expect(
      parseThreadClientFrame(
        JSON.stringify({
          op: 'queue_edit',
          threadId: 't',
          id: 'q1',
          content: 'new text',
          reqId: 'qe-1',
        }),
      ),
    ).toMatchObject({ op: 'queue_edit', reqId: 'qe-1' });
    // Absent is the fire-and-forget shape and stays valid — the parser adds no
    // reqId of its own, so the socket keeps answering it silently.
    expect(
      parseThreadClientFrame(
        JSON.stringify({ op: 'queue_edit', threadId: 't', id: 'q1', content: 'new text' }),
      ),
    ).toEqual({ op: 'queue_edit', threadId: 't', id: 'q1', content: 'new text' });
    expect(
      parseThreadClientFrame(
        JSON.stringify({ op: 'queue_edit', threadId: 't', id: 'q1', content: 'x', reqId: '' }),
      ),
    ).toBeNull();
    expect(
      parseThreadClientFrame(
        JSON.stringify({ op: 'queue_edit', threadId: 't', id: 'q1', content: 'x', reqId: 7 }),
      ),
    ).toBeNull();
  });

  test('queue_hold requires threadId, id, and a boolean held', () => {
    expect(
      parseThreadClientFrame(
        JSON.stringify({ op: 'queue_hold', threadId: 't', id: 'q1', held: true }),
      ),
    ).toMatchObject({ op: 'queue_hold', threadId: 't', id: 'q1', held: true });
    expect(
      parseThreadClientFrame(
        JSON.stringify({ op: 'queue_hold', threadId: 't', id: 'q1', held: false }),
      ),
    ).toMatchObject({ op: 'queue_hold', held: false });
    expect(
      parseThreadClientFrame(JSON.stringify({ op: 'queue_hold', threadId: 't', id: 'q1' })),
    ).toBeNull();
    // A truthy string is the shape a hand-rolled client sends; it is not a hold.
    expect(
      parseThreadClientFrame(
        JSON.stringify({ op: 'queue_hold', threadId: 't', id: 'q1', held: 'true' }),
      ),
    ).toBeNull();
    expect(
      parseThreadClientFrame(JSON.stringify({ op: 'queue_hold', threadId: 't', held: true })),
    ).toBeNull();
    expect(
      parseThreadClientFrame(JSON.stringify({ op: 'queue_hold', id: 'q1', held: true })),
    ).toBeNull();
  });

  test('queue_remove requires threadId and id', () => {
    expect(
      parseThreadClientFrame(JSON.stringify({ op: 'queue_remove', threadId: 't', id: 'q1' })),
    ).toMatchObject({ op: 'queue_remove', threadId: 't', id: 'q1' });
    expect(
      parseThreadClientFrame(JSON.stringify({ op: 'queue_remove', threadId: 't' })),
    ).toBeNull();
    expect(parseThreadClientFrame(JSON.stringify({ op: 'queue_remove', id: 'q1' }))).toBeNull();
  });

  test('permission_response validates the outcome union', () => {
    expect(
      parseThreadClientFrame(
        JSON.stringify({
          op: 'permission_response',
          threadId: 't',
          requestId: 'p',
          outcome: { kind: 'selected', optionId: 'allow' },
        }),
      ),
    ).toMatchObject({ op: 'permission_response' });
    expect(
      parseThreadClientFrame(
        JSON.stringify({
          op: 'permission_response',
          threadId: 't',
          requestId: 'p',
          outcome: { kind: 'cancelled' },
        }),
      ),
    ).toMatchObject({ outcome: { kind: 'cancelled' } });
    expect(
      parseThreadClientFrame(
        JSON.stringify({
          op: 'permission_response',
          threadId: 't',
          requestId: 'p',
          outcome: { kind: 'selected' },
        }),
      ),
    ).toBeNull();
  });

  test('runtime_consent_response validates the granted/declined outcome', () => {
    expect(
      parseThreadClientFrame(
        JSON.stringify({
          op: 'runtime_consent_response',
          threadId: 't',
          requestId: 'c',
          outcome: { kind: 'granted', remember: true },
        }),
      ),
    ).toMatchObject({
      op: 'runtime_consent_response',
      outcome: { kind: 'granted', remember: true },
    });
    expect(
      parseThreadClientFrame(
        JSON.stringify({
          op: 'runtime_consent_response',
          threadId: 't',
          requestId: 'c',
          outcome: { kind: 'declined' },
        }),
      ),
    ).toMatchObject({ outcome: { kind: 'declined' } });
    // Unknown outcome kind, non-boolean remember, and missing ids all reject.
    expect(
      parseThreadClientFrame(
        JSON.stringify({
          op: 'runtime_consent_response',
          threadId: 't',
          requestId: 'c',
          outcome: { kind: 'maybe' },
        }),
      ),
    ).toBeNull();
    expect(
      parseThreadClientFrame(
        JSON.stringify({
          op: 'runtime_consent_response',
          threadId: 't',
          requestId: 'c',
          outcome: { kind: 'granted', remember: 'yes' },
        }),
      ),
    ).toBeNull();
    expect(
      parseThreadClientFrame(
        JSON.stringify({
          op: 'runtime_consent_response',
          threadId: 't',
          outcome: { kind: 'granted' },
        }),
      ),
    ).toBeNull();
  });

  test('subscribe accepts optional numeric sinceSeq only', () => {
    expect(
      parseThreadClientFrame(JSON.stringify({ op: 'subscribe', threadId: 't', sinceSeq: 4 })),
    ).toMatchObject({ sinceSeq: 4 });
    expect(
      parseThreadClientFrame(JSON.stringify({ op: 'subscribe', threadId: 't', sinceSeq: 'x' })),
    ).toBeNull();
  });

  test('resume requires threadId and reqId; prompt optional but string-typed', () => {
    expect(
      parseThreadClientFrame(JSON.stringify({ op: 'resume', threadId: 't', reqId: 'r' })),
    ).toMatchObject({ op: 'resume', threadId: 't', reqId: 'r' });
    expect(
      parseThreadClientFrame(
        JSON.stringify({ op: 'resume', threadId: 't', reqId: 'r', prompt: 'continue' }),
      ),
    ).toMatchObject({ prompt: 'continue' });
    expect(parseThreadClientFrame(JSON.stringify({ op: 'resume', threadId: 't' }))).toBeNull();
    expect(
      parseThreadClientFrame(
        JSON.stringify({ op: 'resume', threadId: 't', reqId: 'r', prompt: 7 }),
      ),
    ).toBeNull();
  });

  test('retry requires threadId and reqId', () => {
    expect(
      parseThreadClientFrame(JSON.stringify({ op: 'retry', threadId: 't', reqId: 'r' })),
    ).toMatchObject({ op: 'retry', threadId: 't', reqId: 'r' });
    expect(parseThreadClientFrame(JSON.stringify({ op: 'retry', threadId: 't' }))).toBeNull();
    expect(parseThreadClientFrame(JSON.stringify({ op: 'retry', reqId: 'r' }))).toBeNull();
    expect(
      parseThreadClientFrame(JSON.stringify({ op: 'retry', threadId: 't', reqId: '' })),
    ).toBeNull();
  });

  test('authenticate requires threadId, reqId and methodId', () => {
    expect(
      parseThreadClientFrame(
        JSON.stringify({ op: 'authenticate', threadId: 't', reqId: 'r', methodId: 'm' }),
      ),
    ).toMatchObject({ op: 'authenticate', threadId: 't', reqId: 'r', methodId: 'm' });
    expect(
      parseThreadClientFrame(JSON.stringify({ op: 'authenticate', threadId: 't', reqId: 'r' })),
    ).toBeNull();
    expect(
      parseThreadClientFrame(JSON.stringify({ op: 'authenticate', reqId: 'r', methodId: 'm' })),
    ).toBeNull();
    expect(
      parseThreadClientFrame(JSON.stringify({ op: 'authenticate', threadId: 't', methodId: 'm' })),
    ).toBeNull();
    expect(
      parseThreadClientFrame(
        JSON.stringify({ op: 'authenticate', threadId: 't', reqId: 'r', methodId: '' }),
      ),
    ).toBeNull();
    expect(
      parseThreadClientFrame(
        JSON.stringify({ op: 'authenticate', threadId: 't', reqId: 'r', methodId: 7 }),
      ),
    ).toBeNull();
  });

  test('rename requires threadId and a non-empty title', () => {
    expect(
      parseThreadClientFrame(JSON.stringify({ op: 'rename', threadId: 't', title: 'New name' })),
    ).toMatchObject({ op: 'rename', threadId: 't', title: 'New name' });
    expect(parseThreadClientFrame(JSON.stringify({ op: 'rename', threadId: 't' }))).toBeNull();
    expect(
      parseThreadClientFrame(JSON.stringify({ op: 'rename', threadId: 't', title: '' })),
    ).toBeNull();
    expect(parseThreadClientFrame(JSON.stringify({ op: 'rename', title: 'x' }))).toBeNull();
  });

  test('delete requires threadId', () => {
    expect(parseThreadClientFrame(JSON.stringify({ op: 'delete', threadId: 't' }))).toMatchObject({
      op: 'delete',
      threadId: 't',
    });
    expect(parseThreadClientFrame(JSON.stringify({ op: 'delete' }))).toBeNull();
  });

  test('set_config_option carries a string valueId or a boolean toggle', () => {
    expect(
      parseThreadClientFrame(
        JSON.stringify({
          op: 'set_config_option',
          threadId: 't',
          configId: 'model',
          value: 'opus',
        }),
      ),
    ).toMatchObject({ op: 'set_config_option', configId: 'model', value: 'opus' });
    expect(
      parseThreadClientFrame(
        JSON.stringify({ op: 'set_config_option', threadId: 't', configId: 'web', value: true }),
      ),
    ).toMatchObject({ value: true });
    expect(
      parseThreadClientFrame(
        JSON.stringify({ op: 'set_config_option', threadId: 't', configId: 'model', value: 3 }),
      ),
    ).toBeNull();
    expect(
      parseThreadClientFrame(
        JSON.stringify({ op: 'set_config_option', threadId: 't', configId: 'model', value: '' }),
      ),
    ).toBeNull();
    expect(
      parseThreadClientFrame(
        JSON.stringify({ op: 'set_config_option', threadId: 't', value: 'opus' }),
      ),
    ).toBeNull();
  });
});

describe('parseThreadClientFrame create settings', () => {
  const base = { op: 'create', reqId: 'r', agent: { source: 'registry', id: 'x' } };

  test('accepts a create with a config settings map', () => {
    expect(
      parseThreadClientFrame(
        JSON.stringify({ ...base, settings: { config: { model: 'opus', verbose: true } } }),
      ),
    ).toMatchObject({ op: 'create', settings: { config: { model: 'opus', verbose: true } } });
  });

  test('accepts a create with no settings (settings is optional)', () => {
    expect(parseThreadClientFrame(JSON.stringify(base))).toMatchObject({ op: 'create' });
  });

  test('rejects non-object settings', () => {
    expect(parseThreadClientFrame(JSON.stringify({ ...base, settings: 'x' }))).toBeNull();
  });

  test('rejects a config that is not a plain object', () => {
    expect(
      parseThreadClientFrame(JSON.stringify({ ...base, settings: { config: [] } })),
    ).toBeNull();
  });

  test('rejects non-primitive config values', () => {
    expect(
      parseThreadClientFrame(
        JSON.stringify({ ...base, settings: { config: { model: { nested: 1 } } } }),
      ),
    ).toBeNull();
  });

  test('accepts a string modeId in settings', () => {
    expect(
      parseThreadClientFrame(JSON.stringify({ ...base, settings: { modeId: 'bypass' } })),
    ).toMatchObject({ op: 'create', settings: { modeId: 'bypass' } });
  });

  test('accepts config and modeId together', () => {
    expect(
      parseThreadClientFrame(
        JSON.stringify({ ...base, settings: { config: { model: 'opus' }, modeId: 'plan' } }),
      ),
    ).toMatchObject({ op: 'create', settings: { config: { model: 'opus' }, modeId: 'plan' } });
  });

  test('rejects a non-string modeId', () => {
    expect(
      parseThreadClientFrame(JSON.stringify({ ...base, settings: { modeId: 42 } })),
    ).toBeNull();
  });
});
