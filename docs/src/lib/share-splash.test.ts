import { describe, expect, test } from 'bun:test';
import { encodeShareUrl } from '@inkeep/open-knowledge-core';
import { STABLE_DMG_URL } from './download-links.ts';
import {
  buildCloneCommand,
  buildCustomSchemeUrl,
  buildShareDescription,
  buildSplashViewModel,
  classifySplashOs,
  clipboardCopyOutcome,
  SPLASH_DOWNLOAD_URL,
  SPLASH_INSTALL_COMMAND,
  splashCtaLayout,
} from './share-splash.ts';
import { SITE_NAME } from './site.ts';

/**
 * Encode a shared GitHub URL (a blob URL for a doc, a tree URL for a folder)
 * via the CANONICAL production encoder (`@inkeep/open-knowledge-core`
 * `encodeShareUrl`). The splash duplicates the decoder locally to avoid
 * pulling the CRDT dep tree into the static marketing build — producer/consumer
 * parity is what we want to guarantee, so the happy-path tests MUST drive the
 * same encoder a real sender uses. If the encoder bumps to v2, these tests fail
 * loud against the splash decoder staying on v1, which is exactly the
 * regression we want to catch.
 *
 * `encodeShareUrl` returns just the base64url payload — what the splash
 * route receives as the `[encoded]` path segment.
 */
function encodeV1(sharedUrl: string): string {
  return encodeShareUrl(sharedUrl);
}

/**
 * Hand-rolled base64url for the NEGATIVE-path tests below — needed only
 * for forging v2-shaped payloads or other malformed bytes that the
 * production encoder can't be coaxed into emitting. Never used on the
 * happy path.
 */
