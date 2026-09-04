import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { commentStates } from '../../../../test-support/strip-comments.test-helper.mjs';
import { TYPED_IPC_MIGRATION_CHANNEL_CAP } from '../../src/shared/ipc-channels.ts';

const SRC_PATH = join(__dirname, '..', '..', 'src', 'shared', 'ipc-channels.ts');
const CHANNELS_SRC = readFileSync(SRC_PATH, 'utf-8');
const CHANNEL_STATES = commentStates(CHANNELS_SRC, { path: SRC_PATH });
const DECLARED_CAP_RE = /export const TYPED_IPC_MIGRATION_CHANNEL_CAP\s*=\s*(\d+)/;

const REQUEST_CHANNEL_CAP = 95;

function extractInterfaceBody(src: string, interfaceName: string): string {
  const re = new RegExp(`(^|\\n)export\\s+interface\\s+${interfaceName}\\s*\\{`);
  const match = re.exec(src);
  if (!match) {
    throw new Error(`ipc-channel-count-ratchet: ${interfaceName} interface not found`);
  }
  const open = match.index + match[0].length - 1;
  let depth = 1;
  let cursor = open + 1;
  while (cursor < src.length && depth > 0) {
    const ch = src[cursor];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, cursor);
    }
    cursor += 1;
  }
  throw new Error(`ipc-channel-count-ratchet: unbalanced braces in ${interfaceName}`);
}

const CHANNEL_KEY_RE = /^\s*'(ok:[^']+)'\s*:\s*\{/gm;

function countChannelKeys(body: string): number {
  CHANNEL_KEY_RE.lastIndex = 0;
  let count = 0;
  while (CHANNEL_KEY_RE.exec(body) !== null) count += 1;
  return count;
}

describe('IPC channel count ratchet — RequestChannels', () => {
  test(`RequestChannels has at most ${REQUEST_CHANNEL_CAP} hand-rolled entries`, () => {
    for (const [state, source] of CHANNEL_STATES) {
      const body = extractInterfaceBody(source, 'RequestChannels');
      const count = countChannelKeys(body);
      if (count > REQUEST_CHANNEL_CAP) {
        throw new Error(
          [
            `IPC channel count exceeded committed cap of ${REQUEST_CHANNEL_CAP} (${state}).`,
            `Current count: ${count}.`,
            '',
            'The hand-rolled IPC discriminated union is past its scale-match trigger.',
            `Adding a ${REQUEST_CHANNEL_CAP + 1}th channel must coincide with the typed-ipc migration —`,
            'either land the migration spec first, or fold the new payload into an existing',
            'channel via additive optional fields (the `ok:theme:applied` precedent).',
            '',
            'If the migration has landed: update REQUEST_CHANNEL_CAP in this file AND',
            'TYPED_IPC_MIGRATION_CHANNEL_CAP in src/shared/ipc-channels.ts — the two-surface',
            'edit is what makes the bump deliberate.',
          ].join('\n'),
        );
      }
      expect(count, state).toBeLessThanOrEqual(REQUEST_CHANNEL_CAP);
    }
  });

  test('the channel-key regex actually matches entries (positive regression)', () => {
    for (const [state, source] of CHANNEL_STATES) {
      const body = extractInterfaceBody(source, 'RequestChannels');
      expect(countChannelKeys(body), state).toBeGreaterThan(0);
    }
  });

  test('the source declares the typed-ipc migration cap, and it agrees with the ratchet', () => {
    for (const [state, source] of CHANNEL_STATES) {
      const declared = DECLARED_CAP_RE.exec(source);
      expect(declared, state).not.toBeNull();
      expect(Number(declared?.[1]), state).toBe(TYPED_IPC_MIGRATION_CHANNEL_CAP);
    }
    expect(TYPED_IPC_MIGRATION_CHANNEL_CAP).toBe(REQUEST_CHANNEL_CAP);
  });
});
