import { createContext } from 'react';
import type { ReferenceRulesInput } from './reference-links';

export const ReferenceRulesContext = createContext<ReferenceRulesInput | null>(null);
