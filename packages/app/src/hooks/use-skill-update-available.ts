import type { SkillScope } from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';
import { reimportSkill } from '@/lib/skills-api';

export function useSkillUpdateAvailable(
  scope: SkillScope,
  name: string,
  enabled: boolean,
): { available: boolean; gitTracked: boolean; recheck: () => void } {
  const [available, setAvailable] = useState(false);
  const [gitTracked, setGitTracked] = useState(false);
  const [nonce, setNonce] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run trigger is the only purpose of nonce
  useEffect(() => {
    if (!enabled) {
      setAvailable(false);
      return;
    }
    let cancelled = false;
    void reimportSkill({ scope, name, dryRun: true }).then((result) => {
      if (cancelled) return;
      setAvailable(result.ok && result.updated === true);
      setGitTracked(result.ok && result.gitTracked === true);
    });
    return () => {
      cancelled = true;
    };
  }, [scope, name, enabled, nonce]);

  return { available, gitTracked, recheck: () => setNonce((n) => n + 1) };
}
