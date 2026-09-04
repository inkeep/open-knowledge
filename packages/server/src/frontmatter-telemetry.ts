import type { Counter } from '@opentelemetry/api';
import { getMeter } from './telemetry.ts';

type FrontmatterEditSource = 'source-mode' | 'mcp-write' | 'file-watcher';

let _editSurfaceCounter: Counter | null = null;
function editSurfaceCounter(): Counter {
  _editSurfaceCounter ||= getMeter().createCounter('ok.frontmatter.edit_surface_total', {
    description:
      'Count of frontmatter edits by surface. Bounded label: source ∈ {source-mode, mcp-write, file-watcher}.',
  });
  return _editSurfaceCounter;
}

export function recordFrontmatterEditSurface(source: FrontmatterEditSource): void {
  editSurfaceCounter().add(1, { source });
}

export function __resetFrontmatterTelemetryForTests(): void {
  _editSurfaceCounter = null;
}
