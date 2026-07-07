import {
  type AwarenessState,
  type AwarenessUser,
  getIdentity,
  type Identity,
} from '@inkeep/open-knowledge-core';
import { useState } from 'react';

// Re-export types for backwards compatibility
export type { AwarenessState, AwarenessUser };

// --- React hook ---

export function useIdentity(): Identity {
  // Lazy initializer — identity is derived once per component mount (stable per tab).
  // useState(() => ...) runs the initializer once and caches it for the component lifetime.
  const [identity] = useState(getIdentity);
  return identity;
}
