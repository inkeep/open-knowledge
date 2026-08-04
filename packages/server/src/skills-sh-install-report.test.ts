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

  // A rejected report (unknown-skill 4xx while a fresh listing indexes, a
  // collector 5xx) is DELIVERED but not counted. Unlike a dropped send, that
  // outcome is unambiguous, so the claim is released and a later run reports it
  // again — otherwise the installs a rename is measured by are discarded during
  // the exact window the collector is meeting every new name for the first time.
  test('a non-2xx collector response releases the claim so a later run retries', async () => {
    const home = freshHome();
    const rejecting = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    // Nothing was counted, so nothing is reported back to the caller.
    await expect(
      reportSkillInstall(
        { source: 'o/r', skills: ['x'] },
        { home, ...ENABLED, fetchImpl: rejecting },
      ),
    ).resolves.toEqual([]);
    // The claim is gone, so the next run sends it again.
    const { calls, impl } = recordingFetch();
    await expect(
      reportSkillInstall({ source: 'o/r', skills: ['x'] }, { home, ...ENABLED, fetchImpl: impl }),
    ).resolves.toEqual(['x']);
    expect(calls).toHaveLength(1);
  });

  // The counterpart contract: an AMBIGUOUS failure keeps its claim. A dropped
  // request may have reached the collector and had only its response lost, so
  // retrying could inflate someone's public install count. Under-count once
  // rather than double-count.
  test('a dropped send keeps its claim and is never retried', async () => {
    const home = freshHome();
    const dropping = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await reportSkillInstall(
      { source: 'o/r', skills: ['x'] },
      { home, ...ENABLED, fetchImpl: dropping },
    );
    const { calls, impl } = recordingFetch();
    await reportSkillInstall(
      { source: 'o/r', skills: ['x'] },
      { home, ...ENABLED, fetchImpl: impl },
    );
    expect(calls).toEqual([]);
  });

  // The collector is a serverless function behind an edge: a 5xx or 429 can be
  // synthesized AFTER the origin recorded the event, so it is ambiguous exactly
  // like a dropped send. Only an application-level rejection proves nothing was
  // counted and is therefore safe to retry.
  test('a 503 keeps its claim; a 404 releases it', async () => {
    const statusFetch = (status: number) =>
      (async () => ({ ok: false, status })) as unknown as typeof fetch;

    const ambiguous = freshHome();
    await reportSkillInstall(
      { source: 'o/r', skills: ['x'] },
      { home: ambiguous, ...ENABLED, fetchImpl: statusFetch(503) },
    );
    const after503 = recordingFetch();
    await reportSkillInstall(
      { source: 'o/r', skills: ['x'] },
      { home: ambiguous, ...ENABLED, fetchImpl: after503.impl },
    );
    expect(after503.calls).toEqual([]);

    const rejected = freshHome();
    await reportSkillInstall(
      { source: 'o/r', skills: ['x'] },
      { home: rejected, ...ENABLED, fetchImpl: statusFetch(404) },
    );
    const after404 = recordingFetch();
    await reportSkillInstall(
      { source: 'o/r', skills: ['x'] },
      { home: rejected, ...ENABLED, fetchImpl: after404.impl },
    );
    expect(after404.calls).toHaveLength(1);
  });
});

describe('reportSkillInstall — scope', () => {
  // THE privacy assertion. The changeset promises the project path "is used only
  // as a local key and is never sent". Nothing else stops a future edit to the
  // params builder from shipping a user's home-directory path to the collector.
  test('the project path never reaches the request', async () => {
    const { calls, impl } = recordingFetch();
    await reportSkillInstall(
      { source: 'o/r', skills: ['x'], scope: '/Users/someone/private-project' },
      { home: freshHome(), ...ENABLED, fetchImpl: impl },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('private-project');
    expect(calls[0]).not.toContain('/Users/');
    expect(calls[0]).not.toContain('scope');
  });

  test('the same scope twice reports once', async () => {
    const home = freshHome();
    const first = recordingFetch();
    await reportSkillInstall(
      { source: 'o/r', skills: ['x'], scope: '/p/one' },
      { home, ...ENABLED, fetchImpl: first.impl },
    );
    expect(first.calls).toHaveLength(1);
    const second = recordingFetch();
    await reportSkillInstall(
      { source: 'o/r', skills: ['x'], scope: '/p/one' },
      { home, ...ENABLED, fetchImpl: second.impl },
    );
    expect(second.calls).toEqual([]);
  });

  test('a different scope reports again — a second project is a second install', async () => {
    const home = freshHome();
    await reportSkillInstall(
      { source: 'o/r', skills: ['x'], scope: '/p/one' },
      { home, ...ENABLED, fetchImpl: recordingFetch().impl },
    );
    const other = recordingFetch();
    await reportSkillInstall(
      { source: 'o/r', skills: ['x'], scope: '/p/two' },
      { home, ...ENABLED, fetchImpl: other.impl },
    );
    expect(other.calls).toHaveLength(1);
  });

  // Machine-wide and project-scoped keys must not collide: the built-in bundles
  // are reported unscoped, and a project install of the same name is a separate
  // event, not a duplicate of it.
  test('a scoped key is independent of the unscoped one', async () => {
    const home = freshHome();
    await reportSkillInstall(
      { source: 'o/r', skills: ['x'] },
      { home, ...ENABLED, fetchImpl: recordingFetch().impl },
    );
    const scoped = recordingFetch();
    await reportSkillInstall(
      { source: 'o/r', skills: ['x'], scope: '/p/one' },
      { home, ...ENABLED, fetchImpl: scoped.impl },
    );
    expect(scoped.calls).toHaveLength(1);
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
