import { createContext, type ReactNode, use, useState } from 'react';

interface PropertyContextValue {
  addPropertySignal: ReadonlyMap<string, number>;
  requestAddProperty: (docName: string) => void;
  clearAddProperty: (docName: string) => void;
}

const PropertyContext = createContext<PropertyContextValue | null>(null);

export function PropertyProvider({ children }: { children: ReactNode }) {
  const [addPropertySignal, setAddPropertySignal] = useState<Map<string, number>>(() => new Map());

  const requestAddProperty = (docName: string) => {
    setAddPropertySignal((prev) => {
      const next = new Map(prev);
      next.set(docName, (prev.get(docName) ?? 0) + 1);
      return next;
    });
  };

  const clearAddProperty = (docName: string) => {
    setAddPropertySignal((prev) => {
      if (!prev.has(docName)) return prev;
      const next = new Map(prev);
      next.delete(docName);
      return next;
    });
  };

  const value: PropertyContextValue = {
    addPropertySignal,
    requestAddProperty,
    clearAddProperty,
  };

  return <PropertyContext value={value}>{children}</PropertyContext>;
}

export function useProperties(): PropertyContextValue {
  const ctx = use(PropertyContext);
  if (ctx === null) {
    throw new Error('useProperties must be used within <PropertyProvider />');
  }
  return ctx;
}
