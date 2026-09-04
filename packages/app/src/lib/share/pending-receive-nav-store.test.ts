import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ResolvedNavigationTarget } from '@/components/navigation-targets';
import {
  createPendingReceiveNavStore,
  hashSelectsPendingNav,
  matchesShareReceiveMiss,
  type PendingReceiveNav,
  type PendingReceiveNavStore,
  pendingReceiveNavForContentPath,
} from './pending-receive-nav-store';

const DOC_NAV: PendingReceiveNav = { kind: 'doc', path: 'notes/plan', branch: 'feature' };

function missing(target: string): ResolvedNavigationTarget {
  return { kind: 'missing', target };
}
function doc(docName: string): ResolvedNavigationTarget {
  return { kind: 'doc', target: docName, docName };
}

describe('matchesShareReceiveMiss', () => {
  test('a missing target matching the armed pending nav is a share-receive miss', () => {
    expect(matchesShareReceiveMiss(missing('notes/plan'), DOC_NAV)).toEqual(DOC_NAV);
  });

  test('a missing target with no armed nav is not a share-receive miss', () => {
    expect(matchesShareReceiveMiss(missing('notes/plan'), null)).toBeNull();
  });

  test('a missing target whose path differs from the armed nav is not a miss', () => {
    expect(matchesShareReceiveMiss(missing('other/doc'), DOC_NAV)).toBeNull();
  });

  test('an extension-bearing armed nav matches its stripped missing target', () => {
    const mdNav: PendingReceiveNav = { kind: 'doc', path: 'docs/moved.md', branch: 'main' };
    expect(matchesShareReceiveMiss(missing('docs/moved'), mdNav)).toEqual(mdNav);
  });

  test('a present doc target is never a miss even while a nav is armed', () => {
    expect(matchesShareReceiveMiss(doc('notes/plan'), DOC_NAV)).toBeNull();
  });

  test('a null active target is not a miss', () => {
    expect(matchesShareReceiveMiss(null, DOC_NAV)).toBeNull();
  });
});

describe('pendingReceiveNavForContentPath', () => {
  test('keeps a v2 content-root folder repository path canonical', () => {
    expect(
      pendingReceiveNavForContentPath(
        {
          kind: 'folder',
          path: 'guides',
          repositoryPath: 'wiki/guides',
          contentRootDepth: 1,
          branch: 'main',
        },
        '',
      ),
    ).toMatchObject({ path: '', repositoryPath: 'wiki' });
  });
});

describe('hashSelectsPendingNav', () => {
  test('a doc hash still selects the armed doc (branch query ignored)', () => {
    expect(hashSelectsPendingNav('#/notes/plan?branch=feature', DOC_NAV)).toBe(true);
    expect(hashSelectsPendingNav('#/notes/plan', DOC_NAV)).toBe(true);
  });

  test('a different doc hash does not select the armed doc', () => {
    expect(hashSelectsPendingNav('#/other', DOC_NAV)).toBe(false);
  });

  test('a doc hash carrying a file extension still selects the armed extension-bearing nav', () => {
    const mdNav: PendingReceiveNav = { kind: 'doc', path: 'docs/moved.md', branch: 'main' };
    expect(hashSelectsPendingNav('#/docs%2Fmoved.md?branch=main', mdNav)).toBe(true);
    expect(
      hashSelectsPendingNav('#/notes%2Fplan.mdx', { ...DOC_NAV, path: 'notes/plan.mdx' }),
    ).toBe(true);
  });

  test('a folder hash selects the armed folder regardless of trailing slash', () => {
    const folderNav: PendingReceiveNav = { kind: 'folder', path: 'knowledge', branch: 'main' };
    expect(hashSelectsPendingNav('#/knowledge/', folderNav)).toBe(true);
    expect(hashSelectsPendingNav('#/', folderNav)).toBe(false);
  });

  test('the content-root sentinel selects an armed root-folder share', () => {
    const rootNav: PendingReceiveNav = { kind: 'folder', path: '', branch: 'main' };
    expect(hashSelectsPendingNav('#/', rootNav)).toBe(true);
    expect(hashSelectsPendingNav('#/somewhere', rootNav)).toBe(false);
  });
});

describe('pendingReceiveNavStore lifecycle', () => {
  let hashHandler: (() => void) | null = null;
  const stores: PendingReceiveNavStore[] = [];

  beforeEach(() => {
    hashHandler = null;
    const fakeWindow = {
      location: { hash: '' },
      addEventListener: (type: string, fn: () => void) => {
        if (type === 'hashchange') hashHandler = fn;
      },
      removeEventListener: (type: string, fn: () => void) => {
        if (type === 'hashchange' && hashHandler === fn) hashHandler = null;
      },
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  });

  afterEach(() => {
    for (const s of stores.splice(0)) s.dispose();
    Reflect.deleteProperty(globalThis, 'window');
  });

  function freshStore(): PendingReceiveNavStore {
    const s = createPendingReceiveNavStore();
    stores.push(s);
    return s;
  }
  function navigateTo(hash: string): void {
    (window as unknown as { location: { hash: string } }).location.hash = hash;
    hashHandler?.();
  }

  test('arm publishes the pending nav and notifies subscribers', () => {
    const store = freshStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.arm(DOC_NAV);
    expect(store.getSnapshot()).toEqual(DOC_NAV);
    expect(notifications).toBe(1);
  });

  test('navigating away from the armed target self-clears the pending nav', () => {
    const store = freshStore();
    navigateTo('#/notes/plan?branch=feature');
    store.arm(DOC_NAV);
    expect(store.getSnapshot()).toEqual(DOC_NAV);

    navigateTo('#/somewhere-else');
    expect(store.getSnapshot()).toBeNull();
  });

  test('a hashchange that stays on the armed target keeps the pending nav', () => {
    const store = freshStore();
    navigateTo('#/notes/plan');
    store.arm(DOC_NAV);

    navigateTo('#/notes/plan?branch=feature');
    expect(store.getSnapshot()).toEqual(DOC_NAV);
  });

  test('a share target with a file extension survives its own arming hashchange', () => {
    const store = freshStore();
    const mdNav: PendingReceiveNav = { kind: 'doc', path: 'docs/moved.md', branch: 'main' };
    store.arm(mdNav);
    navigateTo('#/docs%2Fmoved.md?branch=main');
    expect(store.getSnapshot()).toEqual(mdNav);
  });

  test('clear resets the pending nav', () => {
    const store = freshStore();
    store.arm(DOC_NAV);
    store.clear();
    expect(store.getSnapshot()).toBeNull();
  });
});
