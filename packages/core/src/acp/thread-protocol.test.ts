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
