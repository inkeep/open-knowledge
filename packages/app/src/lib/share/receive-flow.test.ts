import { describe, expect, test } from 'bun:test';

import type {
  OkShareReceivedPayload,
  ShareFolderValidationResult,
} from '@/lib/desktop-bridge-types';

import {
  buildCloneUrl,
  formatCloneErrorMessage,
  formatReceiveLog,
  mapValidationToToast,
  presentReceiveError,
} from './receive-flow';

describe('formatCloneErrorMessage', () => {
  test('private/missing repo: drops the progress preamble + fatal URL line, keeps the remote message', () => {
    const stderr = [
      "Cloning into '/Users/me/Documents/sharing-repo'...",
      'remote: Repository not found.',
      "fatal: repository 'https://github.com/me/sharing-repo.git/' not found",
    ].join('\n');
    expect(formatCloneErrorMessage(stderr)).toBe('Repository not found.');
  });

  test('strips the local path from the message (no leak of the recipient filesystem path)', () => {
    const stderr = [
      "Cloning into '/Users/me/Documents/sharing-repo'...",
      'remote: Repository not found.',
    ].join('\n');
    const result = formatCloneErrorMessage(stderr);
    expect(result).not.toContain('/Users/me');
    expect(result).not.toMatch(/Cloning into/i);
  });

  test('auth failure: surfaces the remote line over the fatal line', () => {
    const stderr = [
      'remote: Invalid username or password.',
      "fatal: Authentication failed for 'https://github.com/me/x.git/'",
    ].join('\n');
    expect(formatCloneErrorMessage(stderr)).toBe('Invalid username or password.');
  });

  test('partial-progress failure: picks the last remote line (diagnostic), not a progress line', () => {
    const stderr = [
      "Cloning into '/tmp/r'...",
      'remote: Enumerating objects: 100% (50/50), done.',
      'remote: Repository not found.',
    ].join('\n');
    expect(formatCloneErrorMessage(stderr)).toBe('Repository not found.');
  });

  test('falls back to the fatal line (prefix stripped) when there is no remote line', () => {
    expect(formatCloneErrorMessage('fatal: could not read Username for https://github.com')).toBe(
      'could not read Username for https://github.com',
    );
  });

  test('non-git controller message passes through unchanged', () => {
    expect(formatCloneErrorMessage('Clone ended unexpectedly.')).toBe('Clone ended unexpectedly.');
  });

  test('only-preamble or empty input yields an empty string (caller omits the line)', () => {
    expect(formatCloneErrorMessage("Cloning into '/tmp/x'...")).toBe('');
    expect(formatCloneErrorMessage('   \n  ')).toBe('');
  });
});

describe('buildCloneUrl', () => {
  test('matches the canonical .git form (the clone wizard accepts both forms equally)', () => {
    expect(buildCloneUrl({ owner: 'inkeep', repo: 'open-knowledge' })).toBe(
      'https://github.com/inkeep/open-knowledge.git',
    );
  });
});

