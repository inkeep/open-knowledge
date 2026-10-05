import type { AwarenessState, AwarenessUser } from '@inkeep/open-knowledge-core/types/awareness';
import type { Identity } from '@inkeep/open-knowledge-core/types/identity';
import { getIdentity } from '@inkeep/open-knowledge-core/utils/identity';
import { useState } from 'react';

export type { AwarenessState, AwarenessUser };

export function useIdentity(): Identity {
  const [identity] = useState(getIdentity);
  return identity;
}
