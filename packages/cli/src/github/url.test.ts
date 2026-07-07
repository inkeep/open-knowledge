import { describe, expect, test } from 'bun:test';
import { parseGitHubBlobUrl, parseGitHubShareUrl, parseGitHubTreeUrl, parseGitUrl } from './url.ts';

describe('parseGitUrl', () => {
  describe('https:// URLs', () => {
    test('basic https URL', () => {
      const result = parseGitUrl('https://github.com/owner/repo');
      expect(result).toEqual({
        protocol: 'https',
        hostname: 'github.com',
        owner: 'owner',
        name: 'repo',
      });
    });

    test('https URL with .git suffix', () => {
      const result = parseGitUrl('https://github.com/owner/repo.git');
      expect(result).toEqual({
        protocol: 'https',
        hostname: 'github.com',
        owner: 'owner',
        name: 'repo',
      });
    });

    test('https URL with trailing slash', () => {
      const result = parseGitUrl('https://github.com/owner/repo/');
      expect(result).toEqual({
        protocol: 'https',
        hostname: 'github.com',
        owner: 'owner',
        name: 'repo',
      });
    });

    test('https URL with port number', () => {
      const result = parseGitUrl('https://github.example.com:8443/owner/repo');
      expect(result).toEqual({
        protocol: 'https',
        hostname: 'github.example.com',
        owner: 'owner',
        name: 'repo',
      });
    });

    test('http URL (treated as https)', () => {
      const result = parseGitUrl('http://github.com/owner/repo');
      expect(result).toEqual({
        protocol: 'https',
        hostname: 'github.com',
        owner: 'owner',
        name: 'repo',
      });
    });

    test('GHES https URL', () => {
      const result = parseGitUrl('https://company.ghe.com/owner/repo');
      expect(result).toEqual({
        protocol: 'https',
        hostname: 'company.ghe.com',
        owner: 'owner',
        name: 'repo',
      });
    });

    test('hyphenated owner and repo', () => {
      const result = parseGitUrl('https://github.com/my-org/my-repo');
      expect(result).toEqual({
        protocol: 'https',
        hostname: 'github.com',
        owner: 'my-org',
        name: 'my-repo',
      });
    });

    test('repo with dots', () => {
      const result = parseGitUrl('https://github.com/owner/repo.name');
      expect(result).toEqual({
        protocol: 'https',
        hostname: 'github.com',
        owner: 'owner',
        name: 'repo.name',
      });
    });
  });

  describe('SCP-style SSH (git@host:owner/repo)', () => {
    test('standard git@ SSH', () => {
      const result = parseGitUrl('git@github.com:owner/repo');
      expect(result).toEqual({
        protocol: 'ssh',
        hostname: 'github.com',
        owner: 'owner',
        name: 'repo',
      });
    });

    test('git@ SSH with .git suffix', () => {
      const result = parseGitUrl('git@github.com:owner/repo.git');
      expect(result).toEqual({
        protocol: 'ssh',
        hostname: 'github.com',
        owner: 'owner',
        name: 'repo',
      });
    });

    test('GHES SCP-style SSH (*.ghe.com)', () => {
      const result = parseGitUrl('git@company.ghe.com:owner/repo');
      expect(result).toEqual({
        protocol: 'ssh',
        hostname: 'company.ghe.com',
        owner: 'owner',
        name: 'repo',
      });
    });

    test('GHES SCP-style with .git', () => {
      const result = parseGitUrl('git@acme.ghe.com:acme-org/my-docs.git');
      expect(result).toEqual({
        protocol: 'ssh',
        hostname: 'acme.ghe.com',
        owner: 'acme-org',
        name: 'my-docs',
      });
    });
  });

  describe('ssh:// URLs', () => {
    test('ssh URL with git@ user', () => {
      const result = parseGitUrl('ssh://git@github.com/owner/repo');
      expect(result).toEqual({
        protocol: 'ssh',
        hostname: 'github.com',
        owner: 'owner',
        name: 'repo',
      });
    });

    test('ssh URL without user', () => {
      const result = parseGitUrl('ssh://github.com/owner/repo');
      expect(result).toEqual({
        protocol: 'ssh',
        hostname: 'github.com',
        owner: 'owner',
        name: 'repo',
      });
    });

    test('ssh URL with .git suffix', () => {
      const result = parseGitUrl('ssh://git@github.com/owner/repo.git');
      expect(result).toEqual({
        protocol: 'ssh',
        hostname: 'github.com',
        owner: 'owner',
        name: 'repo',
      });
    });

    test('ssh URL with port', () => {
      const result = parseGitUrl('ssh://git@github.example.com:22/owner/repo');
      expect(result).toEqual({
        protocol: 'ssh',
        hostname: 'github.example.com',
        owner: 'owner',
        name: 'repo',
      });
    });
  });

  describe('git:// URLs', () => {
    test('git:// URL', () => {
      const result = parseGitUrl('git://github.com/owner/repo');
      expect(result).toEqual({
        protocol: 'git',
        hostname: 'github.com',
        owner: 'owner',
        name: 'repo',
      });
    });

    test('git:// URL with .git suffix', () => {
      const result = parseGitUrl('git://github.com/owner/repo.git');
      expect(result).toEqual({
        protocol: 'git',
        hostname: 'github.com',
        owner: 'owner',
        name: 'repo',
      });
    });
  });

  describe('git: bare protocol (without //)', () => {
    test('git: bare protocol', () => {
      const result = parseGitUrl('git:github.com/owner/repo');
      expect(result).toEqual({
        protocol: 'git',
        hostname: 'github.com',
        owner: 'owner',
        name: 'repo',
      });
    });

    test('git: bare protocol with .git', () => {
      const result = parseGitUrl('git:github.com/owner/repo.git');
      expect(result).toEqual({
        protocol: 'git',
        hostname: 'github.com',
        owner: 'owner',
        name: 'repo',
      });
    });
  });

  describe('owner/repo shorthand', () => {
    test('owner/repo shorthand defaults to github.com', () => {
      const result = parseGitUrl('owner/repo');
      expect(result).toEqual({
        protocol: 'https',
        hostname: 'github.com',
        owner: 'owner',
        name: 'repo',
      });
    });

    test('org with hyphens', () => {
      const result = parseGitUrl('my-company/my-repo');
      expect(result).toEqual({
        protocol: 'https',
        hostname: 'github.com',
        owner: 'my-company',
        name: 'my-repo',
      });
    });

    test('shorthand with .git suffix strips .git', () => {
      const result = parseGitUrl('owner/repo.git');
      expect(result).toEqual({
        protocol: 'https',
        hostname: 'github.com',
        owner: 'owner',
        name: 'repo',
      });
    });

    test('inkeep/open-knowledge shorthand', () => {
      const result = parseGitUrl('inkeep/open-knowledge');
      expect(result).toEqual({
        protocol: 'https',
        hostname: 'github.com',
        owner: 'inkeep',
        name: 'open-knowledge',
      });
    });
  });

  describe('invalid inputs', () => {
    test('empty string returns null', () => {
      expect(parseGitUrl('')).toBeNull();
    });

    test('whitespace-only string returns null', () => {
      expect(parseGitUrl('   ')).toBeNull();
    });

    test('bare hostname returns null', () => {
      expect(parseGitUrl('github.com')).toBeNull();
    });

    test('https URL without owner/repo returns null', () => {
      expect(parseGitUrl('https://github.com')).toBeNull();
    });

    test('https URL with only owner returns null', () => {
      expect(parseGitUrl('https://github.com/owner')).toBeNull();
    });

    test('invalid URL returns null', () => {
      expect(parseGitUrl('not-a-url')).toBeNull();
    });

    test('url with spaces returns null', () => {
      expect(parseGitUrl('https://github.com/owner/re po')).toBeNull();
    });

    test('ftp:// protocol returns null', () => {
      expect(parseGitUrl('ftp://github.com/owner/repo')).toBeNull();
    });
  });
});

