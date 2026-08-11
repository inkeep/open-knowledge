/** Live client policy for whether unresolved-link decorations are visible. */

type Listener = () => void;

let enabled = true;
const listeners = new Set<Listener>();

export function isLinkValidationVisible(): boolean {
  return enabled;
}

export function setLinkValidationVisible(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  for (const listener of listeners) listener();
}

export function subscribeToLinkValidationPolicy(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetLinkValidationPolicyForTest(): void {
  enabled = true;
  listeners.clear();
}
