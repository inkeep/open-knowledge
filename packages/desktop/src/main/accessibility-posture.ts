export type AccessibilityFeatureReader = (() => string[]) | undefined;

export interface AccessibilityPostureInput {
  phase: 'boot' | 'changed';
  supportEnabled: boolean;
  features: string[] | null;
  forcedByEnv: boolean;
}

export function resolveAccessibilityFeatures(
  read: AccessibilityFeatureReader,
  onError: (error: unknown) => void,
): string[] | null {
  if (read === undefined) return null;
  try {
    return read();
  } catch (error) {
    onError(error);
    return null;
  }
}

export function accessibilityPostureFacts(
  input: AccessibilityPostureInput,
): Record<string, unknown> {
  return {
    event: 'desktop.accessibility',
    phase: input.phase,
    supportEnabled: input.supportEnabled,
    ...(input.features !== null ? { features: input.features } : {}),
    forcedByEnv: input.forcedByEnv,
  };
}
