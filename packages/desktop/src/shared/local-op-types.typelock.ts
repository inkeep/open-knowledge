import type {
  AuthEvent,
  AuthReposResponse,
  AuthStatusResponse,
  RawCloneEvent,
} from '@inkeep/open-knowledge-server';
import type {
  OkLocalOpAuthEvent,
  OkLocalOpAuthReposResponse,
  OkLocalOpAuthStatusResponse,
  OkLocalOpCloneEvent,
} from './bridge-contract.ts';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type AssignableTo<A, B> = [A] extends [B] ? true : false;
type WithoutGhAvailable<T> = T extends unknown ? Omit<T, 'ghAvailable'> : never;

export type PinAuthEventIdenticalToBridge = Expect<Equal<AuthEvent, OkLocalOpAuthEvent>>;

export type PinCloneEventIdenticalToBridge = Expect<Equal<RawCloneEvent, OkLocalOpCloneEvent>>;

export type PinAuthReposResponseIdenticalToBridge = Expect<
  Equal<AuthReposResponse, OkLocalOpAuthReposResponse>
>;

export type PinAuthStatusResponseAssignableToBridge = Expect<
  AssignableTo<AuthStatusResponse, OkLocalOpAuthStatusResponse>
>;

export type PinAuthStatusResponseWidenedOnlyByGhAvailable = Expect<
  Equal<AuthStatusResponse, WithoutGhAvailable<OkLocalOpAuthStatusResponse>>
>;
