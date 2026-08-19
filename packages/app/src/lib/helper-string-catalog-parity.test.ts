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

/**
 * Catalog guard for the user-facing strings emitted by non-component helper
 * modules — the `lib/` + `hooks/` blind spot where no `useLingui()` is in scope
 * and the wrapping convention is easy to skip.
 *
 * The unit tier cannot prove these render in another language: the vitest config
 * aliases the Lingui macros to an English-passthrough shim, so a wrapped and an
 * unwrapped string are indistinguishable from a return value. What IS observable
 * is the extracted catalog, which only receives a string the extractor found
 * inside a macro. Unwrap one and it stops being extracted; `pnpm run i18n`
 * drops it and this file goes red — which is also what the drift gate
 * (`scripts/check-i18n-drift.sh`) forces to happen before a PR can land.
 *
 * Two complementary shapes:
 *
 *   1. Per-file origin counts, from the `.po`'s `#:` references. These reach
 *      messages produced inside a callback or an effect, which no test can
 *      invoke directly, so completeness does not stop at what is callable.
 *   2. Round-tripped message ids, from calling the helper with its own
 *      placeholder NAMES as argument values. The passthrough shim substitutes
 *      them verbatim, so the return value comes back equal to the id the
 *      extractor wrote — which pins the placeholder names too. Those names are
 *      the whole difference between a translatable string and `{0} … {2}`.
 *
 * Nothing here restates a literal: every expectation is either produced by the
 * helper or read off the catalog.
 */
const LOCALES_DIR = join(import.meta.dir, '..', 'locales', 'en');

/**
 * Every module this migration moved into the catalog, with how many distinct
 * messages it contributes. The count is the part with teeth — a bare "at least
 * one" would stay green after all but one string was unwrapped.
 */
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

/** Undo the PO escapes Lingui emits, so an id compares equal to the live string. */
function unescapePo(value: string): string {
  return value.replace(/\\(["\\ntr])/g, (_, ch: string) =>
    ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === 'r' ? '\r' : ch,
  );
}

// Read in a hook, not at module scope, so a missing or unparseable catalog
// surfaces as one clear failure rather than an opaque module-load error.
// The `.po` is the source of ids; the compiled JSON is keyed by content hash
// and splits interpolated messages into token arrays, so it cannot answer
// "is this exact id in the catalog".
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
  // Anti-vacuity: a parse that silently yielded nothing would pass every
  // `.has()` assertion below in the negative direction only — but a typo in the
  // regex would make every one of them fail identically and read as a code bug.
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
