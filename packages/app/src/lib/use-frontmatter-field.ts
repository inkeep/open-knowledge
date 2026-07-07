/**
 * Bind a single frontmatter string field to a managed-artifact CRDT doc via
 * `bindFrontmatterDoc` (the same mechanism the document `PropertyPanel` uses).
 * Shared by the skill + template property panels so a `description` / `title`
 * edit is a CRDT mutation of the `.md` YAML region — not a side-channel PUT.
 *
 * Controlled-input contract: local state mirrors the bound value for a
 * responsive field; we patch the CRDT on blur (so a half-typed value doesn't
 * churn the doc on every keystroke) and re-seed from remote changes unless the
 * field is focused (don't stomp the user's in-progress edit).
 */

import type { HocuspocusProvider } from '@hocuspocus/provider';
import { bindFrontmatterDoc } from '@inkeep/open-knowledge-core';
import { useEffect, useRef, useState } from 'react';

export interface FrontmatterFieldBinding {
  value: string;
  /** Update local state (does not write the CRDT). */
  setValue: (next: string) => void;
  onFocus: () => void;
  /** Commit the current value to the CRDT YAML region (call on blur). */
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
