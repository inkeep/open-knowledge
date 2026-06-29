
import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from 'react';
import { mark } from './mark';

interface ProfilerBoundaryProps {
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
