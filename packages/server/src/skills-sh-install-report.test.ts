/**
 * The reporter's job is to send ONE event per genuine install. Most of these
 * tests are about when it must stay silent — the launch reclaim runs on every
 * desktop start, so a reporter that fires per call would turn an install count
 * into a launch count.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { reportSkillInstall } from './skills-sh-install-report.ts';

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'ok-install-report-'));
}

/** Records every URL it is called with; always succeeds. */
function recordingFetch(): { calls: string[]; impl: typeof fetch } {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    return { ok: true, status: 200 };
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const ENABLED = { enabled: true, env: {} as NodeJS.ProcessEnv };

describe('reportSkillInstall', () => {
  test('sends one install event carrying source, skills and agents', async () => {
    const { calls, impl } = recordingFetch();
    const reported = await reportSkillInstall(
      {
        source: 'inkeep/open-knowledge-skills',
        skills: ['open-knowledge-discovery'],
        agents: ['claude', 'codex'],
        global: true,
        version: '9.9.9',
      },
      { home: freshHome(), ...ENABLED, fetchImpl: impl },
    );
    expect(reported).toEqual(['open-knowledge-discovery']);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0] as string);
    expect(url.origin + url.pathname).toBe('https://add-skill.vercel.sh/t');
    expect(url.searchParams.get('event')).toBe('install');
    expect(url.searchParams.get('source')).toBe('inkeep/open-knowledge-skills');
    expect(url.searchParams.get('skills')).toBe('open-knowledge-discovery');
    expect(url.searchParams.get('agents')).toBe('claude,codex');
    expect(url.searchParams.get('global')).toBe('1');
    expect(url.searchParams.get('v')).toBe('9.9.9');
  });

  // The rule that makes the number mean "installs" rather than "launches".
  test('reports a given skill only once per machine', async () => {
    const home = freshHome();
    const { calls, impl } = recordingFetch();
    const report = { source: 'inkeep/open-knowledge-skills', skills: ['open-knowledge-discovery'] };
    await reportSkillInstall(report, { home, ...ENABLED, fetchImpl: impl });
    await reportSkillInstall(report, { home, ...ENABLED, fetchImpl: impl });
    await reportSkillInstall(report, { home, ...ENABLED, fetchImpl: impl });
    expect(calls).toHaveLength(1);
  });

  test('reports only the skills not already reported', async () => {
    const home = freshHome();
    const { calls, impl } = recordingFetch();
    const source = 'inkeep/open-knowledge-skills';
    await reportSkillInstall({ source, skills: ['a'] }, { home, ...ENABLED, fetchImpl: impl });
    await reportSkillInstall({ source, skills: ['a', 'b'] }, { home, ...ENABLED, fetchImpl: impl });
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1] as string).searchParams.get('skills')).toBe('b');
  });

  // The ledger entry is claimed BEFORE the send and never un-claimed. Nothing
  // awaits this call, so a process exiting mid-flight would otherwise leave the
  // entry unwritten and re-report the same install next run — inflating a
  // public count. A dropped send costs one uncounted install instead.
  test('a failed send is not retried on the next run', async () => {
    const home = freshHome();
    const failing = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await reportSkillInstall(
      { source: 'o/r', skills: ['x'] },
      { home, ...ENABLED, fetchImpl: failing },
    );
    const { calls, impl } = recordingFetch();
    await reportSkillInstall(
      { source: 'o/r', skills: ['x'] },
      { home, ...ENABLED, fetchImpl: impl },
    );
    expect(calls).toEqual([]);
  });

  // If the claim cannot be written there is nothing on disk to suppress the
  // next run, so sending anyway would produce the duplicate the claim-first
  // ordering exists to prevent.
  test('does not send when the ledger claim cannot be written', async () => {
    const home = freshHome();
    // A directory where the state file belongs: every write to it fails.
    mkdirSync(join(home, '.ok', 'skill-state.yml'), { recursive: true });
    const { calls, impl } = recordingFetch();
    const reported = await reportSkillInstall(
      { source: 'o/r', skills: ['x'] },
      { home, ...ENABLED, fetchImpl: impl },
    );
    expect(reported).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('resolves rather than rejecting when the network throws', async () => {
    const failing = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(
      reportSkillInstall(
        { source: 'o/r', skills: ['x'] },
        { home: freshHome(), ...ENABLED, fetchImpl: failing },
      ),
    ).resolves.toEqual(['x']);
  });
});

describe('reportSkillInstall — stays silent', () => {
  test('when the setting is off', async () => {
    const { calls, impl } = recordingFetch();
    await reportSkillInstall(
      { source: 'o/r', skills: ['x'] },
      { home: freshHome(), enabled: false, env: {}, fetchImpl: impl },
    );
    expect(calls).toEqual([]);
  });

  test.each([['DO_NOT_TRACK'], ['DISABLE_TELEMETRY']])('when %s is set', async (name) => {
    const { calls, impl } = recordingFetch();
    await reportSkillInstall(
      { source: 'o/r', skills: ['x'] },
      { home: freshHome(), enabled: true, env: { [name]: '1' }, fetchImpl: impl },
    );
    expect(calls).toEqual([]);
  });

  // A private repo's name, and a local path, are the user's information. The
  // upstream CLI gates its own event on a repo-privacy probe for the same
  // reason; refusing anything that isn't a plain `owner/repo` is the blunt
  // version of that and errs toward saying nothing.
  test.each([
    ['a local absolute path', '/Users/someone/private-skills'],
    ['a relative path', './local'],
    ['a git URL', 'git@github.com:acme/secret.git'],
    ['an https URL', 'https://github.com/acme/secret'],
    ['a bare name', 'not-a-repo'],
    ['a bare local dir that looks host-ish', 'my-skills'],
  ])('for %s', async (_label, source) => {
    const { calls, impl } = recordingFetch();
    await reportSkillInstall(
      { source, skills: ['x'] },
      { home: freshHome(), ...ENABLED, fetchImpl: impl },
    );
    expect(calls).toEqual([]);
  });

  // An internal hostname is not a marketplace publisher, and the NAME itself is
  // the sensitive part — it describes a network the collector has no business
  // knowing about.
  // Reserved TLD position only. A private label in the MIDDLE
  // (`foo.corp.example.com`) is an ordinary public name and stays reportable —
  // widening to "contains" would refuse legitimate publishers.
  test.each([
    ['skills.corp'],
    ['wiki.internal'],
    ['host.local'],
    ['box.lan'],
    ['thing.home.arpa'],
    ['dev.localhost'],
  ])('for the internal hostname %s', async (source) => {
    const { calls, impl } = recordingFetch();
    await reportSkillInstall(
      { source, skills: ['x'] },
      { home: freshHome(), ...ENABLED, fetchImpl: impl },
    );
    expect(calls).toEqual([]);
  });

  // A website catalog is the other shape skills.sh indexes (`open.feishu.cn`),
  // so it reports — the dot is what separates it from a bare local dir name.
  test('but a website-catalog hostname IS reported', async () => {
    const { calls, impl } = recordingFetch();
    await reportSkillInstall(
      { source: 'open.feishu.cn', skills: ['lark-attendance'] },
      { home: freshHome(), ...ENABLED, fetchImpl: impl },
    );
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0] as string).searchParams.get('source')).toBe('open.feishu.cn');
  });
});