describe('parseGitHubBlobUrl', () => {
  test('happy path: simple branch + top-level file', () => {
    const result = parseGitHubBlobUrl(
      'https://github.com/inkeep/open-knowledge/blob/main/README.md',
    );
    expect(result).toEqual({
      owner: 'inkeep',
      repo: 'open-knowledge',
      branch: 'main',
      path: 'README.md',
    });
  });

  test('happy path: nested doc path', () => {
    const result = parseGitHubBlobUrl(
      'https://github.com/inkeep/open-knowledge/blob/feat-x/docs/sub/page.md',
    );
    expect(result).toEqual({
      owner: 'inkeep',
      repo: 'open-knowledge',
      branch: 'feat-x',
      path: 'docs/sub/page.md',
    });
  });

  test('happy path: branch containing slash (percent-encoded)', () => {
    const result = parseGitHubBlobUrl(
      'https://github.com/inkeep/open-knowledge/blob/feat%2Ffoo/docs/page.md',
    );
    expect(result).toEqual({
      owner: 'inkeep',
      repo: 'open-knowledge',
      branch: 'feat/foo',
      path: 'docs/page.md',
    });
  });

  test('happy path: percent-encoded path segments round-trip', () => {
    const result = parseGitHubBlobUrl(
      'https://github.com/owner/repo/blob/main/docs/Q4%20OKRs%20%E2%80%94%20Marketing.md',
    );
    expect(result).toEqual({
      owner: 'owner',
      repo: 'repo',
      branch: 'main',
      path: 'docs/Q4 OKRs — Marketing.md',
    });
  });

  test('happy path: ignores query string and fragment', () => {
    const result = parseGitHubBlobUrl(
      'https://github.com/owner/repo/blob/main/README.md?ref=campaign#L5',
    );
    expect(result).toEqual({
      owner: 'owner',
      repo: 'repo',
      branch: 'main',
      path: 'README.md',
    });
  });

  test('accepts www.github.com host', () => {
    const result = parseGitHubBlobUrl('https://www.github.com/owner/repo/blob/main/README.md');
    expect(result).toEqual({
      owner: 'owner',
      repo: 'repo',
      branch: 'main',
      path: 'README.md',
    });
  });

  test('non-github host returns null', () => {
    expect(parseGitHubBlobUrl('https://gitlab.com/owner/repo/blob/main/README.md')).toBeNull();
  });

  test('subdomain spoofing returns null', () => {
    expect(
      parseGitHubBlobUrl('https://github.com.evil.example/owner/repo/blob/main/README.md'),
    ).toBeNull();
  });

  // REGRESSION PIN: the blob-only parser treats a
  // tree URL as invalid. This simulates a pre-folder client receiving a folder
  // share — it MUST degrade to the "Invalid share URL" path rather than
  // silently mis-parsing. parseGitHubShareUrl (below) is the folder-aware path.
  test('tree (folder) URL returns null from blob-only parser', () => {
    expect(parseGitHubBlobUrl('https://github.com/owner/repo/tree/main/README.md')).toBeNull();
  });

  test('missing branch (path ends after /blob/) returns null', () => {
    expect(parseGitHubBlobUrl('https://github.com/owner/repo/blob/')).toBeNull();
  });

  test('missing doc path (only branch present) returns null', () => {
    expect(parseGitHubBlobUrl('https://github.com/owner/repo/blob/main')).toBeNull();
  });

  test('missing doc path (trailing slash after branch) returns null', () => {
    expect(parseGitHubBlobUrl('https://github.com/owner/repo/blob/main/')).toBeNull();
  });

  test('not a URL returns null', () => {
    expect(parseGitHubBlobUrl('not-a-url')).toBeNull();
  });

  test('empty string returns null', () => {
    expect(parseGitHubBlobUrl('')).toBeNull();
  });

  test('parseGitUrl regex is unaffected (sanity)', () => {
    expect(parseGitUrl('https://github.com/owner/repo')).toEqual({
      protocol: 'https',
      hostname: 'github.com',
      owner: 'owner',
      name: 'repo',
    });
  });

  describe('round-trip with buildGitHubBlobUrl-shape URLs', () => {
    // The server's buildGitHubBlobUrl encodes branch as a single segment
    // (slashes become %2F) and path segments individually (separator preserved).
    // These cases pair build-shape input with parser output to prove the
    // contract on the parser side without crossing a package boundary.
    const cases: Array<{ branch: string; encodedBranch: string }> = [
      { branch: 'main', encodedBranch: 'main' },
      { branch: 'feat/foo', encodedBranch: 'feat%2Ffoo' },
      { branch: 'release/2026-05/foo', encodedBranch: 'release%2F2026-05%2Ffoo' },
      { branch: 'feat#nest', encodedBranch: 'feat%23nest' },
      { branch: 'feat space', encodedBranch: 'feat%20space' },
    ];
    for (const { branch, encodedBranch } of cases) {
      test(`branch "${branch}" round-trips via "${encodedBranch}"`, () => {
        const url = `https://github.com/owner/repo/blob/${encodedBranch}/docs/page.md`;
        const result = parseGitHubBlobUrl(url);
        expect(result).toEqual({
          owner: 'owner',
          repo: 'repo',
          branch,
          path: 'docs/page.md',
        });
      });
    }
  });
});

