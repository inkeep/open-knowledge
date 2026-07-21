import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { resolveGhBinaryPath, runGhDeviceLoginSubprocess } from './gh-login.ts';
import type { AuthEvent } from './types.ts';

// A fake `gh` that emits the real device-flow stderr lines, then exits with
// $FAKE_GH_EXIT (default 0). Trailing args are ignored.
const dir = mkdtempSync(join(tmpdir(), 'gh-login-test-'));
const fakeGh = join(dir, 'gh');
writeFileSync(
  fakeGh,
  `#!/bin/bash
# The post-login username lookup ("gh api ... user --jq .login") prints the login.
if [ "$1" = "api" ]; then echo "octocat"; exit 0; fi
echo "! First copy your one-time code: TEST-1234" >&2
echo "Open this URL to continue in your web browser: https://ghes.test/login/device" >&2
exit \${FAKE_GH_EXIT:-0}
`,
);
chmodSync(fakeGh, 0o755);

async function collect(exitCode: string): Promise<AuthEvent[]> {
  process.env.FAKE_GH_EXIT = exitCode;
  const events: AuthEvent[] = [];
  const ctl = runGhDeviceLoginSubprocess({
    host: 'ghes.test',
    ghPath: fakeGh,
    onEvent: (e) => events.push(e),
  });
  await ctl.done;
  delete process.env.FAKE_GH_EXIT;
  return events;
}

describe('runGhDeviceLoginSubprocess', () => {
  test('parses gh output into a verification event, then complete on exit 0', async () => {
    const events = await collect('0');
    expect(events).toEqual([
      {
        type: 'verification',
        user_code: 'TEST-1234',
        verification_uri: 'https://ghes.test/login/device',
        expires_in: 900,
      },
      { type: 'complete', host: 'ghes.test', login: 'octocat' },
    ]);
  });

  test('emits a bounded error on non-zero exit (still surfaces the code first)', async () => {
    const events = await collect('1');
    expect(events[0]?.type).toBe('verification');
    const terminal = events[events.length - 1];
    expect(terminal?.type).toBe('error');
    if (terminal?.type === 'error') expect(terminal.message).toContain('gh sign-in failed');
  });

  test('unrecognizable stderr trips the verification deadline with a single actionable error', async () => {
    // A fake gh whose stderr never matches CODE_RE/URL_RE (format change or an
    // early failure) and that would otherwise run far past the deadline.
    const stallGh = join(dir, 'gh-stall');
    writeFileSync(
      stallGh,
      `#!/bin/bash
echo "unexpected output format" >&2
# exec + /dev/null stdio: SIGTERM from cancel() hits sleep itself, and no
# orphan holds the stdio pipes open past the kill (close fires promptly).
exec sleep 60 1>/dev/null 2>/dev/null
`,
    );
    chmodSync(stallGh, 0o755);
    const events: AuthEvent[] = [];
    const ctl = runGhDeviceLoginSubprocess({
      host: 'ghes.test',
      ghPath: stallGh,
      verificationDeadlineMs: 300,
      onEvent: (e) => events.push(e),
    });
    await ctl.done;
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    if (events[0]?.type === 'error') {
      expect(events[0].message).toContain('personal access token');
    }
  });
});

describe('resolveGhBinaryPath', () => {
  test('returns the first candidate whose --version succeeds (falls back past a missing PATH gh)', async () => {
    const path = await resolveGhBinaryPath({
      _exec: async (cmd: string) => {
        if (cmd === 'gh') throw new Error('not on PATH');
        return '';
      },
      _fileExists: (p: string) => p === '/opt/homebrew/bin/gh',
    });
    expect(path).toBe('/opt/homebrew/bin/gh');
  });

  test('returns null when gh is nowhere', async () => {
    const path = await resolveGhBinaryPath({
      _exec: async () => {
        throw new Error('nope');
      },
      _fileExists: () => false,
    });
    expect(path).toBeNull();
  });
});
