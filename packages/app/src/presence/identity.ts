import {
  type AwarenessState,
  type AwarenessUser,
  getIdentity,
  type Identity,
} from '@inkeep/open-knowledge-core';
import { useState } from 'react';

export type { AwarenessState, AwarenessUser };


export function useIdentity(): Identity {
  const [identity] = useState(getIdentity);
  return identity;
}
