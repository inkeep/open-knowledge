import { describe, expect, test } from 'vitest';
import { gitHubReferenceKey, parseGitHubReferenceUrl } from './reference-target.ts';

const NO_DECLARED = new Set<string>();

describe('parseGitHubReferenceUrl', () => {
  test('reads pull requests and issues on github.com', () => {
    expect(
      parseGitHubReferenceUrl('https://github.com/inkeep/agents/pull/42', NO_DECLARED),
    ).toEqual({
      host: 'github.com',
      owner: 'inkeep',
      repo: 'agents',
      number: 42,
      kind: 'pull',
    });
    expect(
      parseGitHubReferenceUrl('https://www.github.com/inkeep/agents/issues/7/', NO_DECLARED),
    ).toMatchObject({ host: 'github.com', number: 7, kind: 'issues' });
    expect(
      parseGitHubReferenceUrl('https://github.com/inkeep/agents/pull/42/files#diff-1', NO_DECLARED),
    ).toMatchObject({ number: 42, kind: 'pull' });
  });

  test('accepts an enterprise host only when it is declared as GitHub', () => {
    const url = 'https://git.example.com/team/app/pull/3';
    expect(parseGitHubReferenceUrl(url, NO_DECLARED)).toBeNull();
    expect(parseGitHubReferenceUrl(url, new Set(['git.example.com']))).toMatchObject({
      host: 'git.example.com',
      owner: 'team',
      repo: 'app',
      number: 3,
    });
  });

  test('refuses anything that is not a plain https reference', () => {
    for (const url of [
      'http://github.com/inkeep/agents/pull/42',
      'https://user:pass@github.com/inkeep/agents/pull/42',
      'https://github.com:8443/inkeep/agents/pull/42',
      'https://gitlab.com/inkeep/agents/issues/42',
      'https://github.com/inkeep/agents/pulls',
      'https://github.com/inkeep/agents/pull/0',
      'https://github.com/inkeep/../pull/1',
      'https://github.com/inkeep/agents/discussions/42',
      'not a url',
    ]) {
      expect(parseGitHubReferenceUrl(url, NO_DECLARED)).toBeNull();
    }
  });

  test('the cache key ignores case and whether the link said pull or issues', () => {
    const pull = parseGitHubReferenceUrl('https://github.com/Inkeep/Agents/pull/5', NO_DECLARED);
    const issue = parseGitHubReferenceUrl('https://github.com/inkeep/agents/issues/5', NO_DECLARED);
    expect(pull && gitHubReferenceKey(pull)).toBe(issue && gitHubReferenceKey(issue));
  });
});
