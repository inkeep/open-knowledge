import type { TerminalCli } from '@inkeep/open-knowledge-core';
import type {
  ThreadAuthMethod,
  ThreadInfo,
  ThreadStatus,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { t } from '@lingui/core/macro';

export type ThreadAuthActionKind = 'resume' | 'retry' | 'new-chat' | 'terminal-sign-in';

export type ThreadAuthOfferWithoutSignIn =
  | {
      readonly kind: ThreadAuthActionKind;
      readonly headline: string;
      readonly actionLabel: string;
    }
  | { readonly kind: 'none'; readonly headline: string; readonly actionLabel: null };

export type ThreadAuthOffer =
  | ThreadAuthOfferWithoutSignIn
  | { readonly kind: 'sign-in'; readonly headline: string; readonly actionLabel: string };

export interface ThreadAuthOfferInput {
  readonly archived: boolean;
  readonly resumable: boolean;
  readonly status: ThreadStatus;
  readonly authMethods: readonly ThreadAuthMethod[];
  readonly agentName: string;
  readonly terminalCli: TerminalCli | null;
}

export function isThreadResumable(info: Pick<ThreadInfo, 'resumable'>): boolean {
  return info.resumable !== false;
}

function isClickable(method: ThreadAuthMethod): boolean {
  return method.kind !== 'terminal' && method.kind !== 'env_var';
}

export function clickableAuthMethods(
  methods: readonly ThreadAuthMethod[],
): readonly ThreadAuthMethod[] {
  return methods.filter(isClickable);
}

export function manualAuthMethods(
  methods: readonly ThreadAuthMethod[],
): readonly ThreadAuthMethod[] {
  return methods.filter((method) => !isClickable(method));
}

export function threadAuthHistoryOffer(agentName: string): ThreadAuthOfferWithoutSignIn {
  return {
    kind: 'none',
    headline: t`${agentName} needed you to sign in.`,
    actionLabel: null,
  };
}

function threadAuthNewChatOffer(agentName: string): ThreadAuthOfferWithoutSignIn {
  return {
    kind: 'new-chat',
    headline: t`${agentName} isn't running. Start a new chat to sign in.`,
    actionLabel: t`New chat with ${agentName}`,
  };
}

function threadAuthTerminalOffer(agentName: string): ThreadAuthOfferWithoutSignIn {
  return {
    kind: 'terminal-sign-in',
    headline: t`${agentName} needs you to sign in.`,
    actionLabel: t`Open terminal to sign in`,
  };
}

function threadAuthSignedOutOffer(
  agentName: string,
  terminalCli: TerminalCli | null,
): ThreadAuthOfferWithoutSignIn {
  if (terminalCli != null) return threadAuthTerminalOffer(agentName);
  return {
    kind: 'retry',
    headline: t`${agentName} needs you to sign in.`,
    actionLabel: t`Retry`,
  };
}

export function threadAuthOfferWithoutSignInMethods({
  archived,
  resumable,
  status,
  agentName,
  terminalCli,
}: Omit<ThreadAuthOfferInput, 'authMethods'>): ThreadAuthOfferWithoutSignIn {
  if (archived) {
    if (!resumable) {
      return threadAuthNewChatOffer(agentName);
    }
    return {
      kind: 'resume',
      headline: t`${agentName} needed you to sign in. Resume this chat to try again.`,
      actionLabel: t`Resume chat`,
    };
  }
  const history = threadAuthHistoryOffer(agentName);
  switch (status) {
    case 'auth_required':
    case 'authenticating':
      return threadAuthSignedOutOffer(agentName, terminalCli);
    case 'error':
      return {
        kind: 'retry',
        headline: t`${agentName} stopped with an error.`,
        actionLabel: t`Retry`,
      };
    case 'exited':
      return threadAuthNewChatOffer(agentName);
    case 'installing':
    case 'spawning':
    case 'ready':
    case 'running':
    case 'awaiting_permission':
      return history;
    default: {
      const exhaustive: never = status;
      void exhaustive;
      return history;
    }
  }
}

export function threadAuthOffer({
  authMethods,
  agentName,
  terminalCli,
}: Pick<ThreadAuthOfferInput, 'authMethods' | 'agentName' | 'terminalCli'>): ThreadAuthOffer {
  if (clickableAuthMethods(authMethods).length > 0) {
    return {
      kind: 'sign-in',
      headline: t`Sign in to ${agentName} to continue.`,
      actionLabel: t`Sign in`,
    };
  }
  if (manualAuthMethods(authMethods).length > 0) {
    if (terminalCli != null) return threadAuthTerminalOffer(agentName);
    return threadAuthHistoryOffer(agentName);
  }
  return threadAuthOfferWithoutSignInMethods({
    archived: false,
    resumable: true,
    status: 'auth_required',
    agentName,
    terminalCli,
  });
}