function uint8ArrayToBase64Url(bytes: Uint8Array): string {
  let binaryString = '';
  for (let i = 0; i < bytes.length; i++) {
    binaryString += String.fromCharCode(bytes[i]);
  }
  return btoa(binaryString).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('buildSplashViewModel', () => {
  test('decodes a happy-path encoded blob URL into the ok view', () => {
    const blobUrl = 'https://github.com/inkeep/playbooks/blob/main/marketing-playbook.md';
    const encoded = encodeV1(blobUrl);

    const view = buildSplashViewModel(encoded);

    expect(view).toEqual({
      kind: 'ok',
      target: 'doc',
      filename: 'marketing-playbook.md',
      owner: 'inkeep',
      repo: 'playbooks',
      repoPath: 'inkeep/playbooks',
      branch: 'main',
      isDefaultBranch: true,
      sharedUrl: blobUrl,
      customSchemeUrl: `openknowledge://share?url=${encodeURIComponent(blobUrl)}`,
      githubUrl: blobUrl,
    });
  });

  test('decodes a folder (tree) share URL into a valid ok view with target=folder', () => {
    const treeUrl = 'https://github.com/inkeep/playbooks/tree/main/marketing/campaigns';
    const encoded = encodeV1(treeUrl);

    const view = buildSplashViewModel(encoded);

    expect(view).toEqual({
      kind: 'ok',
      target: 'folder',
      filename: 'campaigns',
      owner: 'inkeep',
      repo: 'playbooks',
      repoPath: 'inkeep/playbooks',
      branch: 'main',
      isDefaultBranch: true,
      sharedUrl: treeUrl,
      customSchemeUrl: `openknowledge://share?url=${encodeURIComponent(treeUrl)}`,
      githubUrl: treeUrl,
    });
  });

  test('uses the path basename as the filename on a nested doc share', () => {
    const blobUrl = 'https://github.com/inkeep/playbooks/blob/main/docs/architecture/auth.md';
    const view = buildSplashViewModel(encodeV1(blobUrl));
    expect(view.kind).toBe('ok');
    if (view.kind === 'ok') {
      expect(view.filename).toBe('auth.md');
    }
  });

  test('falls back to the repo name as filename for a root-folder (repo/branch root) share', () => {
    const treeUrl = 'https://github.com/inkeep/playbooks/tree/main';
    const view = buildSplashViewModel(encodeV1(treeUrl));
    expect(view.kind).toBe('ok');
    if (view.kind === 'ok') {
      expect(view.filename).toBe('playbooks');
    }
  });

  test('decodes a repo/branch-root folder (empty tree path) and falls back to the repo name', () => {
    const treeUrl = 'https://github.com/inkeep/playbooks/tree/main';
    const view = buildSplashViewModel(encodeV1(treeUrl));
    expect(view.kind).toBe('ok');
    if (view.kind === 'ok') {
      expect(view.target).toBe('folder');
      expect(view.filename).toBe('playbooks');
      expect(view.repoPath).toBe('inkeep/playbooks');
      expect(view.sharedUrl).toBe(treeUrl);
    }
  });

  test('tolerates a trailing slash on a root-folder tree URL', () => {
    const treeUrl = 'https://github.com/inkeep/playbooks/tree/main/';
    const view = buildSplashViewModel(encodeV1(treeUrl));
    expect(view.kind).toBe('ok');
    if (view.kind === 'ok') {
      expect(view.target).toBe('folder');
      expect(view.filename).toBe('playbooks');
    }
  });

  test('decodes a folder share on a percent-encoded slash-bearing branch', () => {
    const treeUrl = 'https://github.com/inkeep/playbooks/tree/feat%2Fshare/docs/sub';
    const view = buildSplashViewModel(encodeV1(treeUrl));
    expect(view.kind).toBe('ok');
    if (view.kind === 'ok') {
      expect(view.target).toBe('folder');
      expect(view.branch).toBe('feat/share');
      expect(view.filename).toBe('sub');
      expect(view.isDefaultBranch).toBe(false);
    }
  });

  test('preserves the filename VERBATIM — no title-case, no extension stripping (D29)', () => {
    const cases: Array<{ blobUrl: string; expectedFilename: string }> = [
      {
        blobUrl: 'https://github.com/o/r/blob/main/OnboardingGuide.md',
        expectedFilename: 'OnboardingGuide.md',
      },
      {
        blobUrl: 'https://github.com/o/r/blob/main/q4-okrs.md',
        expectedFilename: 'q4-okrs.md',
      },
      {
        blobUrl: 'https://github.com/o/r/blob/main/marketing-playbook.md',
        expectedFilename: 'marketing-playbook.md',
      },
    ];

    for (const { blobUrl, expectedFilename } of cases) {
      const view = buildSplashViewModel(encodeV1(blobUrl));
      expect(view.kind).toBe('ok');
      if (view.kind === 'ok') {
        expect(view.filename).toBe(expectedFilename);
      }
    }
  });

  test('decodes a nested doc path and renders the basename as filename', () => {
    const blobUrl = 'https://github.com/inkeep/playbooks/blob/main/docs/sub/page.md';
    const view = buildSplashViewModel(encodeV1(blobUrl));
    expect(view.kind).toBe('ok');
    if (view.kind === 'ok') {
      expect(view.filename).toBe('page.md');
    }
  });

  test('decodes a URL-encoded filename with spaces + em-dash + unicode', () => {
    const blobUrl =
      'https://github.com/inkeep/playbooks/blob/main/docs/Q4%20OKRs%20%E2%80%94%20Marketing.md';
    const view = buildSplashViewModel(encodeV1(blobUrl));
    expect(view.kind).toBe('ok');
    if (view.kind === 'ok') {
      expect(view.filename).toBe('Q4 OKRs — Marketing.md');
    }
  });

  test('flags a non-default branch (FR25 branch indicator path)', () => {
    const blobUrl = 'https://github.com/inkeep/playbooks/blob/feat-x/notes.md';
    const view = buildSplashViewModel(encodeV1(blobUrl));
    expect(view.kind).toBe('ok');
    if (view.kind === 'ok') {
      expect(view.branch).toBe('feat-x');
      expect(view.isDefaultBranch).toBe(false);
    }
  });

  test('flags `master` as a default branch (suppresses indicator)', () => {
    const blobUrl = 'https://github.com/o/r/blob/master/file.md';
    const view = buildSplashViewModel(encodeV1(blobUrl));
    expect(view.kind).toBe('ok');
    if (view.kind === 'ok') {
      expect(view.isDefaultBranch).toBe(true);
    }
  });

  test('decodes a percent-encoded slash-bearing branch as a single branch token', () => {
    const blobUrl = 'https://github.com/inkeep/playbooks/blob/feat%2Fshare/file.md';
    const view = buildSplashViewModel(encodeV1(blobUrl));
    expect(view.kind).toBe('ok');
    if (view.kind === 'ok') {
      expect(view.branch).toBe('feat/share');
      expect(view.filename).toBe('file.md');
      expect(view.isDefaultBranch).toBe(false);
    }
  });

  test('returns `unsupported-version` for a v2-shaped payload', () => {
    const blobBytes = new TextEncoder().encode('https://github.com/o/r/blob/main/file.md');
    const v2 = new Uint8Array([0x02, ...blobBytes]);
    const encoded = uint8ArrayToBase64Url(v2);
    const view = buildSplashViewModel(encoded);
    expect(view).toEqual({ kind: 'unsupported-version', version: 2 });
  });

  test('returns `invalid` for undecodable base64url input', () => {
    expect(buildSplashViewModel('not!valid!base64!!!')).toEqual({ kind: 'invalid' });
  });

  test('returns `invalid` for an empty encoded string', () => {
    expect(buildSplashViewModel('')).toEqual({ kind: 'invalid' });
  });

  test('returns `invalid` when the decoded URL is non-github', () => {
    const blobUrl = 'https://gitlab.com/owner/repo/blob/main/README.md';
    const view = buildSplashViewModel(encodeV1(blobUrl));
    expect(view).toEqual({ kind: 'invalid' });
  });

  test('returns `invalid` when the decoded URL is neither a /blob/ nor /tree/ URL', () => {
    const view = buildSplashViewModel(
      encodeV1('https://github.com/owner/repo/commits/main/README.md'),
    );
    expect(view).toEqual({ kind: 'invalid' });
  });

  test('returns `invalid` when the github URL is missing a path', () => {
    const view = buildSplashViewModel(encodeV1('https://github.com/owner/repo/blob/main'));
    expect(view).toEqual({ kind: 'invalid' });
  });

  test('returns `invalid` for a github-spoofed hostname', () => {
    const view = buildSplashViewModel(
      encodeV1('https://github.com.evil.example/owner/repo/blob/main/README.md'),
    );
    expect(view).toEqual({ kind: 'invalid' });
  });

  test('tolerates trailing query parameters on the encoded URL (Axis 1 per D30)', () => {
    const blobUrl = 'https://github.com/o/r/blob/main/file.md';
    const encoded = `${encodeV1(blobUrl)}?utm_source=slack&ref=campaign`;
    const view = buildSplashViewModel(encoded);
    expect(view.kind).toBe('ok');
    if (view.kind === 'ok') {
      expect(view.sharedUrl).toBe(blobUrl);
    }
  });

  test('tolerates a trailing fragment on the encoded URL (Axis 2 per D30)', () => {
    const blobUrl = 'https://github.com/o/r/blob/main/file.md';
    const encoded = `${encodeV1(blobUrl)}#section-2`;
    const view = buildSplashViewModel(encoded);
    expect(view.kind).toBe('ok');
    if (view.kind === 'ok') {
      expect(view.sharedUrl).toBe(blobUrl);
    }
  });
});

describe('buildSplashViewModel — shell-injection guard', () => {
  // The decoded owner/repo/branch flow into a copyable `ok clone …` command.
  // Two layers guard it: the decode boundary rejects structurally-invalid refs
  // (whitespace, control chars, `:`, leading `-`, non-GitHub owner/repo), and
  // `buildCloneCommand` POSIX-single-quotes anything else, so a shell-unsafe but
  // valid git ref (e.g. `feat;x`) is inert in the rendered command rather than
  // over-rejected. A crafted URL thus either decodes to `invalid` or renders quoted.
  test('rejects a branch carrying a shell command separator', () => {
    const url = 'https://github.com/inkeep/playbooks/blob/main%3Bcurl%20evil.sh%7Csh/readme.md';
    expect(buildSplashViewModel(encodeV1(url)).kind).toBe('invalid');
  });

  test('rejects a branch carrying a command substitution', () => {
    const url = 'https://github.com/inkeep/playbooks/blob/%24(rm%20-rf%20~)/readme.md';
    expect(buildSplashViewModel(encodeV1(url)).kind).toBe('invalid');
  });

  test('rejects a branch carrying a newline', () => {
    const url = 'https://github.com/inkeep/playbooks/blob/a%0Acurl%20evil/readme.md';
    expect(buildSplashViewModel(encodeV1(url)).kind).toBe('invalid');
  });

  test('rejects an owner carrying a shell metacharacter', () => {
    const url = 'https://github.com/o%3Bevil/playbooks/blob/main/readme.md';
    expect(buildSplashViewModel(encodeV1(url)).kind).toBe('invalid');
  });

  test('rejects a repo carrying a backtick', () => {
    const url = 'https://github.com/inkeep/re%60id%60po/blob/main/readme.md';
    expect(buildSplashViewModel(encodeV1(url)).kind).toBe('invalid');
  });

  test('rejects a leading-dash branch (option injection into ok clone)', () => {
    const url = 'https://github.com/inkeep/playbooks/blob/-rf/readme.md';
    expect(buildSplashViewModel(encodeV1(url)).kind).toBe('invalid');
  });

  test('rejects the same injection on a tree (folder) share', () => {
    const url = 'https://github.com/inkeep/playbooks/tree/main%3Bcurl%20evil';
    expect(buildSplashViewModel(encodeV1(url)).kind).toBe('invalid');
  });

  test('still accepts a legitimate slash-bearing branch (not over-rejecting)', () => {
    const url = 'https://github.com/inkeep/playbooks/blob/release%2F1.2.3/readme.md';
    const view = buildSplashViewModel(encodeV1(url));
    expect(view.kind).toBe('ok');
    if (view.kind === 'ok') {
      expect(view.branch).toBe('release/1.2.3');
      expect(buildCloneCommand(view)).toBe('ok clone inkeep/playbooks -b release/1.2.3');
    }
  });

  test('accepts a valid ref outside the old allowlist (release+candidate) — no over-rejection', () => {
    const url = 'https://github.com/inkeep/playbooks/blob/release%2Bcandidate/readme.md';
    const view = buildSplashViewModel(encodeV1(url));
    expect(view.kind).toBe('ok');
    if (view.kind === 'ok') {
      expect(view.branch).toBe('release+candidate');
      // `+` is shell-safe, so the command renders it unquoted.
      expect(buildCloneCommand(view)).toBe('ok clone inkeep/playbooks -b release+candidate');
    }
  });

  test('accepts a shell-unsafe but valid ref and quotes it at render', () => {
    // `feat;x` is a valid git ref (no whitespace / `:` / control) but shell-unsafe;
    // the decode boundary accepts it and buildCloneCommand single-quotes it.
    const url = 'https://github.com/inkeep/playbooks/blob/feat%3Bx/readme.md';
    const view = buildSplashViewModel(encodeV1(url));
    expect(view.kind).toBe('ok');
    if (view.kind === 'ok') {
      expect(view.branch).toBe('feat;x');
      expect(buildCloneCommand(view)).toBe("ok clone inkeep/playbooks -b 'feat;x'");
    }
  });

  test('still rejects a `:` refspec-injection branch (would rewrite local refs)', () => {
    const url = 'https://github.com/inkeep/playbooks/blob/HEAD%3Arefs%2Fheads%2Fevil/readme.md';
    expect(buildSplashViewModel(encodeV1(url)).kind).toBe('invalid');
  });

  test('rejects `..` owner/repo segments (encoded) — no `ok clone ../..` rendering', () => {
    // Percent-encoded so the URL parser does not normalize the `..` away; the
    // segments decode to `..`, which real GitHub names never are.
    const url = 'https://github.com/%2E%2E/%2E%2E/blob/main/readme.md';
    expect(buildSplashViewModel(encodeV1(url)).kind).toBe('invalid');
  });
});

describe('buildCustomSchemeUrl', () => {
  test('produces the openknowledge://share?url=... custom-scheme handoff URL', () => {
    const blobUrl = 'https://github.com/o/r/blob/main/file with space.md';
    expect(buildCustomSchemeUrl(blobUrl)).toBe(
      `openknowledge://share?url=${encodeURIComponent(blobUrl)}`,
    );
  });
});

describe('SPLASH_DOWNLOAD_URL', () => {
  test('points at the open-knowledge releases latest DMG asset', () => {
    expect(SPLASH_DOWNLOAD_URL).toBe(STABLE_DMG_URL);
  });
});

describe('SPLASH_INSTALL_COMMAND', () => {
  test('is the published CLI install command (global npm install)', () => {
    expect(SPLASH_INSTALL_COMMAND).toBe('npm install -g @inkeep/open-knowledge');
  });
});

describe('buildCloneCommand', () => {
  test('emits `ok clone <owner>/<repo> -b <branch>` using owner/repo shorthand', () => {
    expect(buildCloneCommand({ owner: 'inkeep', repo: 'playbooks', branch: 'main' })).toBe(
      'ok clone inkeep/playbooks -b main',
    );
  });

  test('always emits -b on a default branch (main) — CLI default-fallback covers a deleted ref', () => {
    expect(buildCloneCommand({ owner: 'o', repo: 'r', branch: 'main' })).toBe(
      'ok clone o/r -b main',
    );
  });

  test('always emits -b on master', () => {
    expect(buildCloneCommand({ owner: 'o', repo: 'r', branch: 'master' })).toBe(
      'ok clone o/r -b master',
    );
  });

  test('always emits -b on a feature branch', () => {
    expect(buildCloneCommand({ owner: 'inkeep', repo: 'playbooks', branch: 'feat-x' })).toBe(
      'ok clone inkeep/playbooks -b feat-x',
    );
  });

  test('preserves a slash-bearing branch name verbatim (off-argv, not a URL)', () => {
    expect(buildCloneCommand({ owner: 'o', repo: 'r', branch: 'feat/share' })).toBe(
      'ok clone o/r -b feat/share',
    );
  });

  test('contains no `ok auth login` line — auth surfaces at clone-failure time', () => {
    const cmd = buildCloneCommand({ owner: 'o', repo: 'r', branch: 'main' });
    expect(cmd).not.toContain('ok auth login');
  });

  test('POSIX-single-quotes a shell-unsafe but valid ref so the pasted command is inert', () => {
    expect(buildCloneCommand({ owner: 'o', repo: 'r', branch: 'feat;x' })).toBe(
      "ok clone o/r -b 'feat;x'",
    );
  });

  test('renders a `+`-bearing ref unquoted (release+candidate)', () => {
    expect(buildCloneCommand({ owner: 'o', repo: 'r', branch: 'release+candidate' })).toBe(
      'ok clone o/r -b release+candidate',
    );
  });

  test('POSIX-single-quotes a branch containing a literal single quote', () => {
    // The copy-local shellSingleQuoteShareArg must escape the one byte single
    // quotes can't carry: close, escaped literal quote, reopen ('…'\''…').
    expect(buildCloneCommand({ owner: 'o', repo: 'r', branch: "feat'x" })).toBe(
      "ok clone o/r -b 'feat'\\''x'",
    );
  });
});

describe('classifySplashOs', () => {
  test('returns `unknown` for null / undefined / empty', () => {
    expect(classifySplashOs(null)).toBe('unknown');
    expect(classifySplashOs(undefined)).toBe('unknown');
    expect(classifySplashOs('')).toBe('unknown');
  });

  test('classifies userAgentData.platform values', () => {
    expect(classifySplashOs('macOS')).toBe('macos');
    expect(classifySplashOs('Linux')).toBe('linux');
    expect(classifySplashOs('Windows')).toBe('windows');
    expect(classifySplashOs('Chrome OS')).toBe('linux');
    expect(classifySplashOs('iOS')).toBe('unknown');
    expect(classifySplashOs('Android')).toBe('unknown');
    expect(classifySplashOs('Unknown')).toBe('unknown');
  });

  test('classifies macOS desktop UA strings', () => {
    expect(
      classifySplashOs(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      ),
    ).toBe('macos');
    expect(
      classifySplashOs(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ),
    ).toBe('macos');
  });

  test('classifies Linux X11 UA strings', () => {
    expect(
      classifySplashOs(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ),
    ).toBe('linux');
    expect(
      classifySplashOs(
        'Mozilla/5.0 (X11; Fedora; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0',
      ),
    ).toBe('linux');
  });

  test('classifies Windows UA strings', () => {
    expect(
      classifySplashOs(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ),
    ).toBe('windows');
    expect(
      classifySplashOs('Mozilla/5.0 (Windows NT 10.0; rv:120.0) Gecko/20100101 Firefox/120.0'),
    ).toBe('windows');
  });

  test('classifies iPhone / iPad UAs as unknown (the trailing "Mac OS X" is a decoy)', () => {
    expect(
      classifySplashOs(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('unknown');
    expect(
      classifySplashOs(
        'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('unknown');
  });

  test('classifies Android UAs as unknown (the leading "Linux" is a decoy)', () => {
    expect(
      classifySplashOs(
        'Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe('unknown');
  });

  test('never reports architecture — frozen Intel-vs-AS UA still classifies as macos', () => {
    expect(
      classifySplashOs(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
      ),
    ).toBe('macos');
  });
});

describe('splashCtaLayout', () => {
  test('macOS and unknown render the cluster floor with the CLI in a disclosure', () => {
    for (const os of ['macos', 'unknown'] as const) {
      expect(splashCtaLayout(os)).toEqual({
        showWindowsNotice: false,
        showCluster: true,
        cliInline: false,
        showStandaloneGithub: false,
      });
    }
  });

  test('Linux promotes the CLI inline, drops the cluster, and keeps a standalone GitHub link', () => {
    expect(splashCtaLayout('linux')).toEqual({
      showWindowsNotice: false,
      showCluster: false,
      cliInline: true,
      showStandaloneGithub: true,
    });
  });

  test('Windows shows the not-supported notice only', () => {
    expect(splashCtaLayout('windows')).toEqual({
      showWindowsNotice: true,
      showCluster: false,
      cliInline: false,
      showStandaloneGithub: false,
    });
  });

  test('every OS keeps a path to GitHub (regression guard for the Linux-drop bug)', () => {
    for (const os of ['macos', 'linux', 'windows', 'unknown'] as const) {
      const l = splashCtaLayout(os);
      expect(l.showWindowsNotice || l.showCluster || l.showStandaloneGithub).toBe(true);
    }
  });
});

describe('clipboardCopyOutcome', () => {
  test('maps success to the `copied` branch', () => {
    expect(clipboardCopyOutcome(true)).toEqual({ kind: 'copied' });
  });

  test('maps failure to the `fallback-select` branch (never a silent no-op)', () => {
    expect(clipboardCopyOutcome(false)).toEqual({ kind: 'fallback-select' });
  });
});

describe('buildShareDescription', () => {
  // Drive the production encoder so the view passed to buildShareDescription is
  // exactly what the route would hand it.
  function okView(sharedUrl: string) {
    const view = buildSplashViewModel(encodeV1(sharedUrl));
    if (view.kind !== 'ok') throw new Error(`expected ok view, got ${view.kind}`);
    return view;
  }

  test('doc on the default branch — names the document + repo, no branch suffix', () => {
    const d = buildShareDescription(
      okView('https://github.com/inkeep/tech-ipos/blob/main/README.md'),
    );
    expect(d).toBe(`Open README.md with ${SITE_NAME} — a shared document from inkeep/tech-ipos.`);
  });

  test('doc on a non-default branch — appends "(on <branch>)"', () => {
    const d = buildShareDescription(
      okView('https://github.com/inkeep/tech-ipos/blob/draft-q4/README.md'),
    );
    expect(d).toBe(
      `Open README.md with ${SITE_NAME} — a shared document from inkeep/tech-ipos (on draft-q4).`,
    );
  });

  test('folder on the default branch — uses "folder" noun', () => {
    const d = buildShareDescription(
      okView('https://github.com/inkeep/open-knowledge/tree/main/docs'),
    );
    expect(d).toBe(`Open docs with ${SITE_NAME} — a shared folder from inkeep/open-knowledge.`);
  });

  test('folder on a non-default branch — folder noun + branch suffix', () => {
    const d = buildShareDescription(
      okView('https://github.com/inkeep/open-knowledge/tree/feature/docs'),
    );
    expect(d).toBe(
      `Open docs with ${SITE_NAME} — a shared folder from inkeep/open-knowledge (on feature).`,
    );
  });

  test('always carries the action phrase and the product name', () => {
    const d = buildShareDescription(
      okView('https://github.com/inkeep/tech-ipos/blob/main/README.md'),
    );
    expect(d).toContain(`with ${SITE_NAME}`);
    expect(d.startsWith('Open ')).toBe(true);
  });
});
