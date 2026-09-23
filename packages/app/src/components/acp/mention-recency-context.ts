import { createContext } from 'react';
import type { MentionRecency } from '@/editor/composer-mention/composer-mention';

export const MentionRecencyContext = createContext<MentionRecency | null>(null);
