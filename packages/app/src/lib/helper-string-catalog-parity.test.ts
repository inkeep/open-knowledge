import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  errorToastMessage,
  MAX_DISPATCH_ATTEMPTS,
  retryActionLabel,
} from '@/components/handoff/useHandoffDispatch';
import { formatContainerAriaLabel } from '@/editor/utils/editor-strings';
import { deriveShareReceiveToast } from '@/lib/install-deep-link-listener';
import { presentPublishError, resolveNameCheckStatus } from '@/lib/share/publish-wizard';
import { mapValidationToToast, presentReceiveError } from '@/lib/share/receive-flow';
import { mapShareErrorToToast } from '@/lib/share/run-share-action';

const LOCALES_DIR = join(import.meta.dir, '..', 'locales', 'en');

const MIGRATED_MODULES: ReadonlyArray<readonly [path: string, messages: number]> = [
  ['src/lib/share/run-share-action.ts', 11],
  ['src/lib/share/receive-flow.ts', 6],
  ['src/lib/share/publish-wizard.ts', 7],
  ['src/hooks/use-folder-config.ts', 2],
  ['src/lib/install-onboarding-toast.ts', 8],
  ['src/lib/install-deep-link-listener.ts', 1],
  ['src/components/handoff/useHandoffDispatch.ts', 7],
  ['src/editor/utils/editor-strings.ts', 2],
  ['src/editor/components/IconPickerInput.tsx', 4],
  ['src/editor/components/ColorPickerInput.tsx', 2],
  ['src/editor/components/SrcAutocomplete.tsx', 1],
];

const messageIds = new Set<string>();
const originCounts = new Map<string, number>();

function unescapePo(value: string): string {
  return value.replace(/\\(["\\ntr])/g, (_, ch: string) =>
    ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === 'r' ? '\r' : ch,
  );
}

beforeAll(() => {
  for (const line of readFileSync(join(LOCALES_DIR, 'messages.po'), 'utf8').split('\n')) {
    if (line.startsWith('#: ')) {
      for (const ref of line.slice(3).trim().split(/\s+/)) {
        originCounts.set(ref, (originCounts.get(ref) ?? 0) + 1);
      }
      continue;
    }
    const id = /^msgid "(.*)"$/.exec(line);
    if (id?.[1]) messageIds.add(unescapePo(id[1]));
  }
  expect(messageIds.size).toBeGreaterThan(2000);
});

describe('every migrated helper module contributes its messages to the catalog', () => {
  for (const [path, messages] of MIGRATED_MODULES) {
    it(`${path} contributes ${messages}`, () => {
      expect(originCounts.get(path) ?? 0).toBe(messages);
    });
  }
});

describe('helper messages round-trip to a catalog id with named placeholders', () => {
  const cases: ReadonlyArray<readonly [name: string, produce: () => string]> = [
    ['share error: detached head', () => mapShareErrorToToast('detached-head')],
    [
      'share error: unpushed branch',
      () => mapShareErrorToToast('branch-not-on-origin', '{branch}'),
    ],
    ['share error: no branch name', () => mapShareErrorToToast('branch-not-on-origin')],
    ['share error: non-GitHub remote', () => mapShareErrorToToast('non-github-remote')],
    ['share error: unshareable path', () => mapShareErrorToToast('invalid-path')],
    ['share error: unsupported share URL', () => mapShareErrorToToast('unsupported-share-url')],
    ['share error: no remote', () => mapShareErrorToToast('no-remote')],
    [
      'receive: folder is not a repository',
      () =>
        mapValidationToToast(
          { kind: 'not-git' },
          { owner: '{expectedOwner}', repo: '{expectedRepo}', host: '{expectedHost}' },
        ) ?? '',
    ],
    [
      'receive: folder clones the wrong repository',
      () =>
        mapValidationToToast(
          { kind: 'wrong-repo', actualOwner: '{actualOwner}', actualRepo: '{actualRepo}' },
          { owner: '{expectedOwner}', repo: '{expectedRepo}', host: '{expectedHost}' },
        ) ?? '',
    ],
    [
      'receive: folder clones from the wrong host',
      () =>
        mapValidationToToast(
          { kind: 'wrong-host', actualHost: '{actualHost}' },
          { owner: '{expectedOwner}', repo: '{expectedRepo}', host: '{expectedHost}' },
        ) ?? '',
    ],
    [
      'receive: folder clones nothing recognizable',
      () =>
        mapValidationToToast(
          { kind: 'no-origin' },
          { owner: '{expectedOwner}', repo: '{expectedRepo}', host: '{expectedHost}' },
        ) ?? '',
    ],
    [
      'receive: share needs a newer build',
      () => presentReceiveError({ kind: 'unsupported-version' })?.message ?? '',
    ],
    [
      'receive: share URL is unparseable',
      () => presentReceiveError({ kind: 'invalid' })?.message ?? '',
    ],
    [
      'publish: repository name taken',
      () => presentPublishError('name-conflict', '{owner}', '{name}').banner,
    ],
    [
      'publish: organization needs SSO authorization',
      () => presentPublishError('saml-sso', '{owner}', '{name}').banner,
    ],
    [
      'publish: repository created but push failed',
      () => presentPublishError('push-failed', '{owner}', '{name}').banner,
    ],
    [
      'publish: GitHub connection expired',
      () => presentPublishError('auth-required', '{owner}', '{name}').banner,
    ],
    [
      'publish: project could not be prepared',
      () => presentPublishError('init-failed', '{owner}', '{name}').banner,
    ],
    [
      'publish: GitHub unreachable',
      () => presentPublishError('network', '{owner}', '{name}').banner,
    ],
    [
      'publish: no project open',
      () => presentPublishError('no-project', '{owner}', '{name}').banner,
    ],
    [
      'publish: name check could not authenticate',
      () => {
        const status = resolveNameCheckStatus(
          { ok: false, error: 'auth-required' },
          '{owner}',
          '{name}',
        );
        return status.kind === 'error' ? status.banner : '';
      },
    ],
    [
      'deep link: opened on a named branch',
      () =>
        deriveShareReceiveToast(
          { doc: 'readme', branch: '{branch}', multiCandidate: true },
          '/projects/demo',
        )?.message ?? '',
    ],
    ['handoff: first failure', () => errorToastMessage('{displayName}', 1)],
    [
      'handoff: penultimate failure',
      () => errorToastMessage('{displayName}', MAX_DISPATCH_ATTEMPTS - 1),
    ],
    ['handoff: final failure', () => errorToastMessage('{displayName}', MAX_DISPATCH_ATTEMPTS)],
    ['handoff: retry label', () => retryActionLabel(1) ?? ''],
    ['handoff: last-retry label', () => retryActionLabel(MAX_DISPATCH_ATTEMPTS - 1) ?? ''],
    [
      'editor: empty container label',
      () => formatContainerAriaLabel('{componentLabel}', undefined, 0),
    ],
  ];

  for (const [name, produce] of cases) {
    it(name, () => {
      expect(messageIds.has(produce())).toBe(true);
    });
  }
});