describe('parseGitHubTreeUrl', () => {
  test('happy path: tree URL with a folder path', () => {
    const result = parseGitHubTreeUrl(
      'https://github.com/inkeep/open-knowledge/tree/main/docs/sub',
    );
    expect(result).toEqual({
      owner: 'inkeep',
      repo: 'open-knowledge',
      branch: 'main',
      path: 'docs/sub',
    });
  });

  test('root folder: tree/<branch> (no path, no trailing slash) -> path ""', () => {
    const result = parseGitHubTreeUrl('https://github.com/owner/repo/tree/main');
    expect(result).toEqual({ owner: 'owner', repo: 'repo', branch: 'main', path: '' });
  });

  test('root folder: tree/<branch>/ (trailing slash) -> path ""', () => {
    const result = parseGitHubTreeUrl('https://github.com/owner/repo/tree/main/');
    expect(result).toEqual({ owner: 'owner', repo: 'repo', branch: 'main', path: '' });
  });

  test('branch containing slash (percent-encoded) round-trips', () => {
    const result = parseGitHubTreeUrl(
      'https://github.com/inkeep/open-knowledge/tree/feat%2Ffoo/docs',
    );
    expect(result).toEqual({
      owner: 'inkeep',
      repo: 'open-knowledge',
      branch: 'feat/foo',
      path: 'docs',
    });
  });

  test('%2F-encoded slashed branch at root round-trips', () => {
    const result = parseGitHubTreeUrl('https://github.com/owner/repo/tree/feat%2Ffoo');
    expect(result).toEqual({ owner: 'owner', repo: 'repo', branch: 'feat/foo', path: '' });
  });

  test('percent-encoded path segments round-trip', () => {
    const result = parseGitHubTreeUrl(
      'https://github.com/owner/repo/tree/main/docs/Q4%20OKRs%20%E2%80%94%20Marketing',
    );
    expect(result).toEqual({
      owner: 'owner',
      repo: 'repo',
      branch: 'main',
      path: 'docs/Q4 OKRs — Marketing',
    });
  });

  test('accepts www.github.com host', () => {
    const result = parseGitHubTreeUrl('https://www.github.com/owner/repo/tree/main/docs');
    expect(result).toEqual({ owner: 'owner', repo: 'repo', branch: 'main', path: 'docs' });
  });

  test('ignores query string and fragment', () => {
    const result = parseGitHubTreeUrl('https://github.com/owner/repo/tree/main/docs?ref=x#frag');
    expect(result).toEqual({ owner: 'owner', repo: 'repo', branch: 'main', path: 'docs' });
  });

  test('blob URL returns null', () => {
    expect(parseGitHubTreeUrl('https://github.com/owner/repo/blob/main/README.md')).toBeNull();
  });

  test('non-github host returns null', () => {
    expect(parseGitHubTreeUrl('https://gitlab.com/owner/repo/tree/main/docs')).toBeNull();
  });

  test('subdomain spoofing returns null', () => {
    expect(
      parseGitHubTreeUrl('https://github.com.evil.example/owner/repo/tree/main/docs'),
    ).toBeNull();
  });

  test('empty intermediate path segment returns null', () => {
    expect(parseGitHubTreeUrl('https://github.com/owner/repo/tree/main/a//b')).toBeNull();
  });

  test('missing branch (path ends after /tree/) returns null', () => {
    expect(parseGitHubTreeUrl('https://github.com/owner/repo/tree/')).toBeNull();
  });

  test('not a URL returns null', () => {
    expect(parseGitHubTreeUrl('not-a-url')).toBeNull();
  });

  test('empty string returns null', () => {
    expect(parseGitHubTreeUrl('')).toBeNull();
  });
});

