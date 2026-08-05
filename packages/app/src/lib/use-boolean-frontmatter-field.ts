/**
 * Live-read a boolean frontmatter flag off `Y.Text('source')`, re-reading as
 * the user edits frontmatter. Boolean sibling of `useFrontmatterField`
 * (string-only — it reads '' for a boolean).
 *
 * Strict identity: only the YAML boolean `true` yields `true`. The string
 * "true" and the number `1` yield `false`, so a coincidentally-truthy value
 * can't trip a gate this drives.
 *
 * The subscription lives in a `useEffect` so React tears it down on unmount and
 * when an enclosing `<Activity>` flips to hidden — a Y.js observer attached off
 * the effect lifecycle (a ref, a module singleton) would keep processing remote
 * updates for every hidden document (precedent #18(c)). The `useState`
 * initializer's one-shot binding is created, read, and disposed in the same
 * breath, so it leaves nothing attached.
 */

import type { HocuspocusProvider } from '@hocuspocus/provider';
import { bindFrontmatterDoc, type FrontmatterMap } from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';

function isFlagEnabled(map: FrontmatterMap, key: string): boolean {
  return map[key] === true;
}

export function useBooleanFrontmatterField(provider: HocuspocusProvider, key: string): boolean {
  const [enabled, setEnabled] = useState<boolean>(() => {
    const binding = bindFrontmatterDoc(provider);
    const initial = isFlagEnabled(binding.current().map, key);
    binding.dispose();
    return initial;
  });

  useEffect(() => {
    const binding = bindFrontmatterDoc(provider);
    setEnabled(isFlagEnabled(binding.current().map, key));
    const unsub = binding.subscribe((snapshot) => {
      setEnabled(isFlagEnabled(snapshot.map, key));
    });
    return () => {
      unsub();
      binding.dispose();
    };
  }, [provider, key]);

  return enabled;
}
