import type { HocuspocusProvider } from '@hocuspocus/provider';
import { bindFrontmatterDoc } from '@inkeep/open-knowledge-core';
import { useEffect, useRef, useState } from 'react';

export interface FrontmatterFieldBinding {
  value: string;
  setValue: (next: string) => void;
  onFocus: () => void;
  onBlur: () => void;
}

function readField(binding: ReturnType<typeof bindFrontmatterDoc>, key: string): string {
  const value = binding.current().map[key];
  return typeof value === 'string' ? value : '';
}

export function useFrontmatterField(
  provider: HocuspocusProvider,
  key: string,
): FrontmatterFieldBinding {
  const [binding, setBinding] = useState<ReturnType<typeof bindFrontmatterDoc> | null>(null);
  const [value, setValue] = useState<string>(() => {
    const b = bindFrontmatterDoc(provider);
    const v = readField(b, key);
    b.dispose();
    return v;
  });
  const focusedRef = useRef(false);

  useEffect(() => {
    const b = bindFrontmatterDoc(provider);
    setBinding(b);
    setValue(readField(b, key));
    const unsub = b.subscribe(() => {
      if (!focusedRef.current) setValue(readField(b, key));
    });
    return () => {
      unsub();
      b.dispose();
      setBinding((prev) => (prev === b ? null : prev));
    };
  }, [provider, key]);

  return {
    value,
    setValue,
    onFocus: () => {
      focusedRef.current = true;
    },
    onBlur: () => {
      focusedRef.current = false;
      if (binding && value !== readField(binding, key)) {
        binding.patch({ [key]: value });
      }
    },
  };
}