describe('parseGitHubShareUrl (dispatcher)', () => {
  test('blob URL dispatches to kind:"doc"', () => {
    const result = parseGitHubShareUrl(
      'https://github.com/inkeep/open-knowledge/blob/main/README.md',
    );
    expect(result).toEqual({
      kind: 'doc',
      owner: 'inkeep',
      repo: 'open-knowledge',
      branch: 'main',
      path: 'README.md',
    });
  });

  test('tree URL with path dispatches to kind:"folder"', () => {
    const result = parseGitHubShareUrl('https://github.com/owner/repo/tree/main/docs/sub');
    expect(result).toEqual({
      kind: 'folder',
      owner: 'owner',
      repo: 'repo',
      branch: 'main',
      path: 'docs/sub',
    });
  });

  test('tree root URL dispatches to kind:"folder" with empty path', () => {
    const result = parseGitHubShareUrl('https://github.com/owner/repo/tree/main');
    expect(result).toEqual({
      kind: 'folder',
      owner: 'owner',
      repo: 'repo',
      branch: 'main',
      path: '',
    });
  });

  test('tree root URL with trailing slash dispatches to kind:"folder" with empty path', () => {
    const result = parseGitHubShareUrl('https://github.com/owner/repo/tree/main/');
    expect(result).toEqual({
      kind: 'folder',
      owner: 'owner',
      repo: 'repo',
      branch: 'main',
      path: '',
    });
  });

  test('%2F-encoded slashed branch on a tree URL round-trips', () => {
    const result = parseGitHubShareUrl('https://github.com/owner/repo/tree/feat%2Ffoo/docs');
    expect(result).toEqual({
      kind: 'folder',
      owner: 'owner',
      repo: 'repo',
      branch: 'feat/foo',
      path: 'docs',
    });
  });

  test('non-github / malformed input returns null', () => {
    expect(parseGitHubShareUrl('https://gitlab.com/owner/repo/tree/main/docs')).toBeNull();
    expect(parseGitHubShareUrl('not-a-url')).toBeNull();
    expect(parseGitHubShareUrl('')).toBeNull();
  });
});
