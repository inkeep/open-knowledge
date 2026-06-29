
import { hashFromDocName } from '@/lib/doc-hash';

interface SeedInitialDocHashOptions {
  readonly initialDoc: string | null | undefined;
  readonly getHash: () => string;
  readonly setHash: (hash: string) => void;
}

export function seedInitialDocHash(opts: SeedInitialDocHashOptions): void {
  const { initialDoc } = opts;
  if (!initialDoc) return;
  const hash = opts.getHash();
  if (hash !== '' && hash !== '#' && hash !== '#/') return;
  opts.setHash(hashFromDocName(initialDoc));
}

export function seedInitialDocHashFromWindow(): void {
  if (typeof window === 'undefined' || !window.okDesktop) return;
  seedInitialDocHash({
    initialDoc: window.okDesktop.config.initialDoc,
    getHash: () => window.location.hash,
    setHash: (hash) => {
      window.location.hash = hash;
    },
  });
}
