import { Trans } from '@lingui/react/macro';
import { AlertTriangle } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

interface MermaidProps {
  chart?: string;
}

interface RenderState {
  status: 'idle' | 'rendering' | 'ready' | 'error';
  svg: string;
  error: string;
}

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;
function loadMermaid() {
  mermaidPromise ||= import('mermaid')
    .then((mod) => {
      const m = mod.default;
      m.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'default',
        suppressErrorRendering: true,
      });
      return m;
    })
    .catch((err) => {
      mermaidPromise = null;
      throw err;
    });
  return mermaidPromise;
}

export function MermaidView(props: MermaidProps) {
  const chart = props.chart ?? '';
  const reactId = useId();
  const renderId = `mermaid-${reactId.replace(/:/g, '_')}`;
  const [state, setState] = useState<RenderState>({ status: 'idle', svg: '', error: '' });

  useEffect(() => {
    if (!chart.trim()) {
      setState({ status: 'idle', svg: '', error: '' });
      return;
    }
    let cancelled = false;
    setState((prev) => ({ ...prev, status: 'rendering' }));
    loadMermaid()
      .then(async (m) => {
        try {
          const result = await m.render(renderId, chart);
          if (!cancelled) {
            setState({ status: 'ready', svg: result.svg, error: '' });
          }
        } catch (err) {
          if (!cancelled) {
            const msg = err instanceof Error ? err.message : String(err);
            setState({ status: 'error', svg: '', error: msg });
          }
        }
      })
      .catch((err) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setState({ status: 'error', svg: '', error: msg });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chart, renderId]);

  if (!chart.trim()) {
    return (
      <div className="mermaid mermaid-placeholder" data-component-type="mermaid">
        <span className="mermaid-empty"> </span>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="mermaid mermaid-error" data-component-type="mermaid" title={state.error}>
        <div
          role="alert"
          className="mermaid-error-message mb-2 flex items-start gap-2 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive"
        >
          <AlertTriangle className="size-3.5 shrink-0 mt-0.5" aria-hidden />
          <div className="min-w-0">
            <div className="font-medium">
              <Trans>Mermaid diagram failed to render.</Trans>
            </div>
            <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] opacity-90">
              {state.error}
            </pre>
          </div>
        </div>
        {/* The chart source shows WHAT the author wrote so they can locate
            the offending line/column the parser message refers to. */}
        <pre className="mermaid-error-source">{chart}</pre>
      </div>
    );
  }

  return (
    <div
      className={`mermaid mermaid-${state.status}`}
      data-component-type="mermaid"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid.render with securityLevel:'strict' returns a sanitized SVG string with no script execution; this is the documented integration path.
      dangerouslySetInnerHTML={{ __html: state.svg }}
    />
  );
}
