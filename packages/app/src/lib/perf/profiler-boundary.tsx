/**
 * `<ProfilerBoundary name="...">` — wraps React's `<Profiler>` and routes
 * `onRender(id, phase, actualDuration, baseDuration, startTime, commitTime)`
 * through `mark('ok/render/<name>', ...)`.
 *
 * Render data flows through the same pipeline as transition marks — one
 * JSON shape in the collector, one DevTools track group.
 *
 * React's `<Profiler>` is a no-op in production React builds, so this
 * component is production-safe. No gating needed.
 */

import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from 'react';
import { mark } from './mark';

interface ProfilerBoundaryProps {
  /** Short kebab-case identifier; becomes `ok/render/<name>`. */
  name: string;
  children: ReactNode;
}

export function ProfilerBoundary({ name, children }: ProfilerBoundaryProps) {
  return (
    <Profiler id={name} onRender={handleRender}>
      {children}
    </Profiler>
  );
}

const handleRender: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  baseDuration,
  startTime,
  commitTime,
) => {
  mark(
    `ok/render/${id}`,
    {
      phase,
      actualDuration: Math.round(actualDuration * 1000) / 1000,
      baseDuration: Math.round(baseDuration * 1000) / 1000,
    },
    {
      startTime,
      duration: Math.max(0, commitTime - startTime),
    },
  );
};
