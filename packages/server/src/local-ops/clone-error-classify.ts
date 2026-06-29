import { redactShareSubprocessStderr } from '../share/publish.ts';

export interface CloneErrorClassification {
  title: string;
  detail: string;
}

const GENERIC_TITLE = 'Clone subprocess reported an error.';

const MAX_DETAIL_LEN = 500;

export function classifyCloneError(rawStderr: string): CloneErrorClassification {
  const detail = redactShareSubprocessStderr(rawStderr).trim().slice(0, MAX_DETAIL_LEN);

  if (detail.length === 0) {
    return { title: GENERIC_TITLE, detail: '' };
  }

  if (/repository not found|returned error:\s*404/i.test(detail)) {
    return {
      title: "Can't access this repository. It may be private, or you may not have access.",
      detail,
    };
  }

  if (/permission denied|access denied|returned error:\s*403/i.test(detail)) {
    return {
      title: "You don't have access to this repository.",
      detail,
    };
  }

  if (/authentication failed/i.test(detail)) {
    return {
      title: 'GitHub authentication failed. Try signing in again.',
      detail,
    };
  }

  return { title: GENERIC_TITLE, detail };
}
