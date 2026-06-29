export interface DeviceVerificationEvent {
  type: 'verification';
  user_code: string;
  verification_uri: string;
  expires_in: number;
}

export interface DeviceCompleteEvent {
  type: 'complete';
  host: string;
  login: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
}

export interface DeviceErrorEvent {
  type: 'error';
  message: string;
}

export type AuthEvent = DeviceVerificationEvent | DeviceCompleteEvent | DeviceErrorEvent;

type ClonePhase = 'receiving' | 'resolving' | 'checking' | 'init' | 'done' | string;

export interface CloneProgressEvent {
  type: 'progress';
  phase: ClonePhase;
  pct: number;
}

export interface CloneCompleteEvent {
  type: 'complete';
  port: number;
  /** Absolute, tilde-expanded path to the cloned repo. Always populated by
   *  the HTTP relay (it intercepts the CLI's `complete` to chain into
   *  `startServerAtDirAndGetPort` before forwarding). */
  dir: string;
}

export interface CloneErrorEvent {
  type: 'error';
  message: string;
}

export type CloneEvent = CloneProgressEvent | CloneCompleteEvent | CloneErrorEvent;
