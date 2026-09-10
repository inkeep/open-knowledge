import type {
  ThreadAuthMethod,
  ThreadStatus,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { describe, expect, test } from 'vitest';
import {
  clickableAuthMethods,
  isThreadResumable,
  manualAuthMethods,
  type ThreadAuthOffer,
  threadAuthOffer,
  threadAuthOfferWithoutSignInMethods,
} from './thread-auth-offer';

const CLICKABLE: readonly ThreadAuthMethod[] = [{ id: 'oauth', name: 'OAuth' }];
const MANUAL_ONLY: readonly ThreadAuthMethod[] = [{ id: 'cli', name: 'CLI', kind: 'terminal' }];

const STATUSES: readonly ThreadStatus[] = [
  'installing',
  'spawning',
  'ready',
  'auth_required',
  'authenticating',
  'running',
  'awaiting_permission',
  'exited',
  'error',
];

const SIGN_IN_INSTRUCTION = /Sign in to .+ to continue/;

const METHOD_SETS: readonly (readonly ThreadAuthMethod[])[] = [[], CLICKABLE, MANUAL_ONLY];

function everyOffer(): {
  input: { clickableMethodCount: number; manualMethodCount: number };
  offer: ThreadAuthOffer;
}[] {
  return METHOD_SETS.map((authMethods) => ({
    input: {
      clickableMethodCount: clickableAuthMethods(authMethods).length,
      manualMethodCount: manualAuthMethods(authMethods).length,
    },
    offer: threadAuthOffer({ authMethods, agentName: 'Claude', terminalCli: null }),
  }));
}

describe('clickableAuthMethods', () => {
  const methods: readonly ThreadAuthMethod[] = [
    { id: 'oauth', name: 'OAuth' },
    { id: 'browser', name: 'Browser', kind: 'oauth' },
    { id: 'cli', name: 'CLI', kind: 'terminal' },
    { id: 'key', name: 'API key', kind: 'env_var' },
  ];

  test('keeps the methods a button can trigger', () => {
    expect(clickableAuthMethods(methods).map((m) => m.id)).toEqual(['oauth', 'browser']);
  });

  test('manual methods are the exact complement', () => {
    expect(manualAuthMethods(methods).map((m) => m.id)).toEqual(['cli', 'key']);
    expect(clickableAuthMethods(methods).length + manualAuthMethods(methods).length).toBe(
      methods.length,
    );
  });

  test('an empty method list yields no offers on either side', () => {
    expect(clickableAuthMethods([])).toEqual([]);
    expect(manualAuthMethods([])).toEqual([]);
  });
});

describe('threadAuthOffer', () => {
  test('sign-in is offered exactly where a method is there to click', () => {
    for (const { input, offer } of everyOffer()) {
      expect({ ...input, signsIn: offer.kind === 'sign-in' }).toEqual({
        ...input,
        signsIn: input.clickableMethodCount > 0,
      });
    }
  });

  test('only the sign-in offer says to sign in to continue', () => {
    for (const { input, offer } of everyOffer()) {
      if (offer.kind === 'sign-in') continue;
      expect({ ...input, claimsSignIn: SIGN_IN_INSTRUCTION.test(offer.headline) }).toEqual({
        ...input,
        claimsSignIn: false,
      });
    }
  });

  test('every offer reads as a complete instruction, label included', () => {
    for (const { input, offer } of everyOffer()) {
      expect({
        ...input,
        headlineEmpty: offer.headline.trim() === '',
        labelEmpty: offer.actionLabel !== null && offer.actionLabel.trim() === '',
      }).toEqual({ ...input, headlineEmpty: false, labelEmpty: false });
    }
  });

  test('a live thread awaiting sign-in with no method at all offers retry', () => {
    const offer = threadAuthOffer({ authMethods: [], agentName: 'Claude', terminalCli: null });
    expect(offer.kind).toBe('retry');
    expect(offer.headline).toBe('Claude needs you to sign in.');
  });

  test('a manual-only list gains a terminal action once the harness CLI is detected', () => {
    const offer = threadAuthOffer({
      authMethods: MANUAL_ONLY,
      agentName: 'Claude',
      terminalCli: 'claude',
    });
    expect(offer.kind).toBe('terminal-sign-in');
    expect(offer.actionLabel).toBe('Open terminal to sign in');
  });

  test('an absent terminalCli never enables the terminal offer', () => {
    const offer = threadAuthOffer({
      authMethods: [],
      agentName: 'Claude',
    } as unknown as Parameters<typeof threadAuthOffer>[0]);
    expect(offer.kind).toBe('retry');
  });

  test('a method the user runs elsewhere lets the method list say how, not the headline', () => {
    const offer = threadAuthOffer({
      authMethods: MANUAL_ONLY,
      agentName: 'Claude',
      terminalCli: null,
    });
    expect(offer.kind).toBe('none');
    expect(offer.headline).toBe('Claude needed you to sign in.');
    expect(offer.actionLabel).toBeNull();
  });

  test('a live thread awaiting sign-in with a clickable method keeps the sign-in copy', () => {
    const offer = threadAuthOffer({
      authMethods: CLICKABLE,
      agentName: 'Claude',
      terminalCli: null,
    });
    expect(offer.kind).toBe('sign-in');
    expect(offer.headline).toBe('Sign in to Claude to continue.');
  });
});

describe('threadAuthOfferWithoutSignInMethods', () => {
  test('an archived thread offers resume and names it', () => {
    const offer = threadAuthOfferWithoutSignInMethods({
      archived: true,
      resumable: true,
      status: 'exited',
      agentName: 'Claude',
      terminalCli: null,
    });
    expect(offer.kind).toBe('resume');
    expect(offer.headline).toBe('Claude needed you to sign in. Resume this chat to try again.');
    expect(offer.actionLabel).toBe('Resume chat');
  });

  test('an archived thread the server cannot resume offers the new chat up front', () => {
    const offer = threadAuthOfferWithoutSignInMethods({
      archived: true,
      resumable: false,
      status: 'exited',
      agentName: 'Claude',
      terminalCli: null,
    });
    expect(offer.kind).toBe('new-chat');
    expect(offer.headline).toBe("Claude isn't running. Start a new chat to sign in.");
    expect(offer.actionLabel).toBe('New chat with Claude');
  });

  test('an unresumable archived thread never names a resume, whatever its status', () => {
    for (const status of STATUSES) {
      const offer = threadAuthOfferWithoutSignInMethods({
        archived: true,
        resumable: false,
        status,
        agentName: 'Claude',
        terminalCli: null,
      });
      expect({
        status,
        kind: offer.kind,
        actionLabel: offer.actionLabel,
        namesResume: /Resume/.test(offer.headline),
      }).toEqual({
        status,
        kind: 'new-chat',
        actionLabel: 'New chat with Claude',
        namesResume: false,
      });
    }
  });

  test('a server that reports no resumability at all keeps the resume on offer', () => {
    for (const status of STATUSES) {
      const offer = threadAuthOfferWithoutSignInMethods({
        archived: true,
        resumable: isThreadResumable({}),
        status,
        agentName: 'Claude',
        terminalCli: null,
      });
      expect({ status, kind: offer.kind }).toEqual({ status, kind: 'resume' });
    }
  });

  test('resumability is absent-means-yes, and only an explicit false retires the resume', () => {
    expect(isThreadResumable({})).toBe(true);
    expect(isThreadResumable({ resumable: undefined })).toBe(true);
    expect(isThreadResumable({ resumable: true })).toBe(true);
    expect(isThreadResumable({ resumable: false })).toBe(false);
  });

  test('an archived thread offers the resume only while resuming is still on the table', () => {
    for (const status of STATUSES) {
      for (const resumable of [false, true]) {
        const offer = threadAuthOfferWithoutSignInMethods({
          archived: true,
          resumable,
          status,
          agentName: 'Claude',
          terminalCli: null,
        });
        expect({ status, resumable, kind: offer.kind }).toEqual({
          status,
          resumable,
          kind: resumable ? 'resume' : 'new-chat',
        });
      }
    }
  });

  test('an exited thread offers a new chat, the only action its status permits', () => {
    const offer = threadAuthOfferWithoutSignInMethods({
      archived: false,
      resumable: true,
      status: 'exited',
      agentName: 'Claude',
      terminalCli: null,
    });
    expect(offer.kind).toBe('new-chat');
    expect(offer.headline).toBe("Claude isn't running. Start a new chat to sign in.");
    expect(offer.actionLabel).toBe('New chat with Claude');
  });

  test('a live thread stalled on sign-in states the fact and offers retry', () => {
    for (const status of ['auth_required', 'authenticating'] as const) {
      const offer = threadAuthOfferWithoutSignInMethods({
        archived: false,
        resumable: true,
        status,
        agentName: 'Claude',
        terminalCli: null,
      });
      expect({ status, kind: offer.kind, actionLabel: offer.actionLabel }).toEqual({
        status,
        kind: 'retry',
        actionLabel: 'Retry',
      });
      expect(offer.headline).toBe('Claude needs you to sign in.');
    }
  });

  test('an errored thread names the error, not a sign-in the retry cannot perform', () => {
    const offer = threadAuthOfferWithoutSignInMethods({
      archived: false,
      resumable: true,
      status: 'error',
      agentName: 'Claude',
      terminalCli: null,
    });
    expect({ kind: offer.kind, actionLabel: offer.actionLabel }).toEqual({
      kind: 'retry',
      actionLabel: 'Retry',
    });
    expect(offer.headline).toBe('Claude stopped with an error.');
  });

  test('no retry headline ever claims the retry is what signs you in', () => {
    for (const status of STATUSES) {
      for (const terminalCli of [null, 'claude'] as const) {
        const offer = threadAuthOfferWithoutSignInMethods({
          archived: false,
          resumable: true,
          status,
          agentName: 'Claude',
          terminalCli,
        });
        if (offer.kind !== 'retry') continue;
        expect({
          status,
          terminalCli,
          claimsSignIn: /Retry to sign in/.test(offer.headline),
        }).toEqual({ status, terminalCli, claimsSignIn: false });
      }
    }
  });

  test('a detected harness CLI turns the sign-in into an action the card can perform', () => {
    for (const status of ['auth_required', 'authenticating'] as const) {
      const offer = threadAuthOfferWithoutSignInMethods({
        archived: false,
        resumable: true,
        status,
        agentName: 'Claude',
        terminalCli: 'claude',
      });
      expect({ status, kind: offer.kind, actionLabel: offer.actionLabel }).toEqual({
        status,
        kind: 'terminal-sign-in',
        actionLabel: 'Open terminal to sign in',
      });
    }
  });

  test('a detected harness CLI does not rewrite the archived or errored offers', () => {
    const archived = threadAuthOfferWithoutSignInMethods({
      archived: true,
      resumable: true,
      status: 'exited',
      agentName: 'Claude',
      terminalCli: 'claude',
    });
    expect(archived.kind).toBe('resume');
    const errored = threadAuthOfferWithoutSignInMethods({
      archived: false,
      resumable: true,
      status: 'error',
      agentName: 'Claude',
      terminalCli: 'claude',
    });
    expect(errored.kind).toBe('retry');
  });

  test('a healthy thread reads the notice as history and owes no control', () => {
    for (const status of ['installing', 'spawning', 'ready', 'running', 'awaiting_permission']) {
      const offer = threadAuthOfferWithoutSignInMethods({
        archived: false,
        resumable: true,
        status: status as ThreadStatus,
        agentName: 'Claude',
        terminalCli: null,
      });
      expect({ status, kind: offer.kind, actionLabel: offer.actionLabel }).toEqual({
        status,
        kind: 'none',
        actionLabel: null,
      });
      expect(offer.headline).toBe('Claude needed you to sign in.');
    }
  });

  test('a surface that renders no sign-in buttons can never be handed the sign-in copy', () => {
    for (const status of STATUSES) {
      for (const archived of [false, true]) {
        for (const resumable of [false, true]) {
          const offer = threadAuthOfferWithoutSignInMethods({
            archived,
            resumable,
            status,
            agentName: 'Claude',
            terminalCli: null,
          });
          expect({
            status,
            archived,
            resumable,
            claimsSignIn: SIGN_IN_INSTRUCTION.test(offer.headline),
            labelPaired: offer.actionLabel !== null || offer.kind === 'none',
          }).toEqual({
            status,
            archived,
            resumable,
            claimsSignIn: false,
            labelPaired: true,
          });
        }
      }
    }
  });
});