describe('mapValidationToToast', () => {
  const expected = { owner: 'inkeep', repo: 'open-knowledge' };

  function withKind<K extends ShareFolderValidationResult['kind']>(
    kind: K,
    extras: Partial<ShareFolderValidationResult> = {},
  ): ShareFolderValidationResult {
    if (kind === 'ok') {
      return { kind: 'ok', gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git' };
    }
    if (kind === 'wrong-repo') {
      return {
        kind: 'wrong-repo',
        actualOwner: extras && 'actualOwner' in extras ? (extras.actualOwner ?? 'a') : 'a',
        actualRepo: extras && 'actualRepo' in extras ? (extras.actualRepo ?? 'b') : 'b',
      };
    }
    return { kind } as ShareFolderValidationResult;
  }

  test('returns null on ok (no toast — caller proceeds)', () => {
    expect(mapValidationToToast(withKind('ok'), expected)).toBeNull();
  });

  test('not-git surfaces the not-a-git-repo prompt', () => {
    expect(mapValidationToToast(withKind('not-git'), expected)).toBe(
      "This folder doesn't contain a git repository. Pick a different folder?",
    );
  });

  test('wrong-repo surfaces the actual vs expected owner/repo per the spec AC', () => {
    const result = withKind('wrong-repo', { actualOwner: 'forky', actualRepo: 'spoon' });
    expect(mapValidationToToast(result, expected)).toBe(
      'This folder is a clone of forky/spoon, not inkeep/open-knowledge. Pick a different folder?',
    );
  });

  test('non-github + symlink-escape + no-origin all surface the wrong-repo generic prompt (Q-A9 v1 simplification)', () => {
    expect(mapValidationToToast(withKind('non-github'), expected)).toBe(
      "This folder isn't a clone of inkeep/open-knowledge. Pick a different folder?",
    );
    expect(mapValidationToToast(withKind('symlink-escape'), expected)).toBe(
      "This folder isn't a clone of inkeep/open-knowledge. Pick a different folder?",
    );
    expect(mapValidationToToast(withKind('no-origin'), expected)).toBe(
      "This folder isn't a clone of inkeep/open-knowledge. Pick a different folder?",
    );
  });
});

describe('presentReceiveError', () => {
  test('launcher-miss payload returns null (caller proceeds to the Q2 surface)', () => {
    const payload: OkShareReceivedPayload = {
      kind: 'launcher-miss',
      share: {
        owner: 'a',
        repo: 'b',
        branch: 'main',
        path: 'README.md',
        blobUrl: 'https://github.com/a/b/blob/main/README.md',
      },
    };
    expect(presentReceiveError(payload)).toBeNull();
  });

  test('launcher-consent payload returns null (caller proceeds to the consent surface)', () => {
    const payload: OkShareReceivedPayload = {
      kind: 'launcher-consent',
      share: {
        owner: 'a',
        repo: 'b',
        branch: 'feat/x',
        path: 'README.md',
        blobUrl: 'https://github.com/a/b/blob/feat/x/README.md',
      },
      candidatePath: '/some/worktree',
      parentProjectName: null,
    };
    expect(presentReceiveError(payload)).toBeNull();
  });

  test('unsupported-version payload returns the update prompt', () => {
    expect(presentReceiveError({ kind: 'unsupported-version' })).toEqual({
      kind: 'unsupported-version',
      message: 'Update OpenKnowledge to open this share.',
    });
  });

  test('invalid payload returns the invalid prompt', () => {
    expect(presentReceiveError({ kind: 'invalid' })).toEqual({
      kind: 'invalid',
      message: 'Invalid share URL.',
    });
  });
});

describe('formatReceiveLog', () => {
  test('emits the bracket-prefix shape with whichever fields are set', () => {
    expect(formatReceiveLog({ q2_path: 'clone' })).toBe('[receive] q2_path=clone');
    expect(formatReceiveLog({ q2_path: 'local' })).toBe('[receive] q2_path=local');
    expect(formatReceiveLog({ folder_validate: 'wrong-repo' })).toBe(
      '[receive] folder_validate=wrong-repo',
    );
    expect(formatReceiveLog({ q2_path: 'local', folder_validate: 'ok' })).toBe(
      '[receive] q2_path=local folder_validate=ok',
    );
  });

  test('emits just the prefix with no fields', () => {
    expect(formatReceiveLog({})).toBe('[receive]');
  });

  test('emits branch_action and branch fields when set', () => {
    expect(formatReceiveLog({ branch_action: 'fallback', branch: 'feat/foo' })).toBe(
      '[receive] branch_action=fallback branch=feat/foo',
    );
  });

  test('branch_action without branch is still well-formed', () => {
    expect(formatReceiveLog({ branch_action: 'cancel' })).toBe('[receive] branch_action=cancel');
  });

  test('emits branch_dialog_action for the branch-switch dialog telemetry', () => {
    expect(
      formatReceiveLog({ branch_dialog_action: 'branch-switch-complete', branch: 'feat/x' }),
    ).toBe('[receive] branch=feat/x branch_dialog_action=branch-switch-complete');
  });

  test('emits the worktree-leg action and its reason-suffixed failure variants', () => {
    expect(formatReceiveLog({ branch_dialog_action: 'open-worktree', branch: 'feat/x' })).toBe(
      '[receive] branch=feat/x branch_dialog_action=open-worktree',
    );
    expect(
      formatReceiveLog({
        branch_dialog_action: 'open-worktree-failed:fetch-failed',
        branch: 'feat/x',
      }),
    ).toBe('[receive] branch=feat/x branch_dialog_action=open-worktree-failed:fetch-failed');
    expect(
      formatReceiveLog({ branch_dialog_action: 'open-worktree-failed:branch-not-found' }),
    ).toBe('[receive] branch_dialog_action=open-worktree-failed:branch-not-found');
  });

  test('emits verdict_cell so verdict-cell renders are countable', () => {
    expect(formatReceiveLog({ verdict_cell: 'on-origin', branch: 'feat/x' })).toBe(
      '[receive] branch=feat/x verdict_cell=on-origin',
    );
    expect(formatReceiveLog({ verdict_cell: 'never-on-branch' })).toBe(
      '[receive] verdict_cell=never-on-branch',
    );
  });

  test('a verdict-cell action is countable via the branch_dialog_action + verdict_cell pair', () => {
    expect(
      formatReceiveLog({
        branch_dialog_action: 'switch',
        branch: 'feat/x',
        verdict_cell: 'renamed',
      }),
    ).toBe('[receive] branch=feat/x branch_dialog_action=switch verdict_cell=renamed');
  });
});
