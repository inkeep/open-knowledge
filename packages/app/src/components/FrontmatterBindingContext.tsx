import type { FrontmatterBinding } from '@inkeep/open-knowledge-core';
import { createContext, type ReactNode, use } from 'react';

const FrontmatterBindingContext = createContext<FrontmatterBinding | null>(null);

interface ProviderProps {
  binding: FrontmatterBinding | null;
  children: ReactNode;
}

export function FrontmatterBindingProvider({ binding, children }: ProviderProps) {
  return <FrontmatterBindingContext value={binding}>{children}</FrontmatterBindingContext>;
}

export function useFrontmatterBinding(): FrontmatterBinding | null {
  return use(FrontmatterBindingContext);
}
